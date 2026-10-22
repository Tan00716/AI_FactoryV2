/**
 * Postgres wire-driver tests against an in-process protocol stub.
 * The stub speaks just enough of the PG protocol (startup, auth-ok,
 * simple query) to prove the client frames/parses correctly. This is
 * NOT a live server test — there is no postgres in this environment,
 * and the driver header says so.
 * Run: node --test packages/dbbrowser/dist/tests/pg-stub.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { PostgresDriver, PgAuthRequiredError, PgProtocolError } from '../src/index.js';

function msg(type: string, body: Buffer): Buffer {
  const h = Buffer.alloc(5);
  h[0] = type.charCodeAt(0);
  h.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([h, body]);
}
function cstr(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}
function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}

interface StubOpts {
  auth?: 'ok' | 'md5' | 'error';
  rows?: Array<Array<string | null>>;
  columns?: string[];
  commandTag?: string;
  errorMessage?: string;
}

/** Minimal stub: reads startup + one Query, answers canned frames. */
function startStub(opts: StubOpts): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      // The client destroys its socket on close(); a reset here is expected.
      sock.on('error', () => {});
      let buf = Buffer.alloc(0);
      let started = false;
      sock.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (!started) {
          if (buf.length < 4) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          buf = buf.subarray(len);
          started = true;
          if (opts.auth === 'md5') {
            sock.write(msg('R', int32(5))); // AuthenticationMD5Password
            return;
          }
          if (opts.auth === 'error') {
            const body = Buffer.concat([Buffer.from('M'), cstr(opts.errorMessage ?? 'stub refused'), Buffer.from([0])]);
            sock.write(msg('E', body));
            return;
          }
          sock.write(msg('R', int32(0))); // AuthenticationOk
          sock.write(msg('S', Buffer.concat([cstr('server_version'), cstr('16-stub')])));
          sock.write(msg('K', Buffer.concat([int32(1), int32(2)])));
          sock.write(msg('Z', Buffer.from('I')));
          return;
        }
        // Frontend message: 1-byte type + len.
        if (buf.length < 5) return;
        const type = String.fromCharCode(buf[0]!);
        const len = buf.readInt32BE(1);
        if (buf.length < 1 + len) return;
        buf = buf.subarray(1 + len);
        if (type === 'Q') {
          if (opts.errorMessage && opts.auth !== 'error') {
            const body = Buffer.concat([Buffer.from('M'), cstr(opts.errorMessage), Buffer.from([0])]);
            sock.write(msg('E', body));
          } else {
            const cols = opts.columns ?? ['id', 'name'];
            const desc = Buffer.concat([
              (() => {
                const b = Buffer.alloc(2);
                b.writeInt16BE(cols.length, 0);
                return b;
              })(),
              ...cols.flatMap((c) => [cstr(c), int32(0), Buffer.from([0, 0]), int32(25), Buffer.from([0, 0]), int32(0), Buffer.from([0, 0])]),
            ]);
            sock.write(msg('T', desc));
            for (const row of opts.rows ?? [['1', 'alice']]) {
              const cells = row.flatMap((v) => {
                if (v === null) return [int32(-1)];
                const b = Buffer.from(v, 'utf8');
                return [int32(b.length), b];
              });
              const count = Buffer.alloc(2);
              count.writeInt16BE(row.length, 0);
              sock.write(msg('D', Buffer.concat([count, ...cells])));
            }
            sock.write(msg('C', cstr(opts.commandTag ?? `SELECT ${opts.rows?.length ?? 1}`)));
          }
          sock.write(msg('Z', Buffer.from('I')));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((res) => server.close(() => res()));
}

test('simple query returns text rows and columns', async () => {
  const { server, port } = await startStub({ rows: [['1', 'alice'], ['2', null]] });
  const d = new PostgresDriver('pg', { host: '127.0.0.1', port, user: 'u', database: 'db' });
  try {
    const r = await d.query('SELECT id, name FROM t');
    assert.deepEqual(r.columns, ['id', 'name']);
    assert.deepEqual(r.rows, [
      { id: '1', name: 'alice' },
      { id: '2', name: null },
    ]);
    assert.equal(r.rowCount, 2);
  } finally {
    await d.close();
    await close(server);
  }
});

test('password-demanding server is refused loudly (trust auth only)', async () => {
  const { server, port } = await startStub({ auth: 'md5' });
  const d = new PostgresDriver('pg', { host: '127.0.0.1', port, user: 'u', database: 'db' });
  try {
    await assert.rejects(() => d.query('SELECT 1'), PgAuthRequiredError);
  } finally {
    await d.close();
    await close(server);
  }
});

test('ErrorResponse becomes PgProtocolError', async () => {
  const { server, port } = await startStub({ errorMessage: 'relation "nope" does not exist' });
  const d = new PostgresDriver('pg', { host: '127.0.0.1', port, user: 'u', database: 'db' });
  try {
    await assert.rejects(() => d.query('SELECT * FROM nope'), (e: unknown) => {
      assert.ok(e instanceof PgProtocolError);
      assert.match((e as Error).message, /relation "nope" does not exist/);
      return true;
    });
  } finally {
    await d.close();
    await close(server);
  }
});

test('command tag changes are surfaced for DDL/DML', async () => {
  const { server, port } = await startStub({ rows: [], columns: [], commandTag: 'UPDATE 7' });
  const d = new PostgresDriver('pg', { host: '127.0.0.1', port, user: 'u', database: 'db' });
  try {
    const r = await d.exec('UPDATE t SET a=1');
    assert.equal(r.changes, 7);
  } finally {
    await d.close();
    await close(server);
  }
});

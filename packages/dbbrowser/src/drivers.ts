/**
 * Driver implementations for the DB browser.
 *
 * SqliteDriver: node:sqlite (DatabaseSync). Fully supported.
 *
 * PostgresDriver: a minimal, hand-rolled PostgreSQL wire-protocol client
 * (startup + simple-query only, trust auth, no SSL, no prepared
 * statements, no passwords). It exists so the browser can talk to a
 * Postgres server without pulling in an npm driver; it is verified
 * against an in-process protocol stub (see tests), NOT a live server.
 * Values arrive as text (simple-query protocol has no type OIDs surfaced
 * here — said honestly).
 */

import { DatabaseSync } from 'node:sqlite';
import { createConnection, type Socket } from 'node:net';
import type { DbDriver, QueryResult } from './types.js';

export const DBBROWSER_MAX_ROWS = 500;

function jsonSafe(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return typeof v === 'bigint' ? v.toString() : v;
  }
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return String(v);
}

export class SqliteDriver implements DbDriver {
  readonly kind = 'sqlite' as const;
  private db: DatabaseSync | null = null;
  constructor(
    readonly name: string,
    private readonly filePath: string,
    private readonly readOnly: boolean = false,
  ) {}

  private open(): DatabaseSync {
    if (!this.db) {
      this.db = new DatabaseSync(this.filePath, { readOnly: this.readOnly, open: true });
    }
    return this.db;
  }

  private bind(params: unknown[]): Array<string | number | bigint | null | Uint8Array> {
    return params.map((p) => {
      // node:sqlite binds null|number|bigint|string|Uint8Array — booleans
      // become 0/1 explicitly, never coerced silently elsewhere.
      if (typeof p === 'boolean') return p ? 1 : 0;
      if (p instanceof Uint8Array) return p;
      return p === null || typeof p === 'string' || typeof p === 'number' || typeof p === 'bigint'
        ? p
        : String(p);
    });
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const t0 = Date.now();
    const stmt = this.open().prepare(sql);
    const bindable = this.bind(params);
    let rows: Array<Record<string, unknown>>;
    let changes: number | undefined;
    try {
      if (/^\s*(insert|update|delete|replace|create|alter|drop)\b/i.test(sql)) {
        const r = stmt.run(...bindable);
        changes = Number(r.changes);
        rows = [];
      } else {
        rows = stmt.all(...bindable) as Array<Record<string, unknown>>;
      }
    } finally {
      // StatementSync has no explicit close in node:sqlite; GC handles it.
    }
    const limited = rows.slice(0, DBBROWSER_MAX_ROWS);
    const columns = limited.length > 0 ? Object.keys(limited[0]!) : [];
    const out: QueryResult = {
      columns,
      rows: limited.map((r) => {
        const o: Record<string, unknown> = {};
        for (const k of columns) o[k] = jsonSafe(r[k]);
        return o;
      }),
      rowCount: rows.length,
      truncated: rows.length > limited.length,
      durationMs: Date.now() - t0,
    };
    if (changes !== undefined) out.changes = changes;
    return out;
  }

  async exec(sql: string, params: unknown[] = []): Promise<{ changes: number; durationMs: number }> {
    const t0 = Date.now();
    const r = this.open().prepare(sql).run(...this.bind(params));
    return { changes: Number(r.changes), durationMs: Date.now() - t0 };
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

// ---------------------------------------------------------------------------
// Minimal PostgreSQL wire client (simple-query protocol only).
// ---------------------------------------------------------------------------

export interface PgConnectOptions {
  host: string;
  port: number;
  user: string;
  database: string;
  connectTimeoutMs?: number;
  queryTimeoutMs?: number;
}

export class PgAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgAuthRequiredError';
  }
}

export class PgProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgProtocolError';
  }
}

/** Incremental PG message-frame reader. */
class PgReader {
  private buf = Buffer.alloc(0);
  constructor(private readonly sock: Socket) {}
  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
  }
  /** Take one complete backend message, or null if incomplete. */
  take(): { type: string; body: Buffer } | null {
    if (this.buf.length < 5) return null;
    const type = String.fromCharCode(this.buf[0]!);
    const len = this.buf.readInt32BE(1);
    if (this.buf.length < 1 + len) return null;
    const body = this.buf.subarray(5, 1 + len);
    this.buf = this.buf.subarray(1 + len);
    return { type, body };
  }
}

function readCString(b: Buffer, off: number): [string, number] {
  const end = b.indexOf(0, off);
  if (end === -1) throw new PgProtocolError('unterminated cstring in PG message');
  return [b.subarray(off, end).toString('utf8'), end + 1];
}

function pgMessage(type: string, body: Buffer): Buffer {
  const h = Buffer.alloc(5);
  h[0] = type.charCodeAt(0);
  h.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([h, body]);
}

function cstr(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}

export class PostgresDriver implements DbDriver {
  readonly kind = 'postgres' as const;
  private sock: Socket | null = null;
  private reader: PgReader | null = null;
  private pending: Array<(msg: { type: string; body: Buffer }) => void> = [];
  private failed: Error | null = null;

  constructor(
    readonly name: string,
    private readonly opts: PgConnectOptions,
  ) {}

  private ensureConnected(): Promise<void> {
    if (this.sock && !this.failed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeoutMs = this.opts.connectTimeoutMs ?? 5000;
      const timer = setTimeout(() => {
        this.failed = new PgProtocolError(`postgres connect timeout (${timeoutMs}ms)`);
        this.sock?.destroy();
        reject(this.failed);
      }, timeoutMs);
      const sock = createConnection({ host: this.opts.host, port: this.opts.port }, () => {
        // Send StartupMessage (no leading type byte).
        const params = Buffer.concat([
          cstr('user'),
          cstr(this.opts.user),
          cstr('database'),
          cstr(this.opts.database),
          cstr('client_encoding'),
          cstr('UTF8'),
          Buffer.from([0]),
        ]);
        const head = Buffer.alloc(8);
        head.writeInt32BE(params.length + 8, 0);
        head.writeInt32BE(196608, 4); // protocol 3.0
        sock.write(Buffer.concat([head, params]));
      });
      this.sock = sock;
      this.reader = new PgReader(sock);
      sock.on('data', (chunk: Buffer) => {
        // Deliver at most one message per queued waiter: resolving a
        // waiter only schedules its pump on the microtask queue, so
        // draining the whole buffer here would drop messages nobody
        // has asked for yet. Leftover bytes stay in the reader for the
        // next next() call.
        this.reader!.push(chunk);
        for (;;) {
          if (this.pending.length === 0) break;
          const m = this.reader!.take();
          if (!m) break;
          const waiter = this.pending.shift()!;
          waiter(m);
        }
      });
      sock.on('error', (e) => {
        this.failed = e;
        clearTimeout(timer);
        reject(e);
      });
      const fail = (e: Error) => {
        this.failed = e;
        clearTimeout(timer);
        reject(e);
      };
      const pump = (msg: { type: string; body: Buffer }): void => {
        if (msg.type === 'R') {
          const kind = msg.body.readInt32BE(0);
          if (kind === 0) {
            this.next().then(pump, fail); // AuthenticationOk — keep waiting for ReadyForQuery
            return;
          }
          fail(new PgAuthRequiredError(`postgres server demands auth method ${kind}; only trust auth is supported`));
          return;
        }
        if (msg.type === 'E') {
          fail(new PgProtocolError(`postgres startup error: ${errorFields(msg.body).M ?? 'unknown'}`));
          return;
        }
        if (msg.type === 'Z') {
          clearTimeout(timer);
          resolve();
          return;
        }
        // ParameterStatus('S') / BackendKeyData('K') / NoticeResponse('N'): ignore.
        this.next().then(pump, fail);
      };
      this.next().then(pump, fail);
    });
  }

  private next(): Promise<{ type: string; body: Buffer }> {
    return new Promise((resolve, reject) => {
      if (this.failed) {
        reject(this.failed);
        return;
      }
      this.pending.push(resolve);
      const m = this.reader!.take();
      if (m) {
        const waiter = this.pending.shift();
        if (waiter) waiter(m);
      }
    });
  }

  private async simpleQuery(sql: string): Promise<QueryResult> {
    await this.ensureConnected();
    const t0 = Date.now();
    const timeoutMs = this.opts.queryTimeoutMs ?? 30000;
    const timer = setTimeout(() => {
      this.failed = new PgProtocolError(`postgres query timeout (${timeoutMs}ms)`);
      this.sock?.destroy();
    }, timeoutMs);
    try {
      this.sock!.write(pgMessage('Q', cstr(sql)));
      const columns: string[] = [];
      const rows: Array<Record<string, unknown>> = [];
      let commandTag = '';
      for (;;) {
        const msg = await this.next();
        if (msg.type === 'T') {
          // RowDescription: int16 count, then per-field: cstring name + 18 bytes.
          let off = 2;
          const count = msg.body.readInt16BE(0);
          for (let i = 0; i < count; i++) {
            const [name, next] = readCString(msg.body, off);
            columns.push(name);
            off = next + 18;
          }
        } else if (msg.type === 'D') {
          const count = msg.body.readInt16BE(0);
          let off = 2;
          const row: Record<string, unknown> = {};
          for (let i = 0; i < count; i++) {
            const len = msg.body.readInt32BE(off);
            off += 4;
            if (len === -1) {
              row[columns[i]!] = null;
            } else {
              row[columns[i]!] = msg.body.subarray(off, off + len).toString('utf8');
              off += len;
            }
          }
          if (rows.length < DBBROWSER_MAX_ROWS) rows.push(row);
        } else if (msg.type === 'C') {
          commandTag = msg.body.subarray(0, msg.body.length - 1).toString('utf8');
        } else if (msg.type === 'E') {
          throw new PgProtocolError(`postgres error: ${errorFields(msg.body).M ?? 'unknown'}`);
        } else if (msg.type === 'I' || msg.type === 'Z') {
          break; // EmptyQueryResponse or ReadyForQuery: done
        }
        // 'N' NoticeResponse ignored.
      }
      const tagParts = commandTag.split(' ');
      const lastNum = Number(tagParts[tagParts.length - 1]);
      const out: QueryResult = {
        columns,
        rows,
        rowCount: rows.length,
        truncated: rows.length >= DBBROWSER_MAX_ROWS,
        durationMs: Date.now() - t0,
      };
      if (!Number.isNaN(lastNum) && !/^(SELECT|SHOW)$/.test(tagParts[0] ?? '')) out.changes = lastNum;
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  async query(sql: string, _params: unknown[] = []): Promise<QueryResult> {
    // Simple-query protocol has no bind parameters; refuse silently-misused params.
    if (_params.length > 0) {
      throw new PgProtocolError('postgres simple-query protocol takes no parameters; inline values instead');
    }
    return this.simpleQuery(sql);
  }

  async exec(sql: string, params: unknown[] = []): Promise<{ changes: number; durationMs: number }> {
    if (params.length > 0) {
      throw new PgProtocolError('postgres simple-query protocol takes no parameters; inline values instead');
    }
    const r = await this.simpleQuery(sql);
    return { changes: r.changes ?? 0, durationMs: r.durationMs };
  }

  async close(): Promise<void> {
    try {
      this.sock?.write(pgMessage('X', Buffer.alloc(0)));
    } catch {
      /* closing anyway */
    }
    this.sock?.destroy();
    this.sock = null;
  }
}

function errorFields(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let off = 0;
  while (off < body.length) {
    const code = String.fromCharCode(body[off]!);
    if (code === '\0') break;
    const [val, next] = readCString(body, off + 1);
    out[code] = val;
    off = next;
  }
  return out;
}

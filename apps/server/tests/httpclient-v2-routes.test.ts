/**
 * HTTP API client deepening routes — R7-#9.
 * Boots the real server (dist) with an isolated DB and exercises:
 *   collections CRUD, auth profiles (bearer/basic/apikey/oauth2
 *   placeholder), API environments with secret names, strict
 *   substitution, send + history rerun (redaction), GraphQL, WS.
 * Local HTTP + WS echo servers stand in for real endpoints.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/httpclient-v2-routes.test.ts
 * (requires a server build first — the server boots from dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

interface EchoSeen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function startHttpEcho(): Promise<{ srv: Server; port: number; seen: EchoSeen[] }> {
  const seen: EchoSeen[] = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if ((req.url ?? '').startsWith('/graphql')) {
        const parsed = JSON.parse(body || '{}') as { query?: string };
        res.writeHead(200, { 'content-type': 'application/json' });
        if ((parsed.query ?? '').includes('boom')) {
          res.end(JSON.stringify({ errors: [{ message: 'field boom does not exist' }] }));
        } else {
          res.end(JSON.stringify({ data: { user: { id: 7 } } }));
        }
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method, url: req.url, auth: req.headers['authorization'] ?? null, apiKey: req.headers['x-api-key'] ?? null }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: (srv.address() as { port: number }).port, seen })));
}

function wsFrameUnmasked(opcode: number, payload: Buffer): Buffer {
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.from([0x80 | opcode, 0xfe, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

function startWsEcho(): Promise<{ srv: Server; port: number }> {
  const srv = createServer();
  srv.on('upgrade', (req, sock: Socket) => {
    const key = req.headers['sec-websocket-key'] as string;
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        const b1 = buf[1];
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        const mask = buf.subarray(off, off + 4);
        off += 4;
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        if (opcode === 0x1) sock.write(wsFrameUnmasked(0x1, Buffer.from(`echo:${unmasked.toString('utf8')}`, 'utf8')));
        else if (opcode === 0x8) {
          sock.write(wsFrameUnmasked(0x8, unmasked));
          sock.end();
          return;
        }
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: (srv.address() as { port: number }).port })));
}

async function waitForHealth(port: number, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not become healthy');
}

async function req(port: number, p: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: r.status, json };
}

test('R7-#9 api client deepening end to end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-httpapi-'));
  const http = await startHttpEcho();
  const ws = await startWsEcho();
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'db', 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
    FACTORY_INSPECT_ROOTS: dir,
    FACTORY_SHADOW_ROOTS: dir,
    FACTORY_ALLOW_OPEN_LOCAL: '1',
  };
  const proc: ChildProcess = spawn(process.execPath, [serverEntry], { env, stdio: 'ignore' });
  try {
    await waitForHealth(port);
    const base = `http://127.0.0.1:${http.port}`;

    // Collections.
    const col = await req(port, '/api/http/collections', {
      method: 'POST',
      body: JSON.stringify({ collection: { id: 'c1', name: 'demo', requests: [{ id: 'r1', name: 'echo', method: 'GET', url: '{{baseUrl}}/echo', headers: {} }] } }),
    });
    assert.equal(col.status, 201);
    const dup = await req(port, '/api/http/collections', {
      method: 'POST',
      body: JSON.stringify({ collection: { id: 'c1', name: 'demo', requests: [] } }),
    });
    assert.equal(dup.status, 409);

    // Auth profiles: secrets never come back.
    const bearer = await req(port, '/api/http/auth-profiles', {
      method: 'POST',
      body: JSON.stringify({ profile: { id: 'b1', name: 'bearer', kind: 'bearer' }, secret: 'bearer-secret-xyz' }),
    });
    assert.equal(bearer.status, 201);
    assert.equal(JSON.stringify(bearer.json).includes('bearer-secret-xyz'), false);
    const basic = await req(port, '/api/http/auth-profiles', {
      method: 'POST',
      body: JSON.stringify({ profile: { id: 'ba1', name: 'basic', kind: 'basic', username: 'alice' }, secret: 'pw-secret' }),
    });
    assert.equal(basic.status, 201);
    const apikey = await req(port, '/api/http/auth-profiles', {
      method: 'POST',
      body: JSON.stringify({ profile: { id: 'k1', name: 'key', kind: 'apikey' }, secret: 'key-secret' }),
    });
    assert.equal(apikey.status, 201);

    // API environment with a secret name.
    const envPut = await req(port, '/api/http/api-environments', {
      method: 'PUT',
      body: JSON.stringify({
        environment: { name: 'dev', vars: { baseUrl: base, token: '' }, secretNames: ['token'] },
        secrets: { token: 'env-token-secret' },
      }),
    });
    assert.equal(envPut.status, 200);
    const envGet = await req(port, '/api/http/api-environments');
    const envs = envGet.json['environments'] as Array<{ name: string; vars: Record<string, string> }>;
    assert.equal(envs[0].vars['token'], '<redacted>');
    assert.equal(envs[0].vars['baseUrl'], base);
    assert.equal(JSON.stringify(envGet.json).includes('env-token-secret'), false);

    // Send with bearer + env substitution (url + header from env secret).
    const send = await req(port, '/api/http/send', {
      method: 'POST',
      body: JSON.stringify({
        method: 'GET', url: '{{baseUrl}}/echo', headers: { 'X-Echo-Token': '{{token}}' },
        environment: 'dev', authProfileId: 'b1', collectionId: 'c1', requestName: 'echo',
      }),
    });
    assert.equal(send.status, 200);
    const result = send.json['result'] as { status?: number; ok: boolean; blocked?: boolean };
    assert.equal(result.blocked, undefined);
    assert.equal(result.status, 200);
    const lastEcho = http.seen[http.seen.length - 1];
    assert.equal(lastEcho.headers['authorization'], 'Bearer bearer-secret-xyz');
    assert.equal(lastEcho.headers['x-echo-token'], 'env-token-secret');

    // Basic + apikey sends reach the echo server with the right headers.
    const sendBasic = await req(port, '/api/http/send', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', url: '{{baseUrl}}/echo', environment: 'dev', authProfileId: 'ba1' }),
    });
    assert.equal(sendBasic.status, 200);
    assert.equal(http.seen[http.seen.length - 1].headers['authorization'], `Basic ${Buffer.from('alice:pw-secret').toString('base64')}`);
    const sendKey = await req(port, '/api/http/send', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', url: '{{baseUrl}}/echo', environment: 'dev', authProfileId: 'k1' }),
    });
    assert.equal(sendKey.status, 200);
    assert.equal(http.seen[http.seen.length - 1].headers['x-api-key'], 'key-secret');

    // Strict substitution + inline Authorization fail closed.
    const unresolved = await req(port, '/api/http/send', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', url: '{{baseUrl}}/{{nope}}', environment: 'dev' }),
    });
    assert.equal(unresolved.status, 400);
    assert.equal(unresolved.json['code'], 'unresolved-variable');
    const inlineAuth = await req(port, '/api/http/send', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', url: '{{baseUrl}}/echo', environment: 'dev', headers: { Authorization: 'Bearer x' } }),
    });
    assert.equal(inlineAuth.status, 400);

    // OAuth2 placeholder fails closed at send.
    await req(port, '/api/http/auth-profiles', {
      method: 'POST',
      body: JSON.stringify({ profile: { id: 'o1', name: 'oauth', kind: 'oauth2' } }),
    });
    const oauthSend = await req(port, '/api/http/send', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', url: '{{baseUrl}}/echo', environment: 'dev', authProfileId: 'o1' }),
    });
    assert.equal(oauthSend.status, 400);
    assert.equal(oauthSend.json['code'], 'oauth2-placeholder');

    // GraphQL: data + errors.
    const gql = await req(port, '/api/http/graphql', {
      method: 'POST',
      body: JSON.stringify({ endpoint: '{{baseUrl}}/graphql', query: '{ user { id } }', environment: 'dev' }),
    });
    assert.equal(gql.status, 200);
    const gqlResult = gql.json['result'] as { status?: number; bodyJson?: { data?: { user?: { id?: number } } }; graphqlErrors?: unknown };
    assert.equal(gqlResult.status, 200);
    assert.equal(gqlResult.bodyJson?.data?.user?.id, 7);
    const gqlBad = await req(port, '/api/http/graphql', {
      method: 'POST',
      body: JSON.stringify({ endpoint: '{{baseUrl}}/graphql', query: '{ boom }', environment: 'dev' }),
    });
    const gqlBadResult = gqlBad.json['result'] as { graphqlErrors?: Array<{ message: string }>; ok: boolean };
    assert.equal(gqlBadResult.ok, false);
    assert.equal(gqlBadResult.graphqlErrors?.[0].message, 'field boom does not exist');

    // History: template URLs, no secrets, rerun links back.
    const hist = await req(port, '/api/http/history');
    const entries = hist.json['history'] as Array<{ id: string; urlTemplate: string; spec: { headers: Record<string, string> } }>;
    assert.ok(entries.length >= 3);
    assert.equal(JSON.stringify(hist.json).includes('bearer-secret-xyz'), false);
    assert.equal(JSON.stringify(hist.json).includes('env-token-secret'), false);
    assert.equal(JSON.stringify(hist.json).includes('pw-secret'), false);
    assert.equal(JSON.stringify(hist.json).includes('key-secret'), false);
    const first = entries[0];
    assert.ok(first.urlTemplate.includes('{{baseUrl}}'));
    const rerun = await req(port, `/api/http/history/${first.id}/rerun`, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(rerun.status, 200);
    assert.equal(rerun.json['rerunOf'], first.id);

    // WebSocket: connect -> send -> echo -> close -> send 409.
    const connect = await req(port, '/api/http/ws/connect', {
      method: 'POST',
      body: JSON.stringify({ url: `ws://127.0.0.1:${ws.port}/echo` }),
    });
    assert.equal(connect.status, 201);
    const session = connect.json['session'] as { id: string; status: string };
    assert.equal(session.status, 'open');
    const wsSend = await req(port, `/api/http/ws/${session.id}/send`, { method: 'POST', body: JSON.stringify({ text: 'ping-ws' }) });
    assert.equal(wsSend.status, 200);
    let messages: Array<{ direction: string; text: string }> = [];
    for (let i = 0; i < 30 && !messages.some((m) => m.direction === 'in'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      const m = await req(port, `/api/http/ws/${session.id}/messages`);
      messages = m.json['messages'] as typeof messages;
    }
    assert.ok(messages.some((m) => m.direction === 'in' && m.text === 'echo:ping-ws'));
    const close = await req(port, `/api/http/ws/${session.id}/close`, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(close.status, 200);
    const afterClose = await req(port, `/api/http/ws/${session.id}/send`, { method: 'POST', body: JSON.stringify({ text: 'late' }) });
    assert.equal(afterClose.status, 409);

    // Secrets file exists, is 0600, and holds the values (server-side only).
    const secretsPath = path.join(dir, 'data', 'http-api-secrets.json');
    assert.equal(fs.existsSync(secretsPath), true);
    assert.equal((fs.statSync(secretsPath).mode & 0o777), 0o600);
  } finally {
    proc.kill('SIGTERM');
    http.srv.close();
    ws.srv.close();
    await new Promise((r) => setTimeout(r, 300));
  }
});

/**
 * Webhook receiver HTTP tests — R7-#5.
 * Boots the real server (dist) with an isolated DB and exercises the
 * whole feature end to end:
 *
 *   Management (behind the API token gate, open-local in tests):
 *     POST /api/webhooks/endpoints      create, duplicate -> 409,
 *                                       invalid -> 400
 *     GET  /api/webhooks/endpoints      lists the endpoint, no secret
 *     GET  /api/webhooks/deliveries     empty before any event
 *   Receiver (HMAC auth, dispatched pre-gate, no Bearer token):
 *     valid signed push                 -> triggered (chain ran)
 *     same eventId, fresh nonce         -> duplicate (chain NOT re-run)
 *     same nonce replay                 -> 401 replay-nonce
 *     tampered body                     -> 401 bad-signature
 *     stale timestamp                   -> 401 stale-timestamp
 *     unknown event type, valid sig     -> 404 no-endpoint
 *     GET /api/audit                    TRIGGERED + REJECTED on chain
 *   Fail-closed: a second boot without FACTORY_WEBHOOK_SECRET
 *     rejects a signed event with 503 secret-not-configured.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/webhooks-routes.test.ts
 * (requires a server build first — the server boots from dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');
const SECRET = 'test-webhook-secret-r7-5';

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
  projDir: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const port = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port.port));
    });
  });
}

async function startServer(withSecret: boolean): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-webhook-http-'));
  const projDir = path.join(dir, 'projects', 'demo');
  fs.mkdirSync(path.join(projDir, '.ai-factory'), { recursive: true });
  fs.writeFileSync(
    path.join(projDir, '.ai-factory', 'tasks.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [
        { label: 'lint-and-test', type: 'shell', command: 'echo webhook-chain-ran' },
      ],
    }),
    'utf8',
  );
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'db', 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
    FACTORY_INSPECT_ROOTS: dir,
    FACTORY_SHADOW_ROOTS: dir,
    // Test-harness opt-in: the server is fail-closed without a token
    // even on loopback since V3-#1; management endpoints use it.
    FACTORY_ALLOW_OPEN_LOCAL: '1',
  };
  if (withSecret) env['FACTORY_WEBHOOK_SECRET'] = SECRET;
  else delete env['FACTORY_WEBHOOK_SECRET'];
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_WEBHOOK_SECRET_FILE']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('server did not start in 30s');
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => {
          s.end();
          resolve();
        });
        s.once('error', reject);
      });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return { port, proc, dir, projDir };
}

async function stopServer(r: Running): Promise<void> {
  r.proc.kill('SIGKILL');
  await new Promise((resolve) => r.proc.once('exit', resolve));
}

async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

function sign(body: string, ts: string, nonce: string, secret: string = SECRET): string {
  const hex = crypto.createHmac('sha256', secret).update(`${ts}.${nonce}.${body}`, 'utf8').digest('hex');
  return `sha256=${hex}`;
}

function receiveHeaders(body: string, event: string, eventId: string, nonce: string, ts?: string, secret?: string) {
  const timestamp = ts ?? String(Math.floor(Date.now() / 1000));
  return {
    'x-ai-factory-signature': sign(body, timestamp, nonce, secret),
    'x-ai-factory-timestamp': timestamp,
    'x-ai-factory-nonce': nonce,
    'x-ai-factory-event': event,
    'x-ai-factory-event-id': eventId,
  };
}

test('webhook receiver end to end over HTTP', async () => {
  const srv = await startServer(true);
  try {
    // 1. Management: create + duplicate + invalid + list (no secret leak).
    const created = await api(srv.port, 'POST', '/api/webhooks/endpoints', {
      id: 'gh-push',
      name: 'GitHub push',
      eventType: 'push',
      chainLabel: 'lint-and-test',
      root: srv.projDir,
      projectId: 'webhook-proj',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.endpoint.id, 'gh-push');
    const dup = await api(srv.port, 'POST', '/api/webhooks/endpoints', {
      id: 'gh-push',
      name: 'Again',
      eventType: 'push',
      chainLabel: 'lint-and-test',
      root: srv.projDir,
      projectId: 'webhook-proj',
    });
    assert.equal(dup.status, 409);
    const bad = await api(srv.port, 'POST', '/api/webhooks/endpoints', {
      id: 'Bad ID!',
      name: 'Bad',
      eventType: 'push',
      chainLabel: 'lint-and-test',
      root: srv.projDir,
      projectId: 'webhook-proj',
    });
    assert.equal(bad.status, 400);
    const list = await api(srv.port, 'GET', '/api/webhooks/endpoints');
    assert.equal(list.status, 200);
    assert.equal(list.body.endpoints.length, 1);
    assert.equal(list.body.secretConfigured, true);
    assert.equal(JSON.stringify(list.body).includes(SECRET), false);
    const empty = await api(srv.port, 'GET', '/api/webhooks/deliveries');
    assert.equal(empty.body.deliveries.length, 0);

    // 2. Valid signed push -> triggered (no Bearer token on purpose:
    // the receiver authenticates by HMAC, dispatched pre-gate).
    const body = JSON.stringify({ event: 'push', ref: 'main' });
    const ok = await api(srv.port, 'POST', '/api/webhooks/receive', JSON.parse(body),
      receiveHeaders(body, 'push', 'ev-1', 'nonce-1'));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, 'triggered');
    assert.equal(ok.body.endpointId, 'gh-push');

    // 3. Same eventId, fresh nonce + signature -> duplicate, no re-run.
    const dupEv = await api(srv.port, 'POST', '/api/webhooks/receive', JSON.parse(body),
      receiveHeaders(body, 'push', 'ev-1', 'nonce-2'));
    assert.equal(dupEv.status, 200);
    assert.equal(dupEv.body.status, 'duplicate');

    // 4. Same nonce replayed -> 401 replay-nonce.
    const replay = await api(srv.port, 'POST', '/api/webhooks/receive', JSON.parse(body),
      receiveHeaders(body, 'push', 'ev-2', 'nonce-1'));
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, 'replay-nonce');

    // 5. Tampered body -> 401 bad-signature.
    const tampered = await api(srv.port, 'POST', '/api/webhooks/receive',
      { event: 'push', ref: 'evil' },
      receiveHeaders(body, 'push', 'ev-3', 'nonce-3'));
    assert.equal(tampered.status, 401);
    assert.equal(tampered.body.code, 'bad-signature');

    // 6. Stale timestamp -> 401 stale-timestamp.
    const staleTs = String(Math.floor(Date.now() / 1000) - 1000);
    const stale = await api(srv.port, 'POST', '/api/webhooks/receive', JSON.parse(body),
      receiveHeaders(body, 'push', 'ev-4', 'nonce-4', staleTs));
    assert.equal(stale.status, 401);
    assert.equal(stale.body.code, 'stale-timestamp');

    // 7. Unknown event type, valid signature -> 404 no-endpoint.
    const unknown = await api(srv.port, 'POST', '/api/webhooks/receive',
      { event: 'release', tag: 'v1' },
      receiveHeaders(JSON.stringify({ event: 'release', tag: 'v1' }), 'release', 'ev-5', 'nonce-5'));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'no-endpoint');

    // 8. Deliveries: exactly one triggered (the duplicate did not re-run).
    const deliveries = await api(srv.port, 'GET', '/api/webhooks/deliveries');
    const triggered = deliveries.body.deliveries.filter((d: any) => d.status === 'triggered');
    assert.equal(triggered.length, 1);
    assert.equal(deliveries.body.deliveries.filter((d: any) => d.status === 'duplicate').length, 1);
    assert.equal(JSON.stringify(deliveries.body).includes(SECRET), false);

    // 9. Audit chain carries both outcomes, never the secret.
    const audit = await api(srv.port, 'GET', '/api/audit?limit=200');
    assert.equal(audit.status, 200);
    const events = JSON.stringify(audit.body);
    assert.ok(events.includes('WEBHOOK_TRIGGERED'));
    assert.ok(events.includes('WEBHOOK_REJECTED'));
    assert.ok(events.includes('WEBHOOK_DUPLICATE'));
    assert.equal(events.includes(SECRET), false);
  } finally {
    await stopServer(srv);
  }
});

test('webhook receiver without a secret is fail-closed (503)', async () => {
  const srv = await startServer(false);
  try {
    const body = JSON.stringify({ event: 'push' });
    const r = await api(srv.port, 'POST', '/api/webhooks/receive', JSON.parse(body),
      receiveHeaders(body, 'push', 'ev-9', 'nonce-9'));
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'secret-not-configured');
  } finally {
    await stopServer(srv);
  }
});

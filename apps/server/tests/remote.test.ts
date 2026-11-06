/**
 * Remote development HTTP tests (R7-#1) — boots the real server (dist)
 * with an isolated DB and exercises the whole feature:
 *
 *   local transport: create -> probe online -> files -> read -> write -> exec
 *   fake-ssh transport: same round-trip through a shim ssh on PATH
 *   fail-closed: unknown/offline connection exec -> 409, never local
 *   secrets: password field -> 400 SECRET_FIELD_REJECTED; audit records
 *     never contain keyPath or command text
 *   jail: ../ escape -> 400 INVALID_PATH; policy-denied binary -> 403
 *   forwards: ssh start -> list alive -> delete -> list empty
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/remote.test.ts
 * (requires a server build first — the server boots from dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
  shimDir: string;
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
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

/** Fake ssh shim (same contract as the package test's shim). */
function makeShim(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-http-shim-'));
  const shim = path.join(dir, 'ssh');
  fs.writeFileSync(
    shim,
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.includes('-N')) { setInterval(() => {}, 3600_000); } else {
const cmd = argv[argv.length - 1] || '';
function unquote(s) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === "'") {
        if (s[i + 1] === '\\\\') { cur += "'"; i += 2; continue; }
        q = false;
      } else cur += ch;
    } else if (ch === "'") q = true;
    else if (ch === ' ') { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const toks = unquote(cmd);
if (toks.length === 1 && toks[0] === 'true') process.exit(0);
if (toks[0] === 'ls' && toks[1] === '-1' && toks[2] === '--') {
  for (const n of fs.readdirSync(toks[3])) console.log(n);
  process.exit(0);
}
if (toks[0] === 'cat' && toks[1] === '--') {
  process.stdout.write(fs.readFileSync(toks[2]));
  process.exit(0);
}
if (toks[0] === 'echo') { console.log(toks.slice(1).join(' ')); process.exit(0); }
if (cmd.startsWith('cat > ')) {
  const p = unquote(cmd.slice(6))[0];
  const data = fs.readFileSync(0);
  fs.mkdirSync(require('node:path').dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  process.exit(0);
}
console.error('fake ssh: unknown command ' + cmd);
process.exit(1);
}
`,
    'utf8',
  );
  fs.chmodSync(shim, 0o755);
  return dir;
}

async function startServer(extraEnv: NodeJS.ProcessEnv = {}): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-http-'));
  const shimDir = makeShim();
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
    FACTORY_ALLOW_OPEN_LOCAL: '1',
    PATH: `${shimDir}:${process.env['PATH'] ?? ''}`,
    // V3R18 #6(m): the local-exec round-trip must execute on this
    // bwrap-less machine — the sandbox is explicitly disabled here, so
    // the exec runs. The refusal branch is covered by
    // v3r18-6mn.test.ts and the probe scripts, not here. The read jail
    // allowlist covers os.tmpdir() because every remoteRoot in this
    // file is created under it.
    FACTORY_EXEC_SANDBOX: '0',
    FACTORY_REMOTE_ALLOWED_ROOTS: os.tmpdir(),
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  // Injected after the credential purge so a test can plant known
  // credentials in the server child env (R15 #6(f) probe).
  Object.assign(env, extraEnv);
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
  return { port, proc, dir, shimDir };
}

async function stopServer(r: Running): Promise<void> {
  r.proc.kill('SIGKILL');
  await new Promise((resolve) => r.proc.once('exit', resolve));
  fs.rmSync(r.dir, { recursive: true, force: true });
  fs.rmSync(r.shimDir, { recursive: true, force: true });
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
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('remote development end to end over HTTP', async () => {
  const srv = await startServer();
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-root-'));
    fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n', 'utf8');

    // 1. Secret field rejected fail-closed.
    let r = await api(srv.port, 'POST', '/api/remote/connections', {
      name: 'bad', kind: 'ssh', host: 'h', remoteRoot: '/srv', password: 'x',
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'SECRET_FIELD_REJECTED');

    // 2. Local connection round-trip.
    r = await api(srv.port, 'POST', '/api/remote/connections', {
      name: 'local-dev', kind: 'local', remoteRoot: root,
    });
    assert.equal(r.status, 201);
    const localId = r.body.connection.id as string;
    assert.equal(r.body.connection.status, 'unknown');

    // Exec before probe: fail-closed, never local fallback confusion.
    r = await api(srv.port, 'POST', `/api/remote/connections/${localId}/exec`, { command: 'echo hi' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'NOT_CONNECTED');

    r = await api(srv.port, 'POST', `/api/remote/connections/${localId}/probe`);
    assert.equal(r.status, 200);
    assert.equal(r.body.probe.online, true);
    assert.equal(r.body.connection.status, 'online');

    r = await api(srv.port, 'GET', `/api/remote/connections/${localId}/files?path=.`);
    assert.equal(r.status, 200);
    assert.ok((r.body.entries as string[]).includes('seed.txt'));

    r = await api(srv.port, 'GET', `/api/remote/connections/${localId}/file?path=seed.txt`);
    assert.equal(r.status, 200);
    assert.equal(r.body.content, 'seed\n');

    r = await api(srv.port, 'POST', `/api/remote/connections/${localId}/file`, {
      path: 'written.txt', content: 'from-panel',
    });
    assert.equal(r.status, 200);
    assert.equal(fs.readFileSync(path.join(root, 'written.txt'), 'utf8'), 'from-panel');

    r = await api(srv.port, 'POST', `/api/remote/connections/${localId}/exec`, { command: 'echo hello-remote' });
    assert.equal(r.status, 200);
    assert.match(r.body.stdout, /hello-remote/);

    // Jail + policy.
    r = await api(srv.port, 'GET', `/api/remote/connections/${localId}/file?path=../escape.txt`);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'INVALID_PATH');
    r = await api(srv.port, 'POST', `/api/remote/connections/${localId}/exec`, { command: 'rm -rf /' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'POLICY_DENIED');

    // 3. Fake-ssh connection round-trip (keyPath is a reference, never read).
    const sshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-ssh-root-'));
    fs.writeFileSync(path.join(sshRoot, 'remote.txt'), 'ssh-seed', 'utf8');
    r = await api(srv.port, 'POST', '/api/remote/connections', {
      name: 'fake-ssh', kind: 'ssh', host: 'example.invalid', username: 'dev',
      keyPath: '/home/testuser/.ssh/id_r7test', remoteRoot: sshRoot,
    });
    assert.equal(r.status, 201);
    const sshId = r.body.connection.id as string;
    r = await api(srv.port, 'POST', `/api/remote/connections/${sshId}/probe`);
    assert.equal(r.status, 200);
    assert.equal(r.body.probe.online, true);
    r = await api(srv.port, 'GET', `/api/remote/connections/${sshId}/files?path=.`);
    assert.ok((r.body.entries as string[]).includes('remote.txt'));
    r = await api(srv.port, 'POST', `/api/remote/connections/${sshId}/exec`, { command: 'echo via-remote' });
    assert.equal(r.status, 200);
    assert.match(r.body.stdout, /via-remote/);

    // 4. Forwards over fake ssh: start -> list alive -> delete -> empty.
    r = await api(srv.port, 'POST', `/api/remote/connections/${sshId}/forwards`, {
      localPort: 18099, remoteHost: 'localhost', remotePort: 3000,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.forward.alive, true);
    r = await api(srv.port, 'GET', `/api/remote/connections/${sshId}/forwards`);
    assert.equal((r.body.forwards as unknown[]).length, 1);
    r = await api(srv.port, 'DELETE', `/api/remote/connections/${sshId}/forwards/18099`);
    assert.equal(r.status, 200);
    r = await api(srv.port, 'GET', `/api/remote/connections/${sshId}/forwards`);
    assert.equal((r.body.forwards as unknown[]).length, 0);

    // 5. Disconnect -> exec refused again (no silent fallback).
    r = await api(srv.port, 'POST', `/api/remote/connections/${sshId}/disconnect`);
    assert.equal(r.status, 200);
    assert.equal(r.body.connection.status, 'offline');
    r = await api(srv.port, 'POST', `/api/remote/connections/${sshId}/exec`, { command: 'echo hi' });
    assert.equal(r.status, 409);

    // 6. Audit: actions recorded, keyPath and command text never in details.
    r = await api(srv.port, 'GET', '/api/audit?limit=200');
    assert.equal(r.status, 200);
    const records = r.body as Array<{ action: string; details?: unknown }>;
    assert.ok(records.some((rec) => rec.action === 'REMOTE_CONNECTION_CREATED'));
    assert.ok(records.some((rec) => rec.action === 'REMOTE_PROBE'));
    const auditJson = JSON.stringify(records);
    assert.ok(!auditJson.includes('id_r7test'), 'keyPath leaked into audit');
    assert.ok(!auditJson.includes('hello-remote'), 'command text leaked into audit');

    // 7. Delete cleans up.
    r = await api(srv.port, 'DELETE', `/api/remote/connections/${localId}`);
    assert.equal(r.status, 200);
    r = await api(srv.port, 'GET', `/api/remote/connections/${localId}`);
    assert.equal(r.status, 404);

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sshRoot, { recursive: true, force: true });
  } finally {
    await stopServer(srv);
  }
});

// ---------- V3R15 #6(f): credential env scrub + output redaction ----------

test('remote local exec: credential env is scrubbed from the child, output is redacted', async () => {
  const token = 'test-value-for-factory_api_token-1234567890';
  const secret = 'test-value-for-factory_secret_probe-1234567890';
  const srv = await startServer({ FACTORY_API_TOKEN: token, FACTORY_SECRET_PROBE: secret });
  // A configured token disables the open-local bypass: every call below
  // must carry Authorization: Bearer <token> (auth.ts gate semantics).
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-6f-root-'));
    try {
      let r = await api(srv.port, 'POST', '/api/remote/connections', {
        name: 'local-scrub',
        kind: 'local',
        remoteRoot: root,
      }, auth);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const id = r.body.connection.id as string;
      r = await api(srv.port, 'POST', `/api/remote/connections/${id}/probe`, undefined, auth);
      assert.equal(r.body.probe.online, true, JSON.stringify(r.body));
      // Full `printenv` dump (exit 0), never `printenv KEY` (exit 1 when
      // the key is absent, which would hide the scrub behind a failure).
      r = await api(srv.port, 'POST', `/api/remote/connections/${id}/exec`, { command: 'printenv' }, auth);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const out = String(r.body.stdout ?? '');
      const lines = out.split('\n');
      // Line-prefix assertions (R13 #6(d) precedent): the key NAME may
      // legitimately appear as text in unrelated ambient vars.
      assert.ok(!lines.some((line) => line.startsWith('FACTORY_API_TOKEN=')), 'exec leaked FACTORY_API_TOKEN');
      assert.ok(!lines.some((line) => line.startsWith('FACTORY_SECRET_PROBE=')), 'exec leaked FACTORY_SECRET_PROBE');
      assert.ok(!out.includes(token), 'exec leaked the token value');
      assert.ok(!out.includes(secret), 'exec leaked the secret value');
      assert.ok(lines.some((line) => line.startsWith('PATH=/')), 'PATH must still pass through to the child');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    await stopServer(srv);
  }
});

/**
 * V3.0 audit round 17, item #6 sub-items (h) + (k) — live server probes.
 *
 * (h) scratch output-side redaction: a scratch that prints the ambient
 * credential assignment lines literally must come back with the VALUES
 * redacted (the values do not come from the child env — the scrub
 * already removed them).
 * (k) un-sandboxed vault read: with the sandbox explicitly disabled
 * (FACTORY_EXEC_SANDBOX=0, the disabled tier), a notebook cell must
 * still fail to locate the vault, because the control-plane pointer
 * vars are stripped from the child env.
 *
 * Both tests boot the real server (dist) with a dummy admin token and
 * authenticate with it; the sandbox is explicitly disabled so the runs
 * execute (this machine has no bwrap — the refusal branch is covered
 * by the probe script in ~/v3r17-6hk-shots/, not here).
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/v3r17-6hk.test.ts
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

const TOKEN_VALUE = 'test-value-for-factory_api_token-1234567890';
const SECRET_VALUE = 'test-value-for-factory_secret_probe-1234567890';

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
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

async function startServer(extraEnv: NodeJS.ProcessEnv): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r17-6hk-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
    FACTORY_ALLOW_OPEN_LOCAL: '1',
    // The sandbox is explicitly disabled for these probes (this
    // machine has no bwrap): the runs execute, so the redaction and
    // the pointer strip are what stand between the child and the
    // credential values / vault location.
    FACTORY_EXEC_SANDBOX: '0',
    ...extraEnv,
  };
  for (const k of ['FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    if (extraEnv[k] === undefined) delete env[k];
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
  return { port, proc, dir };
}

async function stopServer(r: Running): Promise<void> {
  r.proc.kill('SIGKILL');
  await new Promise((resolve) => r.proc.once('exit', resolve));
  fs.rmSync(r.dir, { recursive: true, force: true });
}

async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN_VALUE}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('V3R17 #6(h): scratch run output redacts ambient credential values printed literally', async () => {
  const srv = await startServer({
    FACTORY_API_TOKEN: TOKEN_VALUE,
    FACTORY_SECRET_PROBE: SECRET_VALUE,
  });
  try {
    const created = await api(srv.port, 'POST', '/api/scratches', { language: 'javascript', name: 'probe' });
    assert.equal(created.status, 201);
    const id = (created.body.scratch as { id: string }).id;
    assert.ok(id);
    const content =
      `console.log('FACTORY_API_TOKEN=${TOKEN_VALUE}');\n` +
      `console.log('FACTORY_SECRET_PROBE=${SECRET_VALUE}');\n` +
      `console.log('marker-done');\n`;
    const saved = await api(srv.port, 'PUT', `/api/scratches/${id}`, { content });
    assert.equal(saved.status, 200);
    const ran = await api(srv.port, 'POST', `/api/scratches/${id}/run`, {});
    assert.equal(ran.status, 200);
    const run = ran.body.run as { ok: boolean; exitCode: number; stdout: string; stderr: string };
    assert.equal(run.ok, true);
    assert.equal(run.exitCode, 0);
    assert.match(run.stdout, /marker-done/);
    const lines = run.stdout.split('\n');
    for (const [k, v] of [
      ['FACTORY_API_TOKEN', TOKEN_VALUE],
      ['FACTORY_SECRET_PROBE', SECRET_VALUE],
    ] as const) {
      // No credential VALUE anywhere in the returned output.
      assert.ok(!run.stdout.includes(v), `stdout leaked the value for ${k}`);
      assert.ok(!run.stderr.includes(v), `stderr leaked the value for ${k}`);
      // No line still carries the real value as an assignment.
      assert.ok(!lines.some((line) => line.startsWith(`${k}=${v}`)), `stdout leaked ${k} as an assignment`);
      // The line survives with the value replaced by the marker.
      assert.ok(lines.some((line) => line === `${k}=***`), `expected the redacted ${k}=*** line`);
    }
  } finally {
    await stopServer(srv);
  }
});

test('V3R17 #6(k): notebook cell cannot locate the vault with the sandbox disabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r17-6hk-vault-'));
  const secretsDir = path.join(dir, 'secrets');
  const srv = await startServer({
    FACTORY_API_TOKEN: TOKEN_VALUE,
    FACTORY_SECRETS_DIR: secretsDir,
  });
  try {
    // Force a real vault into existence through the broker API, so the
    // probe target is real (not a hypothetical path).
    const put = await api(srv.port, 'PUT', '/api/secrets/v3r17-probe-secret', {
      value: 'k-probe-value-abcdef-1234567890',
      purpose: 'v3r17-6hk vault probe',
    });
    assert.equal(put.status, 200);
    assert.ok(fs.existsSync(path.join(secretsDir, 'vault.json')), 'vault.json must exist for the probe to be meaningful');
    assert.ok(fs.existsSync(path.join(secretsDir, 'vault.key')), 'vault.key must exist for the probe to be meaningful');

    const created = await api(srv.port, 'POST', '/api/notebooks', { name: 'probe', language: 'javascript' });
    assert.equal(created.status, 201);
    const id = (created.body.notebook as { id: string }).id;
    assert.ok(id);
    const source =
      `const fs = require('fs');\n` +
      `const path = require('path');\n` +
      `const dir = process.env.FACTORY_SECRETS_DIR;\n` +
      `console.log('POINTER=' + dir);\n` +
      `if (!dir) { console.log('NO_POINTER_VAR'); } else {\n` +
      `  try {\n` +
      `    const data = fs.readFileSync(path.join(dir, 'vault.json'), 'utf8');\n` +
      `    console.log('VAULT_READ_OK:' + data.slice(0, 40));\n` +
      `  } catch (e) { console.log('VAULT_READ_FAILED:' + e.code); }\n` +
      `}\n`;
    const cell = await api(srv.port, 'POST', `/api/notebooks/${id}/cells`, {
      kind: 'code',
      language: 'javascript',
      source,
    });
    assert.equal(cell.status, 201);
    const cellId = cell.body.cellId as string;
    const ran = await api(srv.port, 'POST', `/api/notebooks/${id}/cells/${cellId}/run`, {});
    assert.equal(ran.status, 200);
    const run = ran.body.run as { ok: boolean; exitCode: number; stdout: string; stderr: string };
    assert.equal(run.ok, true);
    assert.equal(run.exitCode, 0);
    // The pointer var is gone from the child env, so the cell cannot
    // even name the vault directory, let alone read it.
    assert.match(run.stdout, /NO_POINTER_VAR/);
    assert.match(run.stdout, /POINTER=undefined/);
    assert.ok(!run.stdout.includes('VAULT_READ_OK'), 'cell must not read the vault');
    assert.ok(!run.stdout.includes(secretsDir), 'cell must not learn the vault location');
  } finally {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

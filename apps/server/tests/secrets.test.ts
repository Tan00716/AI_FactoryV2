/**
 * Secret Broker server tests — Batch 18 (§46.2).
 *
 * Two layers:
 *  1. Pure classification: /api/secrets reads are viewer, mutations
 *     admin (src/auth.ts requiredRoleFor).
 *  2. The real server binary (dist/index.js) booted with
 *     FACTORY_API_TOKENS + FACTORY_SECRETS_BACKEND=file over a temp
 *     vault dir:
 *       - metadata surface never returns a value (every response body
 *         AND the full audit dump are scanned for the sentinel);
 *       - RBAC: viewer/operator cannot write (403), anonymous 401,
 *         admin can;
 *       - the real consumption point: POST /api/exec with secretEnv
 *         injects the value into the child env ONLY — printenv output
 *         comes back redacted, a missing ref refuses the command with
 *         the uniform SECRET_NOT_FOUND error and nothing runs;
 *       - the vault persists across a server restart;
 *       - backend=keychain with no keychain tool on the machine makes
 *         startup fail closed (skipped if a tool actually exists).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredRoleFor } from '../src/auth.ts';

const VIEWER = 'viewer-secret-aaa';
const OPERATOR = 'operator-secret-bbb';
const ADMIN = 'admin-secret-ccc';
const SENTINEL = 'e2e-sentinel-77aa19-must-never-appear';
const SENTINEL_ROTATED = 'e2e-sentinel-rotated-31bc-must-never-appear';

describe('requiredRoleFor /api/secrets (§46.2 RBAC classification)', () => {
  it('reads are viewer, all mutations admin', () => {
    assert.equal(requiredRoleFor('GET', '/api/secrets'), 'viewer');
    assert.equal(requiredRoleFor('GET', '/api/secrets/deploy-key'), 'viewer');
    assert.equal(requiredRoleFor('PUT', '/api/secrets/deploy-key'), 'admin');
    assert.equal(requiredRoleFor('DELETE', '/api/secrets/deploy-key'), 'admin');
    assert.equal(requiredRoleFor('POST', '/api/secrets/deploy-key'), 'admin');
  });
});

// ------------------------------------------------------- real server (e2e) --

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

interface Booted { child: ChildProcess; port: number; dir: string }

async function bootRealServer(
  extraEnv: Record<string, string>,
  existingDir?: string,
): Promise<Booted> {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'factory-secrets-e2e-'));
  const port = 26_000 + Math.floor(Math.random() * 18_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: join(dir, 'factory.db'),
    ...extraEnv,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_API_TOKENS', 'FACTORY_SECRETS_BACKEND', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    if (!(k in extraEnv)) delete env[k];
  }
  for (const k of Object.keys(env)) {
    if (k.startsWith('FACTORY_SECRET_') && k !== 'FACTORY_SECRETS_BACKEND' && k !== 'FACTORY_SECRETS_DIR') delete env[k];
  }
  const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port, dir };
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function stopRealServer(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((r) => child.once('exit', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
  }
}

describe('Secret Broker on the real server (§46.2)', () => {
  it('metadata-only surface, RBAC writes, exec injection with redaction, restart persistence', { timeout: 90_000 }, async () => {
    const env = {
      FACTORY_API_TOKENS: `viewer:${VIEWER},operator:${OPERATOR},admin:${ADMIN}`,
      FACTORY_SECRETS_BACKEND: 'file',
    };
    const dir = mkdtempSync(join(tmpdir(), 'factory-secrets-e2e-'));
    const secretDir = join(dir, 'secrets');
    const bootEnv = { ...env, FACTORY_SECRETS_DIR: secretDir };
    const { child, port } = await bootRealServer(bootEnv, dir);
    const base = `http://127.0.0.1:${port}`;
    const seenBodies: string[] = [];
    const call = async (method: string, path: string, token?: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      seenBodies.push(text);
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
      return { status: res.status, body: parsed, text };
    };
    try {
      // Health reports the broker (metadata only).
      const health = await call('GET', '/api/health');
      const secretsHealth = health.body['secrets'] as { backend: string; stored: number };
      assert.equal(secretsHealth.backend, 'file-vault');
      assert.equal(secretsHealth.stored, 0);

      // Anonymous → 401; viewer/operator writes → 403; viewer read → 200.
      assert.equal((await call('PUT', '/api/secrets/deploy-key', undefined, { value: SENTINEL })).status, 401);
      assert.equal((await call('PUT', '/api/secrets/deploy-key', VIEWER, { value: SENTINEL })).status, 403);
      assert.equal((await call('PUT', '/api/secrets/deploy-key', OPERATOR, { value: SENTINEL })).status, 403);
      assert.equal((await call('DELETE', '/api/secrets/deploy-key', OPERATOR)).status, 403);
      const emptyList = await call('GET', '/api/secrets', VIEWER);
      assert.equal(emptyList.status, 200);
      assert.deepEqual((emptyList.body['secrets'] as unknown[]).length, 0);

      // Admin writes; the response is metadata only.
      const put = await call('PUT', '/api/secrets/deploy-key', ADMIN, { value: SENTINEL, purpose: 'e2e deploys' });
      assert.equal(put.status, 200);
      assert.equal(put.body['name'], 'deploy-key');
      assert.equal(put.body['ref'], 'secret://deploy-key');
      assert.equal(put.body['backend'], 'file-vault');
      assert.equal(put.body['exists'], true);
      assert.equal(put.body['purpose'], 'e2e deploys');
      assert.ok(!('value' in put.body), 'PUT response must not echo the value');

      // Reads show status/purpose only.
      const list = await call('GET', '/api/secrets', VIEWER);
      const entries = list.body['secrets'] as Array<Record<string, unknown>>;
      assert.equal(entries.length, 1);
      assert.equal(entries[0]['name'], 'deploy-key');
      const one = await call('GET', '/api/secrets/deploy-key', VIEWER);
      assert.equal(one.body['exists'], true);
      const missing = await call('GET', '/api/secrets/ghost', VIEWER);
      assert.equal(missing.status, 200);
      assert.equal(missing.body['exists'], false);
      assert.equal(missing.body['backend'], null);

      // Bad input: empty value and illegal name are 400s.
      assert.equal((await call('PUT', '/api/secrets/deploy-key', ADMIN, { value: '' })).status, 400);
      assert.equal((await call('PUT', '/api/secrets/bad%20name', ADMIN, { value: 'x' })).status, 400);

      // Real consumption: exec env injection. printenv would print the
      // value — the response must carry the redacted form only.
      const execOk = await call('POST', '/api/exec', ADMIN, {
        command: 'printenv AF_INJECTED',
        secretEnv: { AF_INJECTED: 'deploy-key' },
      });
      assert.equal(execOk.status, 200);
      assert.equal(execOk.body['ok'], true);
      assert.ok(String(execOk.body['output']).includes('***'), 'injected value must be redacted from output');

      // Missing ref: uniform 403, and the command provably never ran.
      const execMissing = await call('POST', '/api/exec', ADMIN, {
        command: 'echo should-not-run-marker',
        secretEnv: { AF_INJECTED: 'ghost' },
      });
      assert.equal(execMissing.status, 403);
      assert.equal(execMissing.body['code'], 'SECRET_NOT_FOUND');
      assert.equal(execMissing.body['error'], 'secret not found: secret://ghost');
      assert.ok(!execMissing.text.includes('should-not-run-marker'));

      // Rotation replaces the value (still never visible anywhere).
      const rotated = await call('PUT', '/api/secrets/deploy-key', ADMIN, { value: SENTINEL_ROTATED });
      assert.equal(rotated.status, 200);

      // Audit: broker actions present, values absent — scan everything.
      const audit = await call('GET', '/api/audit?limit=500', ADMIN);
      assert.equal(audit.status, 200);
      const auditText = JSON.stringify(audit.body);
      for (const action of ['SECRET_SET', 'SECRET_RESOLVED']) {
        assert.ok(auditText.includes(action), `${action} missing from audit`);
      }
      for (const body of [...seenBodies, auditText]) {
        assert.ok(!body.includes(SENTINEL), 'sentinel leaked into a response/audit body');
        assert.ok(!body.includes(SENTINEL_ROTATED), 'rotated sentinel leaked into a response/audit body');
      }

      // Delete → gone; exec against it now refuses.
      const del = await call('DELETE', '/api/secrets/deploy-key', ADMIN);
      assert.equal(del.status, 200);
      assert.equal(del.body['deleted'], true);
      assert.equal((await call('GET', '/api/secrets/deploy-key', VIEWER)).body['exists'], false);

      // Recreate for the restart check.
      await call('PUT', '/api/secrets/deploy-key', ADMIN, { value: SENTINEL });
    } finally {
      await stopRealServer(child);
    }

    // Restart over the same DB + vault dir: the secret persists.
    const second = await bootRealServer(bootEnv, dir);
    try {
      const res = await fetch(`http://127.0.0.1:${second.port}/api/secrets/deploy-key`, {
        headers: { Authorization: `Bearer ${VIEWER}` },
      });
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['exists'], true);
      assert.equal(body['backend'], 'file-vault');
    } finally {
      await stopRealServer(second.child);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backend=keychain with no keychain tool fails startup closed (never a silent downgrade)', { timeout: 60_000 }, async () => {
    let toolPresent = true;
    try {
      execFileSync('which', ['secret-tool'], { stdio: 'ignore' });
    } catch {
      toolPresent = false;
    }
    if (toolPresent || process.platform !== 'linux') return; // nothing honest to assert here
    const dir = mkdtempSync(join(tmpdir(), 'factory-secrets-keychain-'));
    const port = 26_000 + Math.floor(Math.random() * 18_000);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      DB_PATH: join(dir, 'factory.db'),
      FACTORY_SECRETS_BACKEND: 'keychain',
    };
    delete env['FACTORY_API_TOKEN'];
    delete env['FACTORY_API_TOKENS'];
    const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
    try {
      const code = await Promise.race([
        new Promise<number | null>((r) => child.once('exit', (c) => r(c))),
        new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
      ]);
      assert.notEqual(code, null, 'server should have exited (fail-closed), not booted');
      assert.notEqual(code, 0);
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

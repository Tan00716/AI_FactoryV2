/**
 * Versioned policy documents survive restarts — SPEC v2 §48.2 (Batch 34).
 *
 * Until Batch 34 the Authorization domain had no `policy_versions`
 * entity anywhere in the codebase (the `policy_version` STRINGS on
 * approvals, escalations and projects are independent shapes — labels,
 * not documents — and keep their meaning as-is; see
 * packages/db/src/policy-versions.ts).
 *
 * Pinned on the REAL server binary (boot → SIGKILL → reboot on the
 * same DB file):
 *   - boot A: POST /api/policy/versions twice for the same policy →
 *     versions 1 and 2, second one CURRENT, first one SUPERSEDED;
 *     the v1 response bytes are recorded;
 *   - SIGKILL boot A, boot B on the same DB:
 *   - GET /api/policy/versions?policy_id= returns both versions,
 *     newest-first, with derived statuses;
 *   - GET /api/policy/versions/:policyId/1 returns the v1 document
 *     byte-identical to what boot A returned (immutability pin);
 *   - POST a third version → version 3 (monotonic across the restart),
 *     v1/v2 unchanged;
 *   - the audit log contains POLICY_VERSION_REGISTERED for all three.
 *
 * Versions are terminal records: there is no in-flight state to
 * demote on restart (unlike delegations, Batch 32) — rows hydrate
 * as-is.
 *
 * Boots dist/index.js, so this file runs after the server build.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = 'gov-policy-version-admin-xyz';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootRealServer(dbFile: string): Promise<{ child: ChildProcess; port: number }> {
  const port = 28_000 + Math.floor(Math.random() * 15_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKENS: 'admin:' + ADMIN,
    FACTORY_SECRETS_BACKEND: 'memory',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

type Rec = Record<string, unknown>;

describe('policy_versions survive restarts (§48.2, Batch 34)', () => {
  it('SIGKILL restart keeps versions, stays monotonic, keeps old versions immutable', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-pv-restart-'));
    const dbFile = join(dir, 'factory.db');

    const call = async (port: number, method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: 'Bearer ' + ADMIN,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: Rec = {};
      try {
        parsed = JSON.parse(text) as Rec;
      } catch {
        /* non-JSON */
      }
      return { status: res.status, body: parsed };
    };

    let boot1: { child: ChildProcess; port: number } | undefined;
    let boot2: { child: ChildProcess; port: number } | undefined;
    try {
      boot1 = await bootRealServer(dbFile);
      const p1 = boot1.port;

      const v1 = await call(p1, 'POST', '/api/policy/versions', {
        policy_id: 'deploy-authz',
        content: { rules: ['two-person-approve'] },
        created_by: 'owner',
      });
      assert.equal(v1.status, 201, JSON.stringify(v1.body).slice(0, 400));
      assert.equal((v1.body.version as Rec).version, 1);
      assert.equal((v1.body.version as Rec).status, 'CURRENT');
      const v2 = await call(p1, 'POST', '/api/policy/versions', {
        policy_id: 'deploy-authz',
        content: { rules: ['two-person-approve', 'change-freeze-fri'] },
        created_by: 'owner',
      });
      assert.equal(v2.status, 201);
      assert.equal((v2.body.version as Rec).version, 2);
      assert.equal((v2.body.version as Rec).status, 'CURRENT');

      // Pin the v1 snapshot AFTER v2 exists: status is derived, so v1
      // is SUPERSEDED from here on. The immutability pin is that this
      // exact snapshot never changes again — not even across SIGKILL.
      const v1Snap = await call(p1, 'GET', '/api/policy/versions/deploy-authz/1');
      assert.equal(v1Snap.status, 200);
      const v1Bytes = JSON.stringify(v1Snap.body.version);

      // SIGKILL — no graceful shutdown, no flush.
      boot1.child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 500));
      boot1 = undefined;

      boot2 = await bootRealServer(dbFile);
      const p2 = boot2.port;

      // History survives: newest-first, statuses derived.
      const hist = await call(p2, 'GET', '/api/policy/versions?policy_id=deploy-authz');
      assert.equal(hist.status, 200);
      const versions = hist.body.versions as Rec[];
      assert.equal(versions.length, 2);
      assert.deepEqual(
        versions.map((v) => [v.version, v.status]),
        [
          [2, 'CURRENT'],
          [1, 'SUPERSEDED'],
        ],
      );

      // v1 is byte-identical to what boot A returned — immutable.
      const got1 = await call(p2, 'GET', '/api/policy/versions/deploy-authz/1');
      assert.equal(got1.status, 200);
      assert.equal(JSON.stringify(got1.body.version), v1Bytes);
      const gotMissing = await call(p2, 'GET', '/api/policy/versions/deploy-authz/99');
      assert.equal(gotMissing.status, 404);

      // The sequence continues monotonically across the restart.
      const v3 = await call(p2, 'POST', '/api/policy/versions', {
        policy_id: 'deploy-authz',
        content: { rules: ['two-person-approve', 'change-freeze-fri', 'sbom-required'] },
        created_by: 'owner',
      });
      assert.equal(v3.status, 201);
      assert.equal((v3.body.version as Rec).version, 3);

      // Pin the v2 snapshot after v3 exists (v2 is SUPERSEDED from
      // here on — the derived-status transition is expected).
      const v2Snap = await call(p2, 'GET', '/api/policy/versions/deploy-authz/2');
      assert.equal(v2Snap.status, 200);
      const v2Bytes = JSON.stringify(v2Snap.body.version);

      // v1/v2 rows were not rewritten by the v3 publish.
      const got1b = await call(p2, 'GET', '/api/policy/versions/deploy-authz/1');
      assert.equal(JSON.stringify(got1b.body.version), v1Bytes);
      const got2b = await call(p2, 'GET', '/api/policy/versions/deploy-authz/2');
      assert.equal(JSON.stringify(got2b.body.version), v2Bytes);

      // Malformed bodies are 400, never 500.
      const bad = await call(p2, 'POST', '/api/policy/versions', { policy_id: '' });
      assert.equal(bad.status, 400);
      const bad2 = await call(p2, 'POST', '/api/policy/versions', {
        policy_id: 'x',
      });
      assert.equal(bad2.status, 400);

      // Audit chain carries all three registrations.
      const audit = await call(p2, 'GET', '/api/audit?limit=300');
      assert.equal(audit.status, 200);
      const records = ((audit.body.records ?? audit.body) as Rec[]);
      const registered = records.filter((e) => e.action === 'POLICY_VERSION_REGISTERED');
      assert.ok(
        registered.length >= 3,
        `expected >=3 POLICY_VERSION_REGISTERED, got ${registered.length}`,
      );
    } finally {
      if (boot1) boot1.child.kill('SIGKILL');
      if (boot2) boot2.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

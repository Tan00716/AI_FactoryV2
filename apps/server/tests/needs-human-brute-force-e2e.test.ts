/**
 * Batch 42 — §81 'security-issue' end-to-end on the REAL server binary.
 *
 * Boots dist/index.js (real HTTP, real auth gate, real SQLite
 * needs_human_upgrades table) and proves the full chain:
 *   10 × wrong Bearer → 401 → AUTH_DENIED audit → detector crosses →
 *   needsHuman('security-issue', …) row is OPEN and readable over
 *   GET /api/needs-human.
 *
 * NOTE on test design: every authenticated admin read in this test
 * comes from the same loopback IP as the attack, so each read clears
 * the source's counter (the documented "legit login clears" rule).
 * Phases are ordered so each phase's assertions hold under that rule:
 * attack batches always run back-to-back with no admin read between
 * them; reads happen once per phase, at the phase end.
 *
 * Also pins: single 401 → no row; dedup while OPEN; resolve →
 * next denial re-emits; a successful login clears the counter.
 *
 * Runs after the server build (imports ../dist/index.js).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = 'brute-force-e2e-admin-token';

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

describe('brute-force §81 emission on the real server (Batch 42)', () => {
  it('single 401 → nothing; 10 → one OPEN row; dedup; resolve → re-emit; login clears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-e2e-'));
    const { child, port } = await bootRealServer(join(dir, 'factory.db'));
    const base = `http://127.0.0.1:${port}`;
    const adminHeaders = { Authorization: `Bearer ${ADMIN}` };
    try {
      const bad = async () => {
        const r = await fetch(`${base}/api/tasks`, { headers: { Authorization: 'Bearer wrong-token' } });
        assert.equal(r.status, 401);
      };
      const badN = async (n: number) => {
        for (let i = 0; i < n; i++) await bad();
      };
      const openSecurityRows = async () => {
        const res = await fetch(`${base}/api/needs-human?status=open`, { headers: adminHeaders });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { items: Array<Record<string, unknown>> };
        return body.items.filter((r) => r['reason'] === 'security-issue');
      };
      const allSecurityRows = async () => {
        const res = await fetch(`${base}/api/needs-human`, { headers: adminHeaders });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { items: Array<Record<string, unknown>> };
        return body.items.filter((r) => r['reason'] === 'security-issue');
      };

      // Phase 1: a single 401 is not a signal.
      await badN(1);
      assert.equal((await openSecurityRows()).length, 0);

      // Phase 2: 10 back-to-back → the 10th crosses → one OPEN row.
      // (The phase-1 read cleared the counter; this batch restarts at 0.)
      await badN(10);
      let rows = await openSecurityRows();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]['severity'], 'critical');
      assert.equal(rows[0]['recipient'], null);
      assert.equal(rows[0]['requiredDeciderLevel'], 'admin');
      assert.match(String(rows[0]['source']), /^auth-bruteforce:/);
      const firstId = String(rows[0]['id']);

      // Phase 3: dedup — 10 more back-to-back cross again, but one is
      // already OPEN, so no second row.
      await badN(10);
      rows = await openSecurityRows();
      assert.equal(rows.length, 1);
      assert.equal(String(rows[0]['id']), firstId);

      // Phase 4: human resolves → the next denial re-emits.
      const resolveRes = await fetch(`${base}/api/needs-human/${firstId}/resolve`, {
        method: 'POST',
        headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution: 'resolved', resolvedBy: 'admin', note: 'rotated token' }),
      });
      assert.equal(resolveRes.status, 200);
      // The phase-3 read cleared the counter, so 10 back-to-back denials
      // are needed to cross again → re-emit with a new id.
      await badN(10);
      rows = await openSecurityRows();
      assert.equal(rows.length, 1);
      assert.notEqual(String(rows[0]['id']), firstId);
      assert.equal((await allSecurityRows()).length, 2);

      // Phase 5: resolve, then a successful login clears the counter —
      // 9 more wrong → still nothing (without the clear the counter
      // would sit ≥ 10 and emit).
      const secondId = String(rows[0]['id']);
      const resolve2 = await fetch(`${base}/api/needs-human/${secondId}/resolve`, {
        method: 'POST',
        headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution: 'resolved', resolvedBy: 'admin', note: 'phase 5' }),
      });
      assert.equal(resolve2.status, 200);
      const whoami = await fetch(`${base}/api/auth/whoami`, { headers: adminHeaders });
      assert.equal(whoami.status, 200);
      await badN(9);
      assert.equal((await openSecurityRows()).length, 0);
      // The read above cleared the counter again, so 10 back-to-back
      // denials are needed to cross once more.
      await badN(10);
      assert.equal((await openSecurityRows()).length, 1);
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

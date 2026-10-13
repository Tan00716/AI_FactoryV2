/**
 * Management reports survive restarts — SPEC v2 §14, §48.2 (Batch 34).
 *
 * Until Batch 34 the ReportLog was pure process memory in
 * @ai-factory/comms: a restart forgot every submitted report AND the
 * per-task sequence monotonicity guard. Now submits and decisions
 * write through to fdb.managementReports, and a restart:
 *   - keeps rows AS-IS: a SUBMITTED_FOR_REVIEW report still means
 *     "submitted, no decision recorded yet" (records, not
 *     executions — there is no liveness claim to demote, unlike
 *     delegations' ACTIVE or pipeline RUNNING);
 *   - rebuilds the per-task lastSequence guard, so a stale
 *     report_sequence is still rejected after reboot;
 *   - keeps terminal decisions (ACCEPTED/REJECTED/ESCALATED) intact;
 *   - still allows deciding a report that was pending at kill time.
 *
 * Pinned on the REAL server binary (boot → SIGKILL → reboot on the
 * same DB file). Server-side refs are all rejected (the server wires
 * no artifact/evidence existence checker), so submitted reports use
 * empty ref lists — any non-empty ref is rejected with
 * UNKNOWN_*_REF by design, unchanged by this batch.
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

const ADMIN = 'reports-restart-admin-xyz';

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

describe('management reports survive restarts (§14/§48.2, Batch 34)', () => {
  it('pending reports hydrate as-is; sequence guard rebuilt; decisions persist', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-reports-restart-'));
    const dbFile = join(dir, 'factory.db');

    const call = async (port: number, method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          'Authorization': 'Bearer ' + ADMIN,
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

    const report = (report_id: string, report_sequence: number, status = 'SUBMITTED_FOR_REVIEW') => ({
      schema_version: '2.0',
      report_id,
      task_id: 'task-alpha',
      requirement_version: 'REQ-1',
      run_id: 'run-1',
      report_sequence,
      status,
      work_completed: ['did the thing'],
      artifact_refs: [],
      evidence_refs: [],
      risks: [],
      blockers: [],
      decisions_needed: [],
      recommended_next_action: 'continue',
      self_assessed_confidence: 0.7,
    });

    let boot1: { child: ChildProcess; port: number } | undefined;
    let boot2: { child: ChildProcess; port: number } | undefined;
    try {
      // ---- boot A ----
      boot1 = await bootRealServer(dbFile);
      let r = await call(boot1.port, 'POST', '/api/reports/submit', report('rep-1', 1));
      assert.equal(r.status, 201);
      assert.equal((r.body['report'] as Rec)['report_id'], 'rep-1');

      r = await call(boot1.port, 'POST', '/api/reports/submit', report('rep-2', 2));
      assert.equal(r.status, 201);
      // decide rep-2 before the kill: terminal decision must survive
      r = await call(boot1.port, 'POST', '/api/reports/decide', {
        report_id: 'rep-2',
        decision: 'ACCEPTED',
        decided_by: 'mgr-1',
      });
      assert.equal(r.status, 200);
      assert.equal((r.body['report'] as Rec)['status'], 'ACCEPTED');

      // kill mid-pending: rep-1 is SUBMITTED_FOR_REVIEW when SIGKILL lands
      boot1.child.kill('SIGKILL');
      await new Promise((res) => boot1!.child.once('exit', res));
      boot1 = undefined;

      // ---- boot B on the same DB ----
      boot2 = await bootRealServer(dbFile);

      // the pending report hydrates AS-IS (not demoted, not fabricated)
      r = await call(boot2.port, 'GET', '/api/reports/rep-1');
      assert.equal(r.status, 200);
      assert.equal((r.body['report'] as Rec)['status'], 'SUBMITTED_FOR_REVIEW');
      assert.equal((r.body['report'] as Rec)['task_id'], 'task-alpha');

      // the terminal decision survived
      r = await call(boot2.port, 'GET', '/api/reports/rep-2');
      assert.equal(r.status, 200);
      assert.equal((r.body['report'] as Rec)['status'], 'ACCEPTED');

      // the per-task sequence guard was rebuilt: a stale sequence is
      // still rejected after reboot
      r = await call(boot2.port, 'POST', '/api/reports/submit', report('rep-stale', 1));
      assert.equal(r.status, 400);
      assert.equal(r.body['code'], 'STALE_SEQUENCE');

      // a newer sequence is accepted after reboot
      r = await call(boot2.port, 'POST', '/api/reports/submit', report('rep-3', 3));
      assert.equal(r.status, 201);

      // a report that was pending at kill time can still be decided
      r = await call(boot2.port, 'POST', '/api/reports/decide', {
        report_id: 'rep-1',
        decision: 'ESCALATED',
        decided_by: 'mgr-2',
      });
      assert.equal(r.status, 200);
      assert.equal((r.body['report'] as Rec)['status'], 'ESCALATED');

      // task listing is in sequence order
      r = await call(boot2.port, 'GET', '/api/reports?task_id=task-alpha');
      assert.equal(r.status, 200);
      const ids = ((r.body['reports'] as Rec[]) ?? []).map((x) => x['report_id']);
      assert.deepEqual(ids, ['rep-1', 'rep-2', 'rep-3']);

      // the audit chain saw the submit and the decision
      r = await call(boot2.port, 'GET', '/api/audit?limit=200');
      assert.equal(r.status, 200);
      const entries = (Array.isArray(r.body) ? r.body : []) as Rec[];
      assert.ok(
        entries.some((e) => e['action'] === 'REPORT_SUBMITTED' && e['entityId'] === 'rep-1'),
        'audit has REPORT_SUBMITTED for rep-1',
      );
      assert.ok(
        entries.some((e) => e['action'] === 'REPORT_DECIDED' && e['entityId'] === 'rep-2'),
        'audit has REPORT_DECIDED for rep-2',
      );
    } finally {
      if (boot1) boot1.child.kill('SIGKILL');
      if (boot2) boot2.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

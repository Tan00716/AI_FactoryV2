/**
 * Delegations + gates survive restarts — SPEC v2 §12.2, §39.3, §48.2 (Batch 32).
 *
 * Until Batch 32 the DelegationManager was pure process memory and
 * §39.3 gate definitions had nowhere to live at all: a restart forgot
 * every delegation and every definition. Now mutations write through
 * to fdb.delegations / fdb.gates, and a restart:
 *   - keeps DRAFT and COMPLETED delegations as-is;
 *   - demotes still-ACTIVE delegations to INTERRUPTED (write-back +
 *     DELEGATION_INTERRUPTED_ON_RESTART audit) — never presented as
 *     still supervised, never auto-resumed, never re-activated;
 *   - keeps gate definitions and the evaluation log as-is
 *     (evaluations are synchronous and terminal — no in-flight state).
 *
 * Pinned on the REAL server binary (boot → SIGKILL → reboot on the
 * same DB file):
 *   - boot A: create root delegation (DRAFT), activate it, create a
 *     child, complete the child; create a second root and activate it
 *     (stays ACTIVE at kill time); PUT a gate definition; evaluate it
 *     (caller-supplied evidence -> real verdict via the deterministic
 *     evaluator).
 *   - SIGKILL boot A, boot B on the same DB:
 *   - GET /api/delegations shows the DRAFT/COMPLETED rows unchanged
 *     and the killed-ACTIVE row as INTERRUPTED with the honest note;
 *   - POST /api/delegations/<interrupted>/complete -> 409
 *     DELEGATION_INTERRUPTED (history, never re-activated);
 *   - the gate definition and the evaluation are still readable;
 *   - a fresh delegation can be created post-restart (new id).
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

const ADMIN = 'gov-restart-admin-xyz';

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

describe('delegations + gates survive restarts (§12.2/§39.3, Batch 32)', () => {
  it('ACTIVE demotes to INTERRUPTED on restart; definitions and evaluations persist', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-gov-restart-'));
    const dbFile = join(dir, 'factory.db');
    const suffix = `${Date.now()}`;

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

    const newDelegation = (id: string, overrides: Rec = {}) => ({
      delegation_id: id,
      delegator: 'mgr',
      delegatee: 'worker',
      root_authorization_id: 'auth-1',
      task_id: 'task-1',
      requirement_version: 'REQ-1@1',
      scope: ['tool:shell'],
      budget_reservation: 10,
      ...overrides,
    });

    const gateDef = {
      mandatory_ac_ids: ['AC-1'],
      max_failed: 0,
      max_skipped: 0,
      require_independent_review: false,
      max_finding_severity: 'HIGH',
      freshness_ms: null,
    };

    const evidencePass = [
      {
        evidence_id: 'ev-1',
        requirement_version: 'REQ-1@1',
        ac_refs: ['AC-1'],
        task_id: 'task-1',
        run_id: 'run-1',
        candidate_revision: 'abc123',
        build_digest: null,
        test_definition_hash: null,
        environment_fingerprint: 'env-1',
        collector_identity: 'collector-1',
        started_at: '2026-10-13T09:00:00.000Z',
        ended_at: '2026-10-13T09:01:00.000Z',
        exit_code: 0,
        result_summary: { ac_results: [{ ac_id: 'AC-1', passed: true }] },
        raw_artifact_refs: [],
        content_hash: 'deadbeef',
        trust_level: 'HIGH',
        validity_state: 'ACTIVE',
      },
    ];

    let boot1: { child: ChildProcess; port: number } | undefined;
    let boot2: { child: ChildProcess; port: number } | undefined;
    try {
      boot1 = await bootRealServer(dbFile);
      const p1 = boot1.port;

      // Root delegation: DRAFT -> ACTIVE -> child -> complete child -> complete root.
      const root = await call(p1, 'POST', '/api/delegations', newDelegation(`root-${suffix}`));
      assert.equal(root.status, 201, JSON.stringify(root.body).slice(0, 400));
      const rootId = (root.body.delegation as Rec).delegation_id as string;
      const act = await call(p1, 'POST', `/api/delegations/${rootId}/activate`);
      assert.equal(act.status, 200);
      assert.equal((act.body.delegation as Rec).status, 'ACTIVE');

      // A rule violation must not reach the DB: over-budget child.
      const over = await call(p1, 'POST', `/api/delegations/${rootId}/children`, newDelegation(`over-${suffix}`, {
        budget_reservation: 9999,
      }));
      assert.equal(over.status, 409);
      assert.equal(over.body.code, 'BUDGET_EXCEEDED');

      const child = await call(p1, 'POST', `/api/delegations/${rootId}/children`, newDelegation(`child-${suffix}`, {
        scope: ['tool:shell'],
        budget_reservation: 4,
      }));
      assert.equal(child.status, 201, JSON.stringify(child.body).slice(0, 400));
      const childId = (child.body.delegation as Rec).delegation_id as string;
      const childAct = await call(p1, 'POST', `/api/delegations/${childId}/activate`);
      assert.equal(childAct.status, 200);
      const childDone = await call(p1, 'POST', `/api/delegations/${childId}/complete`);
      assert.equal(childDone.status, 200);
      assert.equal((childDone.body.delegation as Rec).status, 'COMPLETED');
      const rootDone = await call(p1, 'POST', `/api/delegations/${rootId}/complete`);
      assert.equal(rootDone.status, 200);
      assert.equal((rootDone.body.delegation as Rec).status, 'COMPLETED');

      // A second root left DRAFT (never started — no liveness claim).
      const draft = await call(p1, 'POST', '/api/delegations', newDelegation(`draft-${suffix}`));
      assert.equal(draft.status, 201);
      const draftId = (draft.body.delegation as Rec).delegation_id as string;

      // A third root, left ACTIVE at kill time.
      const doomed = await call(p1, 'POST', '/api/delegations', newDelegation(`doomed-${suffix}`));
      assert.equal(doomed.status, 201);
      const doomedId = (doomed.body.delegation as Rec).delegation_id as string;
      const doomedAct = await call(p1, 'POST', `/api/delegations/${doomedId}/activate`);
      assert.equal(doomedAct.status, 200);

      // Gate definition + a real evaluation over caller-supplied evidence.
      const put = await call(p1, 'PUT', `/api/gates/definitions/gate-${suffix}`, gateDef);
      assert.equal(put.status, 200, JSON.stringify(put.body).slice(0, 400));
      const ev = await call(p1, 'POST', `/api/gates/definitions/gate-${suffix}/evaluate`, {
        evidence: evidencePass,
      });
      assert.equal(ev.status, 200, JSON.stringify(ev.body).slice(0, 400));
      assert.equal((ev.body.evaluation as Rec).verdict, 'PASSED');
      assert.equal(ev.body.evidence_source, 'caller-supplied');
      const evalId = ev.body.evaluation_id as string;

      // A verdict in the request body is rejected (INV-04).
      const forged = await call(p1, 'POST', `/api/gates/definitions/gate-${suffix}/evaluate`, {
        verdict: 'PASSED',
        evidence: evidencePass,
      });
      assert.equal(forged.status, 400);

      // Kill boot A mid-life.
      boot1.child.kill('SIGKILL');
      boot1 = undefined;

      // Boot B on the same DB file.
      boot2 = await bootRealServer(dbFile);
      const p2 = boot2.port;

      const list = await call(p2, 'GET', '/api/delegations');
      assert.equal(list.status, 200);
      const live = list.body.delegations as Rec[];
      const interrupted = list.body.interrupted as Rec[];
      const liveIds = live.map((d) => d.delegation_id as string);
      assert.ok(liveIds.includes(rootId), 'COMPLETED root survives as live history');
      assert.ok(liveIds.includes(childId), 'COMPLETED child survives as live history');
      assert.ok(liveIds.includes(draftId), 'DRAFT survives as live (never started, still actionable)');
      assert.ok(!liveIds.includes(doomedId), 'killed-ACTIVE row is NOT presented as live');
      assert.equal(interrupted.length, 1, JSON.stringify(interrupted).slice(0, 400));
      assert.equal(interrupted[0].delegation_id, doomedId);
      assert.equal(interrupted[0].status, 'INTERRUPTED');
      assert.match(interrupted[0].note as string, /UNKNOWN/);

      // The surviving DRAFT is still actionable post-restart.
      const draftAct = await call(p2, 'POST', `/api/delegations/${draftId}/activate`);
      assert.equal(draftAct.status, 200);
      assert.equal((draftAct.body.delegation as Rec).status, 'ACTIVE');

      // Mutations on INTERRUPTED history are refused loudly.
      const revive = await call(p2, 'POST', `/api/delegations/${doomedId}/complete`);
      assert.equal(revive.status, 409);
      assert.equal(revive.body.code, 'DELEGATION_INTERRUPTED');

      // Gate definition and evaluation survived the restart.
      const gdef = await call(p2, 'GET', `/api/gates/definitions/gate-${suffix}`);
      assert.equal(gdef.status, 200);
      assert.deepEqual((gdef.body.definition as Rec).mandatory_ac_ids, ['AC-1']);
      const gevl = await call(p2, 'GET', `/api/gates/evaluations/${evalId}`);
      assert.equal(gevl.status, 200);
      assert.equal(gevl.body.verdict, 'PASSED');
      assert.equal(gevl.body.evidence_source, 'caller-supplied');

      // The mutations above are on the durable audit path: the
      // demotion wrote DELEGATION_INTERRUPTED_ON_RESTART, and the
      // gate evaluation wrote GATE_EVALUATED.
      const auditRes = await call(p2, 'GET', '/api/audit?limit=300');
      assert.equal(auditRes.status, 200);
      const records = (Array.isArray(auditRes.body) ? auditRes.body : auditRes.body.records) as Rec[];
      const actions = records.map((r) => r.action as string);
      assert.ok(actions.includes('DELEGATION_INTERRUPTED_ON_RESTART'), 'demotion audited');
      assert.ok(actions.includes('GATE_EVALUATED'), 'evaluation audited');
      assert.ok(actions.includes('DELEGATION_CREATED'), 'creation audited');
      const demotion = records.find((r) => r.action === 'DELEGATION_INTERRUPTED_ON_RESTART')!;
      assert.equal(demotion.entityId, doomedId);

      // A fresh delegation works post-restart (new id, not a resurrection).
      const fresh = await call(p2, 'POST', '/api/delegations', newDelegation(`fresh-${suffix}`));
      assert.equal(fresh.status, 201);
      assert.equal((fresh.body.delegation as Rec).status, 'DRAFT');
    } finally {
      boot1?.child.kill('SIGKILL');
      boot2?.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

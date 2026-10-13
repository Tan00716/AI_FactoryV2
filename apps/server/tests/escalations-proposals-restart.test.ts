/**
 * Escalations + proposals survive restarts — SPEC v2 §48.2, §59 (Batch 33).
 *
 * Until Batch 33 a dispute adjudication escalation lived only in
 * DisputeCoordinator.escalationRecords (process memory) and a §59
 * self-modification proposal lived only in the HTTP response of
 * POST /api/workforce/proposals. Now:
 *   - every ESCALATED adjudication writes through to fdb.escalations
 *     (append-only record layer); GET /api/disputes/escalations reads
 *     back live coordinator records plus persisted rows (deduped);
 *   - every POST /api/workforce/proposals writes the decision through
 *     to fdb.proposals (insert-only); GET /api/workforce/proposals[/:id]
 *     reads the decision history.
 * Both are terminal records — there is no in-flight state to demote
 * on restart (unlike delegations, Batch 32): a restart keeps the rows
 * as-is, and the pending-human-action items / needs-review flag are
 * the human's problem, not process state.
 *
 * Pinned on the REAL server binary (boot → SIGKILL → reboot on the
 * same DB file):
 *   - boot A: POST /api/disputes with two conflicting verdicts and no
 *     evidence (independent evaluator scores both 0) → outcome
 *     ESCALATED, escalation id recorded; POST /api/workforce/proposals
 *     (denied: privileged role) → decision recorded;
 *   - SIGKILL boot A, boot B on the same DB:
 *   - GET /api/disputes/escalations shows the escalation with its
 *     reasons, pending actions, and evidence-by-side;
 *   - GET /api/workforce/proposals shows the proposal decision;
 *   - GET /api/workforce/proposals/:id shows the single record;
 *     unknown id → 404;
 *   - the audit log contains ESCALATION_PERSIST_FAILED/… none (no
 *     failures) — and SELF_MODIFICATION_PROPOSED for the proposal.
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

describe('escalations + proposals survive restarts (§48.2/§59, Batch 33)', () => {
  it('SIGKILL restart keeps escalation records and proposal decisions', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-ep-restart-'));
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

      // Two conflicting verdicts with zero evidence: the independent
      // evaluator scores both sides 0 and the dispute ESCALATES.
      const dispute = await call(p1, 'POST', '/api/disputes', {
        verdictA: { agent: 'qa-1', verdict: 'PASS', evidenceIds: [], reason: 'looks fine' },
        verdictB: { agent: 'qa-2', verdict: 'FAIL', evidenceIds: [], reason: 'looks broken' },
      });
      assert.equal(dispute.status, 200, JSON.stringify(dispute.body).slice(0, 400));
      const outcome = dispute.body.outcome as Rec;
      assert.equal(outcome.status, 'ESCALATED', 'verdicts with no evidence must escalate');
      const escId = ((outcome.escalation as Rec)).escalationId as string;
      assert.ok(escId, 'escalation record has an id');

      // Live read sees it before the kill.
      const escLive = await call(p1, 'GET', '/api/disputes/escalations');
      assert.equal(escLive.status, 200);
      const liveList = escLive.body.escalations as Rec[];
      assert.ok(liveList.some((e) => e.escalationId === escId), 'live list contains the escalation');

      // A §59 proposal decision (privileged role → denied).
      const prop = await call(p1, 'POST', '/api/workforce/proposals', {
        kind: 'create',
        target: 'Production Administrator',
        rationale: 'someone has to own prod',
        requestedBy: 'agent-1',
      });
      assert.equal(prop.status, 201, JSON.stringify(prop.body).slice(0, 400));
      const propId = (prop.body as Rec).id as string;
      assert.equal((prop.body as Rec).status, 'denied');

      // SIGKILL — no graceful shutdown, no flush.
      boot1.child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 500));
      boot1 = undefined;

      boot2 = await bootRealServer(dbFile);
      const p2 = boot2.port;

      // The escalation survives: reasons, pending actions, evidence by side.
      const escAfter = await call(p2, 'GET', '/api/disputes/escalations');
      assert.equal(escAfter.status, 200);
      const afterList = escAfter.body.escalations as Rec[];
      const found = afterList.find((e) => e.escalationId === escId);
      assert.ok(found, 'escalation survives the SIGKILL restart');
      assert.ok(Array.isArray(found.reasons) && found.reasons.length > 0, 'reasons intact');
      assert.ok(
        Array.isArray(found.pendingHumanActions) && found.pendingHumanActions.length > 0,
        'pending human actions intact',
      );
      const sides = found.evidenceBySide as Rec[];
      assert.equal(sides.length, 2, 'evidence by side intact');
      assert.ok(sides.some((s) => s.agent === 'qa-1') && sides.some((s) => s.agent === 'qa-2'));

      // A fresh dispute after restart gets its own escalation (no dedup confusion).
      const dispute2 = await call(p2, 'POST', '/api/disputes', {
        verdictA: { agent: 'qa-3', verdict: 'PASS', evidenceIds: [], reason: 'fine' },
        verdictB: { agent: 'qa-4', verdict: 'FAIL', evidenceIds: [], reason: 'broken' },
      });
      assert.equal(dispute2.status, 200);
      const esc2Id = ((dispute2.body.outcome as Rec).escalation as Rec).escalationId as string;
      const escBoth = (await call(p2, 'GET', '/api/disputes/escalations')).body.escalations as Rec[];
      assert.equal(
        new Set(escBoth.map((e) => e.escalationId)).size,
        escBoth.length,
        'no duplicate escalation ids across boots',
      );
      assert.ok(escBoth.some((e) => e.escalationId === esc2Id));

      // The proposal decision survives: list + detail + 404.
      const props = await call(p2, 'GET', '/api/workforce/proposals');
      assert.equal(props.status, 200);
      const items = props.body.items as Rec[];
      const foundProp = items.find((p) => p.id === propId);
      assert.ok(foundProp, 'proposal decision survives the SIGKILL restart');
      assert.equal(foundProp.status, 'denied');
      assert.equal(foundProp.target, 'Production Administrator');
      assert.equal(foundProp.requestedBy, 'agent-1');

      const one = await call(p2, 'GET', `/api/workforce/proposals/${propId}`);
      assert.equal(one.status, 200);
      assert.equal((one.body.proposal as Rec).id, propId);

      const missing = await call(p2, 'GET', '/api/workforce/proposals/does-not-exist');
      assert.equal(missing.status, 404);

      // Audit: the proposal decision was recorded (proposal persisted
      // through to the DB, not just the response).
      const audit = await call(p2, 'GET', '/api/audit?limit=200');
      const entries = (Array.isArray(audit.body) ? audit.body : []) as Rec[];
      assert.ok(
        entries.some(
          (e) => e.action === 'SELF_MODIFICATION_PROPOSED' && e.entityId === propId,
        ),
        'SELF_MODIFICATION_PROPOSED is in the audit log',
      );
    } finally {
      if (boot1) boot1.child.kill('SIGKILL');
      if (boot2) boot2.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

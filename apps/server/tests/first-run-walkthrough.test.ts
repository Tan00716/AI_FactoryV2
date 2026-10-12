/**
 * First-run walkthrough e2e — sellable checklist A (Batch 11-1).
 *
 * Proves that a brand-new user, with no developer intervention and only
 * the HTTP API, can walk the core loop end to end:
 *
 *   health → project + agent + task → requirement v1 → evidence pinned
 *   to REQ@1 → requirement v2 → STALE denial → explicit §16 compatibility
 *   declaration → promotion allowed → production approval (human) →
 *   approval evidence → agent run with an allowlisted tool (echo really
 *   executes, intent lands EXECUTED in SQLite) → v2 stage walk to
 *   OUTCOME_VERIFICATION → DONE → final report whose counts match the
 *   script's own bookkeeping → restart over the same DB file: data,
 *   report counts, startup-scan audit and the §32 audit hash chain all
 *   still verify.
 *
 * Two honest findings are PINNED here, not worked around silently:
 *  F1. DONE is unreachable via POST /v2-transition — the v2 engine
 *      requires finalize() (§20.1) and no HTTP route exposes finalize /
 *      REQUEST_COMPLETE. The script asserts the 422 denial, then
 *      completes through the v1 transition endpoint (the Board's path),
 *      which is what a real user would fall back to.
 *  F2. The RequirementManager behind /api/requirements is an in-memory
 *      process singleton: requirement versions and compatibility
 *      declarations do NOT survive a restart. The script therefore does
 *      the whole requirement lifecycle inside the first boot; after the
 *      restart it asserts only DB-backed facts (projects / tasks /
 *      evidence / approvals / report). The step-7 stage walk runs on the
 *      second boot and deliberately registers its evidence WITHOUT
 *      requirement pins, so the lost declarations cannot re-block it —
 *      see docs/FIRST_RUN_WALKTHROUGH.md.
 *
 * Choreography: three boots of the real compiled server over ONE temp
 * DB file. Boot A (no tool allowlist) runs steps 1–5. Boot B
 * (FACTORY_RUNTIME_TOOLS=echo — an operator enabling tools restarts the
 * service) runs the agent run and the stage walk. Boot C is the plain
 * restart of step 8.
 *
 * Requires the workspace build (root `npm run build`): the server under
 * test is dist/index.js and the DB checks use the compiled @ai-factory/db
 * / @ai-factory/core packages — same precondition as
 * operations-startup.test.ts. Run via `npm run demo:e2e`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLog } from '@ai-factory/core';
import { FactoryDatabase } from '@ai-factory/db';

// ---------------------------------------------------------------- helpers --

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, never> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, never> = {};
  try {
    parsed = JSON.parse(text) as Record<string, never>;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: parsed };
}

interface BootedServer {
  child: ChildProcess;
  port: number;
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(
  dbFile: string,
  extraEnv: Record<string, string> = {},
): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    ...extraEnv,
  };
  delete env['FACTORY_API_TOKEN'];
  if (!('FACTORY_RUNTIME_TOOLS' in extraEnv)) delete env['FACTORY_RUNTIME_TOOLS'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function stopServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((r) => s.child.once('exit', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    s.child.kill('SIGKILL');
    await new Promise((r) => s.child.once('exit', r));
  }
}

async function waitForRun(port: number, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api(port, 'GET', `/api/runtime/runs/${runId}`);
    assert.equal(r.status, 200);
    const rec = r.body as unknown as {
      status: string;
      evidence: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    if (rec.status !== 'RUNNING') return rec;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in ${timeoutMs}ms`);
    await new Promise((res) => setTimeout(res, 150));
  }
}

// ------------------------------------------------------------------- test --

describe('first-run walkthrough (HTTP only, fresh DB)', () => {
  it('a new user walks the whole core loop and the data survives a restart', { timeout: 60_000 }, async () => {
    const startedAt = Date.now();
    const dir = mkdtempSync(join(tmpdir(), 'factory-walkthrough-'));
    const dbFile = join(dir, 'factory.db');
    let server: BootedServer | undefined;
    try {
      // ---------------------------------------------------------- boot A --
      server = await bootServer(dbFile);
      const port = server.port;

      // Step 1 — health, including the §28 startup-scan sections.
      const health = await api(port, 'GET', '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.body['ok'], true);
      const stepIntents = health.body['stepIntents'] as Record<string, unknown>;
      const operations = health.body['operations'] as Record<string, unknown>;
      assert.equal(stepIntents['store'], 'sqlite');
      assert.equal(stepIntents['interruptedAtStartup'], 0);
      assert.equal(operations['store'], 'sqlite');
      assert.equal(operations['unresolvedAtStartup'], 0);

      // Step 2 — project, agent, task.
      const project = await api(port, 'POST', '/api/projects', {
        name: 'Walkthrough Demo',
        description: 'first-run e2e',
      });
      assert.equal(project.status, 201);
      const projectId = project.body['id'] as string;
      assert.ok(projectId);

      const agent = await api(port, 'POST', '/api/agents', {
        name: 'walker',
        jobTitle: 'Engineer',
      });
      assert.equal(agent.status, 201);
      const agentId = agent.body['id'] as string;
      assert.ok(agentId);

      const task = await api(port, 'POST', '/api/tasks', {
        projectId,
        title: 'Ship the walkthrough feature',
        goal: 'prove the first-run loop',
      });
      assert.equal(task.status, 201);
      const taskId = task.body['id'] as string;
      assert.equal(task.body['status'], 'TODO');

      // Step 3 — requirement v1, plan evidence pinned to REQ@1, task
      // picks the requirement up (TODO → PLANNING under the @1 pin).
      const req = await api(port, 'POST', '/api/requirements', {
        id: 'REQ-001',
        businessGoal: 'ship the walkthrough feature',
        rationale: 'initial rationale',
        acceptanceCriteria: [
          {
            id: 'AC-001',
            description: 'the feature works end to end',
            verificationType: 'AUTOMATED_TEST',
            verifiedBy: 'INDEPENDENT_QA',
            expectedEvidence: 'qa_result with verdict PASS',
            applicableEnvironments: ['DEV'],
          },
        ],
        createdBy: 'human',
      });
      assert.equal(req.status, 201);

      const plan = await api(port, 'POST', `/api/tasks/${taskId}/evidence`, {
        type: 'plan',
        title: 'Implementation plan',
        payload: { summary: 'walk the v2 lifecycle' },
        createdBy: 'human',
        requirementId: 'REQ-001',
        requirementVersion: 1,
      });
      assert.equal(plan.status, 201);
      const planId = plan.body['id'] as string;
      assert.equal(plan.body['requirementVersion'], 'REQ-001@1');

      const toPlanning = await api(port, 'POST', `/api/tasks/${taskId}/v2-transition`, {
        toState: 'PLANNING',
        by: 'human',
        requirementVersion: 'REQ-001@1',
      });
      assert.equal(toPlanning.status, 200);
      assert.equal(
        (toPlanning.body['state'] as Record<string, unknown>)['stage'],
        'PLANNING',
      );

      // Step 4 — requirement moves to v2 (CORRECTION); the @1-pinned
      // plan is STALE under the @2 pin; an explicit §16 compatibility
      // declaration for v2 lets the same evidence through.
      const v2 = await api(port, 'POST', '/api/requirements/REQ-001/versions', {
        changeKind: 'CORRECTION',
        changeNote: 'fix rationale typo',
        createdBy: 'human',
        patch: { rationale: 'corrected rationale' },
      });
      assert.equal(v2.status, 201);
      assert.equal((v2.body['version'] as Record<string, unknown>)['version'], 2);

      const stale = await api(port, 'POST', `/api/tasks/${taskId}/v2-transition`, {
        toState: 'IN_PROGRESS',
        by: 'human',
        requirementVersion: 'REQ-001@2',
        budgetOk: true,
      });
      assert.equal(stale.status, 422);
      assert.equal(stale.body['ok'], false);
      assert.equal(stale.body['reasonCode'], 'STALE_EVIDENCE');
      const stillPlanning = await api(port, 'GET', `/api/tasks/${taskId}`);
      assert.equal(stillPlanning.body['status'], 'PLANNING');

      const compat = await api(port, 'POST', '/api/requirements/REQ-001/compatibility', {
        evidenceId: planId,
        requirementVersion: 2,
        compatible: true,
        basis: 'ACs unchanged by the v2 correction',
        checkedBy: 'human',
      });
      assert.equal(compat.status, 201);

      const promoted = await api(port, 'POST', `/api/tasks/${taskId}/v2-transition`, {
        toState: 'IN_PROGRESS',
        by: 'human',
        requirementVersion: 'REQ-001@2',
        budgetOk: true,
      });
      assert.equal(promoted.status, 200);
      assert.equal(
        (promoted.body['state'] as Record<string, unknown>)['stage'],
        'IN_PROGRESS',
      );

      // Step 5 — production approval: agent requests, human approves,
      // the decision attaches APPROVED 'approval' evidence to the task
      // (this evidence later satisfies the PENDING_PROD gate).
      const approvalReq = await api(port, 'POST', '/api/approvals', {
        action: 'deploy to production',
        requester: agentId,
        task_id: taskId,
        risk_level: 'HIGH',
        environment: 'prod',
        candidate_digest: 'cand-1',
      });
      assert.equal(approvalReq.status, 201);
      assert.equal(approvalReq.body['status'], 'PENDING');
      const approvalId = approvalReq.body['approval_id'] as string;
      assert.ok(approvalId);

      const decision = await api(port, 'POST', `/api/approvals/${approvalId}/decision`, {
        approved: true,
        decided_by: 'human',
        decision_reason: 'walkthrough approval',
      });
      assert.equal(decision.status, 200);
      assert.equal(
        (decision.body['approval'] as Record<string, unknown>)['status'],
        'APPROVED',
      );

      const evidenceAfterApproval = await api(port, 'GET', `/api/evidence?taskId=${taskId}`);
      assert.equal(evidenceAfterApproval.status, 200);
      const approvalEvidence = (
        evidenceAfterApproval.body as unknown as Array<{
          type: string;
          payload: Record<string, unknown>;
        }>
      ).find((e) => e.type === 'approval');
      assert.ok(approvalEvidence, 'an APPROVED decision attaches approval evidence');
      assert.equal(approvalEvidence.payload['verdict'], 'APPROVED');

      await stopServer(server);
      server = undefined;

      // ---------------------------------------------------------- boot B --
      // The operator enables the echo tool and restarts the service —
      // same DB file, FACTORY_RUNTIME_TOOLS=echo in the environment.
      server = await bootServer(dbFile, { FACTORY_RUNTIME_TOOLS: 'echo' });
      const portB = server.port;

      // Step 6 — a real agent run: echo actually executes through the
      // allowlist, its tool_result evidence lands on the run record.
      const run = await api(portB, 'POST', '/api/runtime/runs', {
        agentId,
        taskId,
        script: [
          { text: 'implementing', toolCalls: [{ tool: 'echo', args: { msg: 'walkthrough-echo' } }] },
          { text: 'verifying', toolCalls: [] },
        ],
      });
      assert.equal(run.status, 202);
      const runId = run.body['id'] as string;
      const finished = await waitForRun(portB, runId);
      assert.equal(finished.status, 'COMPLETED');
      const echoEvidence = finished.evidence.filter(
        (e) => e.type === 'tool_result' && e.payload['tool'] === 'echo',
      );
      assert.equal(echoEvidence.length, 1);
      assert.equal(echoEvidence[0].payload['ok'], true);

      // Step 7 — walk the v2 stages to DONE. Evidence registered here
      // carries NO requirement pin (see F2 in the header): it is never
      // judged stale, on any boot.
      const addEvidence = async (
        type: string,
        payload: Record<string, unknown>,
      ): Promise<string> => {
        const r = await api(portB, 'POST', `/api/tasks/${taskId}/evidence`, {
          type,
          title: `${type} (walkthrough)`,
          payload,
          createdBy: 'human',
        });
        assert.equal(r.status, 201, `evidence ${type}`);
        return r.body['id'] as string;
      };
      const advance = async (
        toState: string,
        extra: Record<string, unknown> = {},
      ): Promise<void> => {
        const r = await api(portB, 'POST', `/api/tasks/${taskId}/v2-transition`, {
          toState,
          by: 'human',
          requirementVersion: 'REQ-001@2',
          ...extra,
        });
        assert.equal(r.status, 200, `transition → ${toState}: ${JSON.stringify(r.body)}`);
        assert.equal((r.body['state'] as Record<string, unknown>)['stage'], toState);
      };

      await addEvidence('code_change', { sha: 'cand-1' });
      await advance('CODE_REVIEW', {
        candidateDigest: 'cand-1',
        confinementOk: true,
        leaseValid: true,
        leaseId: 'lease-walk-1',
        implementerId: agentId,
      });
      await addEvidence('code_review', { verdict: 'PASS' });
      // Review acceptance: the human acceptor is not the implementer.
      await advance('PENDING_QA', { implementerId: agentId });
      await advance('QA', { quotaOk: true });
      await addEvidence('ci_result', { verdict: 'PASS' });
      await addEvidence('qa_result', { verdict: 'PASS' });
      await addEvidence('security_report', { verdict: 'PASS' });
      await advance('PENDING_UAT_MERGE');
      await addEvidence('merge', { pr: 'PR-1' });
      await advance('UAT', { candidateDigest: 'cand-1' });
      await addEvidence('uat_result', { verdict: 'PASS' });
      await advance('PENDING_PROD');
      // The step-5 approval evidence satisfies the production gate.
      await advance('PROD_DEPLOYING');
      await addEvidence('deployment', { environment: 'prod', digest: 'cand-1' });
      await advance('PROD_VERIFICATION', { leaseValid: true, leaseId: 'lease-walk-2' });
      await addEvidence('smoke_test', { verdict: 'PASS' });
      await advance('OUTCOME_VERIFICATION');

      // F1 (pinned): DONE via the v2 endpoint is refused — finalize()
      // has no HTTP route. The denial is the documented behavior.
      const doneViaV2 = await api(portB, 'POST', `/api/tasks/${taskId}/v2-transition`, {
        toState: 'DONE',
        by: 'human',
        requirementVersion: 'REQ-001@2',
      });
      assert.equal(doneViaV2.status, 422);
      assert.equal(doneViaV2.body['reasonCode'], 'POLICY_DENIED');
      assert.ok(
        (doneViaV2.body['missing'] as string[]).some((m) => m.includes('finalize')),
        'the denial names the finalize() requirement',
      );

      // The user's working path: the v1 transition endpoint (the
      // Board's engine), which also seals the consumed smoke evidence.
      const doneViaV1 = await api(portB, 'POST', `/api/tasks/${taskId}/transition`, {
        to: 'DONE',
        actor: 'human',
      });
      assert.equal(doneViaV1.status, 200);
      const doneTask = await api(portB, 'GET', `/api/tasks/${taskId}`);
      assert.equal(doneTask.body['status'], 'DONE');

      const allEvidence = await api(portB, 'GET', `/api/evidence?taskId=${taskId}`);
      const evidenceRows = allEvidence.body as unknown as Array<{
        type: string;
        status: string;
        requirementVersion: string | null;
      }>;
      assert.equal(evidenceRows.length, 11);
      const smoke = evidenceRows.find((e) => e.type === 'smoke_test');
      assert.equal(smoke?.status, 'SEALED');
      assert.equal(
        evidenceRows.find((e) => e.type === 'plan')?.requirementVersion,
        'REQ-001@1',
      );

      // Final report: every count matches the script's own bookkeeping.
      const reportRes = await api(portB, 'GET', `/api/projects/${projectId}/final-report`);
      assert.equal(reportRes.status, 200);
      const report = reportRes.body['report'] as unknown as {
        extensions: {
          tasks: { total: number; byStatus: Record<string, number>; terminal: number; open: number };
          evidence: { total: number; sealed: number; withRequirementPin: number };
          approvals: { total: number; decisions: { approved: number; rejected: number; pending: number } };
          progress: {
            aocr: { ratePercent: number | null; authorizedTotal: number; authorizedCompleted: number };
          };
        };
        meta: { contentHash: string };
      };
      assert.equal(report.extensions.tasks.total, 1);
      assert.deepEqual(report.extensions.tasks.byStatus, { DONE: 1 });
      assert.equal(report.extensions.tasks.terminal, 1);
      assert.equal(report.extensions.tasks.open, 0);
      assert.equal(report.extensions.evidence.total, 11);
      assert.equal(report.extensions.evidence.sealed, 1);
      assert.equal(report.extensions.evidence.withRequirementPin, 1);
      assert.equal(report.extensions.approvals.total, 1);
      assert.deepEqual(report.extensions.approvals.decisions, {
        approved: 1,
        rejected: 0,
        pending: 0,
      });
      assert.equal(report.extensions.progress.aocr.authorizedTotal, 1);
      assert.equal(report.extensions.progress.aocr.authorizedCompleted, 1);
      assert.equal(report.extensions.progress.aocr.ratePercent, 100);
      assert.match(report.meta.contentHash, /^[0-9a-f]{64}$/);
      const countsBeforeRestart = {
        tasks: report.extensions.tasks.total,
        evidence: report.extensions.evidence.total,
        approvals: report.extensions.approvals.total,
        aocr: report.extensions.progress.aocr.ratePercent,
      };

      await stopServer(server);
      server = undefined;

      // Step 6 (durable half) — the echo intent is EXECUTED in SQLite,
      // readable from the file with no server running.
      const fdb = new FactoryDatabase(dbFile);
      try {
        const intents = fdb.stepIntents.listIntents();
        assert.equal(intents.length, 1);
        assert.equal(intents[0].tool, 'echo');
        assert.equal(intents[0].status, 'EXECUTED');
        assert.equal(typeof intents[0].resultHash, 'string');
        assert.equal(fdb.stepIntents.listInterrupted().length, 0);
        const chain = new AuditLog(fdb.audit).verify();
        assert.equal(chain.ok, true, `audit chain verifies: ${JSON.stringify(chain)}`);
        assert.ok(chain.verifiedCount > 0);
      } finally {
        fdb.close();
      }

      // ---------------------------------------------------------- boot C --
      // Step 8 — plain restart over the same DB file.
      server = await bootServer(dbFile);
      const portC = server.port;
      const healthC = await api(portC, 'GET', '/api/health');
      assert.equal(healthC.status, 200);
      assert.equal(
        (healthC.body['stepIntents'] as Record<string, unknown>)['interruptedAtStartup'],
        0,
      );

      const projectsC = await api(portC, 'GET', '/api/projects');
      assert.ok(
        (projectsC.body as unknown as Array<{ id: string }>).some((p) => p.id === projectId),
        'project survives the restart',
      );
      const taskC = await api(portC, 'GET', `/api/tasks/${taskId}`);
      assert.equal(taskC.body['status'], 'DONE');
      const evidenceC = await api(portC, 'GET', `/api/evidence?taskId=${taskId}`);
      const rowsC = evidenceC.body as unknown as Array<{
        type: string;
        status: string;
        requirementVersion: string | null;
      }>;
      assert.equal(rowsC.length, 11);
      assert.equal(rowsC.find((e) => e.type === 'plan')?.requirementVersion, 'REQ-001@1');
      assert.equal(rowsC.find((e) => e.type === 'smoke_test')?.status, 'SEALED');

      const reportC = await api(portC, 'GET', `/api/projects/${projectId}/final-report`);
      assert.equal(reportC.status, 200);
      const rc = reportC.body['report'] as unknown as typeof report;
      assert.equal(rc.extensions.tasks.total, countsBeforeRestart.tasks);
      assert.equal(rc.extensions.evidence.total, countsBeforeRestart.evidence);
      assert.equal(rc.extensions.approvals.total, countsBeforeRestart.approvals);
      assert.equal(rc.extensions.progress.aocr.ratePercent, countsBeforeRestart.aocr);
      // The hash identifies one generated instance (generatedAt is
      // hashed), so it legitimately differs across boots — presence and
      // shape are what carry over.
      assert.match(rc.meta.contentHash, /^[0-9a-f]{64}$/);

      const auditC = await api(portC, 'GET', '/api/audit?limit=500');
      assert.equal(auditC.status, 200);
      const actions = (auditC.body as unknown as Array<{ action: string }>).map((r) => r.action);
      assert.ok(actions.includes('STARTUP_INTERRUPTED_INTENTS'), 'startup scan audit exists');
      assert.ok(actions.includes('STARTUP_OPERATION_RECONCILE'), 'operation reconcile audit exists');
      assert.ok(actions.includes('FINAL_REPORT_GENERATED'), 'report generation is audited');

      await stopServer(server);
      server = undefined;

      // The §32 hash chain still verifies over the file after all three
      // boots (each boot appended its own startup records).
      const fdbAfter = new FactoryDatabase(dbFile);
      try {
        const chain = new AuditLog(fdbAfter.audit).verify();
        assert.equal(chain.ok, true, `audit chain verifies after restart: ${JSON.stringify(chain)}`);
        assert.ok(chain.verifiedCount > 0);
      } finally {
        fdbAfter.close();
      }

      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 30_000, `walkthrough took ${elapsedMs}ms (budget 30000ms)`);
    } finally {
      if (server) await stopServer(server).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Project archive write guard, second wave — Batch 14-5.
 *
 * Batch 14-2 guarded task creation, the task-scoped POSTs in index.ts
 * and project import (see project-archive.test.ts). This file pins the
 * same 409 { code: 'PROJECT_ARCHIVED', projectId } refusal on the
 * remaining task-scoped write surfaces, each with a no-side-effect
 * probe and an unarchive-recovery check:
 *
 *   - POST /api/runtime/runs                no run record is created
 *   - POST /api/tasks/:id/v2-transition     engine stage / DB row stay
 *   - POST /api/tasks/:id/v2-complete       no DONE, no final seal
 *   - POST /api/approvals (task-bound)      no approval is created
 *   - POST /api/approvals/:id/decision      approval stays PENDING
 *   - POST /api/approvals/:id/invalidate    approval stays PENDING
 *   - POST /api/approvals/:id/cancel        approval stays PENDING
 *   - POST /api/review (with taskId)        no evidence is sealed
 *   - POST /api/qa/runs                     no QA run record is created
 *
 * Real compiled server, one boot over a temp DB, FACTORY_RUNTIME_TOOLS
 * =echo so the recovery run really executes. Same precondition as
 * project-archive.test.ts: the workspace must be built (dist/index.js).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'archive-guards-test-token-0123456789';

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, never> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
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

async function bootServer(dbFile: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKEN: TOKEN,
    FACTORY_RUNTIME_TOOLS: 'echo',
  };
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

async function waitForRun(port: number, runId: string): Promise<Record<string, never>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const r = await api(port, 'GET', `/api/runtime/runs/${runId}`);
    assert.equal(r.status, 200);
    if (r.body['status'] !== 'RUNNING') return r.body;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in 30000ms`);
    await new Promise((res) => setTimeout(res, 150));
  }
}

function assertArchivedRefusal(r: { status: number; body: Record<string, never> }, pid: string): void {
  assert.equal(r.status, 409);
  assert.equal(r.body['code'], 'PROJECT_ARCHIVED');
  assert.equal(r.body['projectId'], pid);
  assert.equal(typeof r.body['error'], 'string');
}

describe('project archive guard — adjudication & execution surfaces (Batch 14-5)', () => {
  it('archived project refuses runs, v2 lifecycle, approvals, review and QA with no side effects; unarchive restores them', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-arch-guards-'));
    const dbFile = join(dir, 'factory.db');
    let server: BootedServer | undefined;
    try {
      server = await bootServer(dbFile);
      const port = server.port;

      // ---------------------------------------------------------- setup
      const p = await api(port, 'POST', '/api/projects', { name: 'GuardMe' });
      assert.equal(p.status, 201);
      const pid = p.body['id'] as unknown as string;

      const agent = await api(port, 'POST', '/api/agents', { name: 'guard-agent', jobTitle: 'Engineer' });
      assert.equal(agent.status, 201);
      const agentId = agent.body['id'] as unknown as string;

      const t = await api(port, 'POST', '/api/tasks', { projectId: pid, title: 'Guarded task' });
      assert.equal(t.status, 201);
      const tid = t.body['id'] as unknown as string;

      // Requirement + pinned plan evidence (the proven walkthrough
      // setup for a successful v2 transition).
      const req = await api(port, 'POST', '/api/requirements', {
        id: 'REQ-G1',
        businessGoal: 'prove the archive guard',
        rationale: 'initial rationale',
        acceptanceCriteria: [
          {
            id: 'AC-G1',
            description: 'guard works end to end',
            verificationType: 'AUTOMATED_TEST',
            verifiedBy: 'INDEPENDENT_QA',
            expectedEvidence: 'qa_result with verdict PASS',
            applicableEnvironments: ['DEV'],
          },
        ],
        createdBy: 'human',
      });
      assert.equal(req.status, 201);
      const plan = await api(port, 'POST', `/api/tasks/${tid}/evidence`, {
        type: 'plan',
        title: 'Implementation plan',
        payload: { summary: 'guard plan' },
        createdBy: 'human',
        requirementId: 'REQ-G1',
        requirementVersion: 1,
      });
      assert.equal(plan.status, 201);

      const runScript = [
        { text: 'acting', toolCalls: [{ tool: 'echo', args: { msg: 'hi' } }] },
        { text: 'verifying', toolCalls: [] },
      ];
      const reviewBody = {
        files: [{ path: 'a.ts', after: 'export const x = 1;\n' }],
        reviewerId: 'reviewer-1',
        reviewerRunId: 'review-run-1',
        implementerId: 'implementer-1',
        implementerRunId: 'implement-run-1',
        taskId: tid,
        actor: 'human',
      };
      const evidenceTotal = async (): Promise<number> => {
        const rep = await api(port, 'GET', `/api/projects/${pid}/final-report`);
        assert.equal(rep.status, 200);
        const report = rep.body['report'] as unknown as {
          extensions: { evidence: { total: number } };
        };
        return report.extensions.evidence.total;
      };
      const runtimeRunCount = async (): Promise<number> => {
        const list = await api(port, 'GET', '/api/runtime/runs');
        return (list.body['runs'] as unknown as unknown[]).length;
      };
      const qaRunCount = async (): Promise<number> => {
        const list = await api(port, 'GET', '/api/qa/runs');
        return (list.body['runs'] as unknown as unknown[]).length;
      };
      const approvalCount = async (): Promise<number> => {
        const list = await api(port, 'GET', '/api/approvals');
        return (list.body as unknown as unknown[]).length;
      };

      // ------------------------------------------- phase 1: all active
      const toPlanning = await api(port, 'POST', `/api/tasks/${tid}/v2-transition`, {
        toState: 'PLANNING',
        by: 'human',
        requirementVersion: 'REQ-G1@1',
      });
      assert.equal(toPlanning.status, 200);
      assert.equal((toPlanning.body['state'] as Record<string, unknown>)['stage'], 'PLANNING');

      const run1 = await api(port, 'POST', '/api/runtime/runs', { agentId, taskId: tid, script: runScript });
      assert.equal(run1.status, 202);
      const run1Done = await waitForRun(port, run1.body['id'] as unknown as string);
      assert.equal(run1Done['status'], 'COMPLETED');
      assert.equal(await runtimeRunCount(), 1);

      const a0 = await api(port, 'POST', '/api/approvals', {
        action: 'deploy to staging',
        requester: agentId,
        task_id: tid,
        risk_level: 'LOW',
      });
      assert.equal(a0.status, 201);
      const a0Decision = await api(port, 'POST', `/api/approvals/${a0.body['approval_id'] as unknown as string}/decision`, {
        approved: true,
        decided_by: 'human',
      });
      assert.equal(a0Decision.status, 200);

      const a1 = await api(port, 'POST', '/api/approvals', {
        action: 'deploy to production',
        requester: agentId,
        task_id: tid,
        risk_level: 'HIGH',
        environment: 'prod',
        candidate_digest: 'cand-1',
      });
      assert.equal(a1.status, 201);
      const a1Id = a1.body['approval_id'] as unknown as string;
      assert.equal(await approvalCount(), 2);

      const review1 = await api(port, 'POST', '/api/review', reviewBody);
      assert.equal(review1.status, 200);
      assert.ok(review1.body['evidenceId']);
      const evidenceAfterReview = await evidenceTotal();

      const qa1 = await api(port, 'POST', '/api/qa/runs', { taskId: tid });
      assert.equal(qa1.status, 200);
      assert.equal(await qaRunCount(), 1);
      const evidenceAfterQa = await evidenceTotal();

      // --------------------------------------------- phase 2: archived
      const arch = await api(port, 'POST', `/api/projects/${pid}/archive`, {});
      assert.equal(arch.status, 200);
      assert.equal(arch.body['changed'], true);

      // v2 transition: 409, engine stage and DB row unchanged.
      const v2t = await api(port, 'POST', `/api/tasks/${tid}/v2-transition`, {
        toState: 'IN_PROGRESS',
        by: 'human',
        requirementVersion: 'REQ-G1@1',
        budgetOk: true,
      });
      assertArchivedRefusal(v2t, pid);
      const stateAfter = await api(port, 'GET', `/api/tasks/${tid}/v2-state`);
      assert.equal(stateAfter.status, 200);
      assert.equal(stateAfter.body['stage'], 'PLANNING');
      assert.equal(stateAfter.body['finalSeal'], 0);
      assert.equal((await api(port, 'GET', `/api/tasks/${tid}`)).body['status'], 'PLANNING');

      // v2 complete: 409, still not DONE.
      const v2c = await api(port, 'POST', `/api/tasks/${tid}/v2-complete`, { by: 'human' });
      assertArchivedRefusal(v2c, pid);
      assert.equal((await api(port, 'GET', `/api/tasks/${tid}`)).body['status'], 'PLANNING');

      // Runtime run: 409, no run record created.
      const runArchived = await api(port, 'POST', '/api/runtime/runs', { agentId, taskId: tid, script: runScript });
      assertArchivedRefusal(runArchived, pid);
      assert.equal(await runtimeRunCount(), 1);

      // Approvals: create / decision / invalidate / cancel all 409,
      // nothing created, A1 stays PENDING.
      const aCreate = await api(port, 'POST', '/api/approvals', {
        action: 'deploy to production',
        requester: agentId,
        task_id: tid,
        risk_level: 'HIGH',
      });
      assertArchivedRefusal(aCreate, pid);
      assert.equal(await approvalCount(), 2);

      const aDecision = await api(port, 'POST', `/api/approvals/${a1Id}/decision`, {
        approved: true,
        decided_by: 'human',
      });
      assertArchivedRefusal(aDecision, pid);
      const aInvalidate = await api(port, 'POST', `/api/approvals/${a1Id}/invalidate`, {
        candidate_digest: 'cand-2',
      });
      assertArchivedRefusal(aInvalidate, pid);
      const aCancel = await api(port, 'POST', `/api/approvals/${a1Id}/cancel`, { by: 'human' });
      assertArchivedRefusal(aCancel, pid);
      const a1After = await api(port, 'GET', `/api/approvals/${a1Id}`);
      assert.equal(a1After.status, 200);
      assert.equal(a1After.body['status'], 'PENDING');

      // Review: 409, no evidence sealed.
      const reviewArchived = await api(port, 'POST', '/api/review', reviewBody);
      assertArchivedRefusal(reviewArchived, pid);
      assert.equal(await evidenceTotal(), evidenceAfterQa);

      // QA run: 409, no run record, no evidence.
      const qaArchived = await api(port, 'POST', '/api/qa/runs', { taskId: tid });
      assertArchivedRefusal(qaArchived, pid);
      assert.equal(await qaRunCount(), 1);
      assert.equal(await evidenceTotal(), evidenceAfterQa);
      assert.ok(evidenceAfterQa > evidenceAfterReview, 'phase-1 QA run added its evidence');

      // ------------------------------------------- phase 3: unarchived
      const un = await api(port, 'POST', `/api/projects/${pid}/unarchive`, {});
      assert.equal(un.status, 200);
      assert.equal(un.body['changed'], true);

      const v2t2 = await api(port, 'POST', `/api/tasks/${tid}/v2-transition`, {
        toState: 'IN_PROGRESS',
        by: 'human',
        requirementVersion: 'REQ-G1@1',
        budgetOk: true,
      });
      assert.equal(v2t2.status, 200);
      assert.equal((v2t2.body['state'] as Record<string, unknown>)['stage'], 'IN_PROGRESS');

      const run2 = await api(port, 'POST', '/api/runtime/runs', { agentId, taskId: tid, script: runScript });
      assert.equal(run2.status, 202);
      const run2Done = await waitForRun(port, run2.body['id'] as unknown as string);
      assert.equal(run2Done['status'], 'COMPLETED');
      assert.equal(await runtimeRunCount(), 2);

      const a1Decision = await api(port, 'POST', `/api/approvals/${a1Id}/decision`, {
        approved: true,
        decided_by: 'human',
      });
      assert.equal(a1Decision.status, 200);
      assert.equal(
        (a1Decision.body['approval'] as Record<string, unknown>)['status'],
        'APPROVED',
      );

      const review2 = await api(port, 'POST', '/api/review', reviewBody);
      assert.equal(review2.status, 200);
      assert.ok(review2.body['evidenceId']);
      assert.ok((await evidenceTotal()) > evidenceAfterQa);

      const qa2 = await api(port, 'POST', '/api/qa/runs', { taskId: tid });
      assert.equal(qa2.status, 200);
      assert.equal(await qaRunCount(), 2);

      await stopServer(server);
      server = undefined;
    } finally {
      if (server) await stopServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

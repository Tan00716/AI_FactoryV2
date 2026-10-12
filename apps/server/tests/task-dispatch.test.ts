/**
 * §17.2 Human Dispatch — HTTP surface (Batch 17).
 *
 * Pins, on the real compiled server over one temp DB:
 *  - POST /api/tasks accepts authorizationStatus DRAFT /
 *    WAITING_HUMAN_DISPATCH / AUTHORIZED (anything else → 400); absent
 *    the field the task is AUTHORIZED and NO dispatch audit event is
 *    recorded (the legacy create path), while an explicit AUTHORIZED
 *    records TASK_DISPATCHED via CREATE (§17.2: manual creation may
 *    dispatch at creation, forming an audit event).
 *  - The dispatch endpoints walk the spec chain with one audit event
 *    per action: request-dispatch (DRAFT → WAITING), reject-dispatch
 *    (WAITING → DRAFT), dispatch (WAITING → AUTHORIZED, optionally
 *    assigning the executor), revoke-authorization (→ REVOKED),
 *    expire-authorization (→ EXPIRED). Illegal moves → 409
 *    TASK_AUTHORIZATION_STATE with the observed state; unknown task
 *    → 404.
 *  - via=POLICY dispatch requires policyRuleId (§17.2: a
 *    pre-authorization records its triggering policy and Rule ID) and
 *    its audit actor defaults to 'policy' — it never masquerades as a
 *    human click.
 *  - POST /api/runtime/runs refuses any non-AUTHORIZED task with 403
 *    TASK_NOT_AUTHORIZED and creates no run record; after dispatch
 *    the same task runs to completion.
 *
 * Same precondition as the other real-server suites: the workspace
 * must be built (dist/index.js).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'dispatch-test-token-0123456789';

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

const ECHO_SCRIPT = [
  { text: 'acting', toolCalls: [{ tool: 'echo', args: { msg: 'hello' } }] },
  { text: 'verifying', toolCalls: [] },
];

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

interface AuditRow {
  actor: string;
  action: string;
  entityId: string;
  details: Record<string, unknown>;
}

async function auditFor(port: number, taskId: string): Promise<AuditRow[]> {
  const res = await api(port, 'GET', '/api/audit?limit=500');
  assert.equal(res.status, 200);
  return (res.body as unknown as AuditRow[]).filter((r) => r.entityId === taskId);
}

describe('§17.2 Human Dispatch — HTTP flow (Batch 17)', () => {
  it('full chain: DRAFT held from execution → submit → reject → submit → dispatch → run → revoke', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-dispatch-'));
    const dbFile = join(dir, 'factory.db');
    let server: BootedServer | undefined;
    try {
      server = await bootServer(dbFile);
      const port = server.port;

      const project = await api(port, 'POST', '/api/projects', {
        name: 'Dispatch Demo',
        description: 'batch 17',
      });
      assert.equal(project.status, 201);
      const pid = project.body['id'] as string;
      const agent = await api(port, 'POST', '/api/agents', {
        name: 'dispatcher-target',
        jobTitle: 'Engineer',
      });
      assert.equal(agent.status, 201);
      const agentId = agent.body['id'] as string;

      // -- Compat: no authorizationStatus field → AUTHORIZED, runs, and
      //    no dispatch audit event (the legacy create path).
      const legacy = await api(port, 'POST', '/api/tasks', {
        projectId: pid,
        title: 'Legacy task',
        goal: 'created the way every existing caller creates tasks',
      });
      assert.equal(legacy.status, 201);
      const legacyId = legacy.body['id'] as string;
      assert.equal(legacy.body['authorizationStatus'], 'AUTHORIZED');
      const legacyRun = await api(port, 'POST', '/api/runtime/runs', {
        agentId,
        taskId: legacyId,
        script: ECHO_SCRIPT,
      });
      assert.equal(legacyRun.status, 202);
      assert.equal((await waitForRun(port, legacyRun.body['id'] as string))['status'], 'COMPLETED');
      assert.ok(
        !(await auditFor(port, legacyId)).some((r) => r.action === 'TASK_DISPATCHED'),
        'legacy create must not record a dispatch event',
      );

      // -- Explicit AUTHORIZED at creation = create-and-dispatch:
      //    §17.2 wants the dispatch itself on the audit record.
      const direct = await api(port, 'POST', '/api/tasks', {
        projectId: pid,
        title: 'Created and dispatched',
        authorizationStatus: 'AUTHORIZED',
      });
      assert.equal(direct.status, 201);
      const directDispatch = (await auditFor(port, direct.body['id'] as string)).find(
        (r) => r.action === 'TASK_DISPATCHED',
      );
      assert.ok(directDispatch);
      assert.equal(directDispatch.details['via'], 'CREATE');

      // -- Create-time validation: REVOKED is not a creatable state.
      const badCreate = await api(port, 'POST', '/api/tasks', {
        projectId: pid,
        title: 'Nope',
        authorizationStatus: 'REVOKED',
      });
      assert.equal(badCreate.status, 400);

      // -- The DRAFT chain.
      const draft = await api(port, 'POST', '/api/tasks', {
        projectId: pid,
        title: 'Needs a human dispatch',
        authorizationStatus: 'DRAFT',
      });
      assert.equal(draft.status, 201);
      const tid = draft.body['id'] as string;
      assert.equal(draft.body['authorizationStatus'], 'DRAFT');

      const tryRun = () =>
        api(port, 'POST', '/api/runtime/runs', { agentId, taskId: tid, script: ECHO_SCRIPT });

      // DRAFT: execution refused, no run record left behind.
      const refused1 = await tryRun();
      assert.equal(refused1.status, 403);
      assert.equal(refused1.body['code'], 'TASK_NOT_AUTHORIZED');
      assert.equal(refused1.body['authorizationStatus'], 'DRAFT');
      const runsNow = await api(port, 'GET', '/api/runtime/runs');
      assert.equal(
        (runsNow.body['runs'] as unknown as { taskId: string }[]).filter((r) => r.taskId === tid)
          .length,
        0,
      );

      // Dispatch before submission is an illegal move: 409 with state.
      const earlyDispatch = await api(port, 'POST', `/api/tasks/${tid}/dispatch`, {});
      assert.equal(earlyDispatch.status, 409);
      assert.equal(earlyDispatch.body['code'], 'TASK_AUTHORIZATION_STATE');
      assert.equal(earlyDispatch.body['authorizationStatus'], 'DRAFT');

      // Submit → WAITING; still not executable.
      const submitted = await api(port, 'POST', `/api/tasks/${tid}/request-dispatch`, {});
      assert.equal(submitted.status, 200);
      assert.equal(submitted.body['from'], 'DRAFT');
      assert.equal(submitted.body['to'], 'WAITING_HUMAN_DISPATCH');
      const refused2 = await tryRun();
      assert.equal(refused2.status, 403);
      assert.equal(refused2.body['authorizationStatus'], 'WAITING_HUMAN_DISPATCH');

      // Rejection returns it to DRAFT.
      const rejected = await api(port, 'POST', `/api/tasks/${tid}/reject-dispatch`, {
        reason: 'needs a clearer goal',
      });
      assert.equal(rejected.status, 200);
      assert.equal(rejected.body['to'], 'DRAFT');

      // Resubmit, then dispatch with an assignee.
      await api(port, 'POST', `/api/tasks/${tid}/request-dispatch`, {});
      const dispatched = await api(port, 'POST', `/api/tasks/${tid}/dispatch`, {
        assigneeAgentId: agentId,
      });
      assert.equal(dispatched.status, 200);
      assert.equal(dispatched.body['to'], 'AUTHORIZED');
      const taskAfter = await api(port, 'GET', `/api/tasks/${tid}`);
      assert.equal(taskAfter.body['authorizationStatus'], 'AUTHORIZED');
      assert.equal(taskAfter.body['currentAgentId'], agentId);

      // Now the same task runs to completion.
      const run = await tryRun();
      assert.equal(run.status, 202);
      assert.equal((await waitForRun(port, run.body['id'] as string))['status'], 'COMPLETED');

      // Revoke → execution refused again.
      const revoked = await api(port, 'POST', `/api/tasks/${tid}/revoke-authorization`, {
        reason: 'scope withdrawn',
      });
      assert.equal(revoked.status, 200);
      assert.equal(revoked.body['to'], 'REVOKED');
      const refused3 = await tryRun();
      assert.equal(refused3.status, 403);
      assert.equal(refused3.body['authorizationStatus'], 'REVOKED');

      // The audit trail tells the whole story, one event per action.
      const actions = (await auditFor(port, tid)).map((r) => r.action);
      assert.deepEqual(
        actions.filter((a) => a.startsWith('TASK_DISPATCH') || a.startsWith('TASK_AUTHORIZATION')),
        [
          'TASK_AUTHORIZATION_REVOKED',
          'TASK_DISPATCHED',
          'TASK_DISPATCH_REQUESTED',
          'TASK_DISPATCH_REJECTED',
          'TASK_DISPATCH_REQUESTED',
        ],
      );
      const dispatchRow = (await auditFor(port, tid)).find((r) => r.action === 'TASK_DISPATCHED');
      assert.equal(dispatchRow?.details['via'], 'HUMAN');
      assert.equal(dispatchRow?.details['assigneeAgentId'], agentId);

      // -- POLICY pre-authorization: Rule ID required, actor is policy.
      const aiTask = await api(port, 'POST', '/api/tasks', {
        projectId: pid,
        title: 'AI-discovered problem',
        authorizationStatus: 'WAITING_HUMAN_DISPATCH',
      });
      assert.equal(aiTask.status, 201);
      const aiId = aiTask.body['id'] as string;
      const noRule = await api(port, 'POST', `/api/tasks/${aiId}/dispatch`, { via: 'POLICY' });
      assert.equal(noRule.status, 400);
      const policyDispatch = await api(port, 'POST', `/api/tasks/${aiId}/dispatch`, {
        via: 'POLICY',
        policyRuleId: 'RULE-7',
      });
      assert.equal(policyDispatch.status, 200);
      const policyRow = (await auditFor(port, aiId)).find((r) => r.action === 'TASK_DISPATCHED');
      assert.equal(policyRow?.actor, 'policy');
      assert.equal(policyRow?.details['via'], 'POLICY');
      assert.equal(policyRow?.details['policyRuleId'], 'RULE-7');

      // Expire → terminal refusal.
      const expired = await api(port, 'POST', `/api/tasks/${aiId}/expire-authorization`, {});
      assert.equal(expired.status, 200);
      assert.equal(expired.body['to'], 'EXPIRED');
      const refused4 = await api(port, 'POST', '/api/runtime/runs', {
        agentId,
        taskId: aiId,
        script: ECHO_SCRIPT,
      });
      assert.equal(refused4.status, 403);
      assert.equal(refused4.body['authorizationStatus'], 'EXPIRED');

      // Unknown task → 404.
      const ghost = await api(port, 'POST', '/api/tasks/no-such-task/dispatch', {});
      assert.equal(ghost.status, 404);
    } finally {
      if (server) await stopServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

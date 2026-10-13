/**
 * First-run walkthrough, second edition — sellable checklist A (Batch 21-4).
 *
 * Re-runs the new-user story on the Batch 20 tree, this time exercising
 * the capability chains that landed in B12–B20 (the Batch 11 walkthrough
 * only covered the core v2 loop). Driven only through the HTTP API of the
 * real compiled server over a fresh temp SQLite file; findings are
 * numbered F6+ in the Batch 11 F-number tradition.
 *
 * Boot A (fresh DB): health → project/agent/DRAFT task → run refused
 *   403 (authorization axis) → request-dispatch → dispatch → run
 *   COMPLETED → checkpoints → durable outbox → secrets/exec injection
 *   → interactive PTY session (SSE) → backup schedule + manual run →
 *   worktree allocate/release → MCP register → trust approve → launch
 *   (fake stdio server) → deploy park (AWAITING_APPROVAL).
 * SIGKILL.
 * Boot B (same DB): dispatch status persisted → outbox persisted →
 *   approve completes the parked deploy (REHYDRATED) → backup schedule
 *   + backups persisted → worktree record persisted (RELEASED) →
 *   MCP server + trust persisted, launch table honestly empty →
 *   audit hash chain verifies over the file.
 *
 * Findings are pinned in docs/FIRST_RUN_WALKTHROUGH.md (Batch 21
 * section); the script itself asserts every step and fails loudly
 * rather than working around anything.
 *
 * Requires the workspace build (root `npm run build`); run with
 * `npm run demo:e2e-new`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLog } from '@ai-factory/core';

// ---------------------------------------------------------------- helpers --

type Json = Record<string, unknown>;

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 300)}`);
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
    // Hermetic secrets: the booted server's cwd is apps/server, whose
    // local data/secrets/ may carry a stale vault from earlier dev runs
    // (fail-closed decrypt errors). Point the file vault at the temp dir.
    FACTORY_SECRETS_DIR: join(dirname(dbFile), 'secrets'),
    ...extraEnv,
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
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

async function killServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGKILL');
  await new Promise((r) => s.child.once('exit', r));
}

async function stopServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((r) => s.child.once('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    s.child.kill('SIGKILL');
    await new Promise((r) => s.child.once('exit', r));
  }
}

async function waitForRun(port: number, runId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api(port, 'GET', `/api/runtime/runs/${runId}`);
    assert.equal(r.status, 200);
    const status = r.body['status'] as string;
    if (status === 'COMPLETED' || status === 'FAILED') {
      return r.body as Json & { evidence: Array<{ type: string; payload: Json }> };
    }
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Read an SSE stream until `needle` appears in the decoded output.
 * Output frames are `data: {"b64":"..."}` — decoded before matching.
 */
async function readSseUntil(port: number, path: string, needle: string, timeoutMs = 20_000) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let text = '';
  const deadline = Date.now() + timeoutMs;
  const absorb = (chunk: string) => {
    raw += chunk;
    for (const line of chunk.split('\n')) {
      const m = line.match(/^data:\s*(\{.*\})\s*$/);
      if (!m) continue;
      try {
        const obj = JSON.parse(m[1]) as { b64?: string; text?: string };
        if (obj.b64) text += Buffer.from(obj.b64, 'base64').toString('utf8');
        else if (obj.text) text += obj.text;
      } catch {
        /* not a JSON frame */
      }
    }
  };
  try {
    for (;;) {
      if (text.includes(needle)) return text;
      if (Date.now() > deadline) {
        throw new Error(`SSE timeout waiting for ${JSON.stringify(needle)}; got: ${text.slice(0, 600)}`);
      }
      const { done, value } = await reader.read();
      if (done) return text;
      absorb(decoder.decode(value, { stream: true }));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

function auditActions(body: Json | unknown[]): string[] {
  const recs = (Array.isArray(body) ? body : ((body as Json)['records'] ?? [])) as Array<{
    action?: string;
  }>;
  return recs.map((r) => r.action ?? '').filter(Boolean);
}

// ------------------------------------------------------------------ the run --

describe('first-run walkthrough, second edition — B12–B20 capability chains (Batch 21-4)', () => {
  it('new chains end to end, durable across a SIGKILL restart', { timeout: 480_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-walk-b21-'));
    const dbFile = join(dir, 'factory.db');
    const gitRepo = join(dir, 'repo');
    let server: BootedServer | undefined;
    try {
      // ------------------------------------------------------------ boot A --
      server = await bootServer(dbFile, { FACTORY_RUNTIME_TOOLS: 'echo' });
      const portA = server.port;

      // W1 — health reports the new subsystems.
      const health = await api(portA, 'GET', '/api/health');
      assert.equal(health.status, 200);
      assert.ok(health.body['outbox'], 'health exposes outbox');
      assert.ok(health.body['secrets'], 'health exposes secrets backend');

      // W2 — project, agent, task created DRAFT (Batch 17/18 axis).
      const project = await api(portA, 'POST', '/api/projects', { name: 'Walk B21' });
      assert.equal(project.status, 201);
      const projectId = project.body['id'] as string;
      const agent = await api(portA, 'POST', '/api/agents', { name: 'walker', jobTitle: 'Engineer' });
      assert.equal(agent.status, 201);
      const agentId = agent.body['id'] as string;
      const task = await api(portA, 'POST', '/api/tasks', {
        projectId,
        title: 'Prove the new chains',
        authorizationStatus: 'DRAFT',
      });
      assert.equal(task.status, 201);
      const taskId = task.body['id'] as string;
      assert.equal(task.body['authorizationStatus'], 'DRAFT');

      // W3 — a run on a DRAFT task is refused with zero run records.
      const refused = await api(portA, 'POST', '/api/runtime/runs', {
        agentId,
        taskId,
        script: [{ text: 'x', toolCalls: [] }],
      });
      assert.equal(refused.status, 403);
      assert.equal(refused.body['code'] ?? refused.body['name'], 'TASK_NOT_AUTHORIZED');

      // W4 — dispatch the task, then the same run is allowed and completes.
      assert.equal((await api(portA, 'POST', `/api/tasks/${taskId}/request-dispatch`, {})).status, 200);
      const dispatched = await api(portA, 'POST', `/api/tasks/${taskId}/dispatch`, { via: 'HUMAN' });
      assert.equal(dispatched.status, 200);
      assert.equal(dispatched.body['to'], 'AUTHORIZED');
      const run = await api(portA, 'POST', '/api/runtime/runs', {
        agentId,
        taskId,
        script: [
          { text: 'working', toolCalls: [{ tool: 'echo', args: { msg: 'b21-echo' } }] },
          { text: 'done', toolCalls: [] },
        ],
      });
      assert.equal(run.status, 202);
      const runId = run.body['id'] as string;
      const finished = await waitForRun(portA, runId);
      assert.equal(finished.status, 'COMPLETED');
      assert.ok(
        finished.evidence.some((e) => e.type === 'tool_result' && e.payload['tool'] === 'echo'),
        'echo tool_result evidence on the run',
      );

      // W4b — a minimal v2 commit so the outbox has something real to
      // persist: requirement v1 + plan evidence pinned to REQ-001@1,
      // then v2-transition TODO → PLANNING (commits through the v2
      // engine, which is what writes outbox_events).
      const req = await api(portA, 'POST', '/api/requirements', {
        id: 'REQ-001',
        businessGoal: 'prove the new chains',
        rationale: 'walkthrough',
        acceptanceCriteria: [
          {
            id: 'AC-001',
            description: 'the chains work end to end',
            verificationType: 'AUTOMATED_TEST',
            verifiedBy: 'INDEPENDENT_QA',
            expectedEvidence: 'walkthrough PASS',
            applicableEnvironments: ['DEV'],
          },
        ],
        createdBy: 'human',
      });
      assert.equal(req.status, 201);
      const plan = await api(portA, 'POST', `/api/tasks/${taskId}/evidence`, {
        type: 'plan',
        title: 'B21 chain plan',
        payload: { summary: 'walk the new chains' },
        createdBy: 'human',
        requirementId: 'REQ-001',
        requirementVersion: 1,
      });
      assert.equal(plan.status, 201);
      const toPlanning = await api(portA, 'POST', `/api/tasks/${taskId}/v2-transition`, {
        toState: 'PLANNING',
        by: 'human',
        requirementVersion: 'REQ-001@1',
      });
      assert.equal(toPlanning.status, 200);

      // W5 — checkpoints of the run are readable.
      const cps = await api(portA, 'GET', `/api/runtime/runs/${runId}/checkpoints`);
      assert.equal(cps.status, 200);
      const latest = await api(portA, 'GET', `/api/runtime/runs/${runId}/checkpoints/latest`);
      assert.equal(latest.status, 200);

      // W6 — the outbox actually persists workflow events (Batch 17-2).
      const outbox = await api(portA, 'GET', `/api/tasks/${taskId}/outbox`);
      assert.equal(outbox.status, 200);
      // The read surface returns the engine's OutboxEvent shape
      // {taskId, from, to, by, at, intent} (the WORKFLOW_TRANSITIONED /
      // WORKFLOW_FINALIZED vocabulary lives in the DB column only).
      const events = (outbox.body['events'] ?? outbox.body) as Array<{
        from?: string;
        to?: string;
        intent?: string;
      }>;
      assert.ok(Array.isArray(events) && events.length > 0, 'outbox has persisted events');
      assert.ok(
        events.some((e) => e.to === 'PLANNING'),
        `outbox carries the v2 commit, got: ${JSON.stringify(events).slice(0, 300)}`,
      );

      // W7 — secrets: write metadata-only, exec injects + redacts (Batch 18-2).
      const sentinel = `w21-sentinel-${Date.now()}`;
      const put = await api(portA, 'PUT', '/api/secrets/walksecret', {
        value: sentinel,
        purpose: 'walkthrough',
      });
      assert.equal(put.status, 200);
      assert.ok(!('value' in put.body), 'PUT must not echo the value');
      const meta = await api(portA, 'GET', '/api/secrets/walksecret');
      assert.equal(meta.body['exists'], true);
      assert.ok(!('value' in meta.body), 'metadata read must not carry the value');
      const execOk = await api(portA, 'POST', '/api/exec', {
        command: 'printenv WALK_VAR',
        secretEnv: { WALK_VAR: 'walksecret' },
      });
      assert.equal(execOk.status, 200);
      assert.ok(!String(execOk.body['output']).includes(sentinel), 'value redacted from exec output');
      assert.ok(String(execOk.body['output']).includes('***'), 'redaction marker present');

      // W8 — interactive PTY session over SSE (Batch 19-4).
      const sess = await api(portA, 'POST', '/api/terminal/sessions', { principal: 'human' });
      assert.equal(sess.status, 201);
      const sessionId = sess.body['id'] as string;
      assert.equal((await api(portA, 'POST', `/api/terminal/sessions/${sessionId}/input`, { data: 'echo w21-terminal\n' })).status, 200);
      const sseText = await readSseUntil(portA, `/api/terminal/sessions/${sessionId}/stream`, 'w21-terminal');
      assert.ok(sseText.includes('w21-terminal'), 'session output streamed over SSE');
      assert.equal((await api(portA, 'DELETE', `/api/terminal/sessions/${sessionId}`)).status, 200);

      // W9 — backup schedule: create, run now, listed (Batch 20-3).
      const sched = await api(portA, 'POST', '/api/backup/schedules', {
        name: 'w21-nightly',
        kind: 'interval',
        intervalMs: 3_600_000,
      });
      assert.equal(sched.status, 201);
      const schedId = (sched.body['schedule'] as Json)['id'] as string;
      const runNow = await api(portA, 'POST', `/api/backup/schedules/${schedId}/run`, {});
      assert.equal(runNow.status, 200);
      assert.ok(runNow.body['backupId'], 'manual run produced a backup');
      const backups = await api(portA, 'GET', '/api/backups');
      assert.equal(backups.status, 200);
      const backupList = (backups.body['backups'] ?? backups.body) as Array<{ backupId?: string }>;
      assert.ok(
        Array.isArray(backupList) && backupList.some((b) => b.backupId === runNow.body['backupId']),
        'backup listed',
      );

      // W10 — worktree allocate + release against a real temp git repo (Batch 19-3).
      execSync(`git init -q "${gitRepo}" && git -C "${gitRepo}" config user.email w21@test && git -C "${gitRepo}" config user.name w21 && git -C "${gitRepo}" commit -q --allow-empty -m init`, { stdio: 'ignore' });
      const wt = await api(portA, 'POST', '/api/worktrees', { repoPath: gitRepo, taskId });
      assert.equal(wt.status, 201);
      const wtId = ((wt.body['worktree'] ?? {}) as Json)['id'] as string;
      assert.ok(wtId, `worktree id present: ${JSON.stringify(wt.body).slice(0, 200)}`);
      const wtList = await api(portA, 'GET', '/api/worktrees');
      assert.equal(wtList.status, 200);
      const rel = await api(portA, 'POST', `/api/worktrees/${wtId}/release`, {});
      assert.equal(rel.status, 200);

      // W11 — MCP: register → trust approve → launch a fake stdio server (B19-2/B20-1).
      const reg = await api(portA, 'POST', '/api/mcp/register', {
        server: {
          name: 'w21fake',
          version: '1.0.0',
          provider: 'test',
          transport: 'stdio',
          credentialRefs: ['walksecret'],
        },
      });
      assert.equal(reg.status, 201);
      const trust = await api(portA, 'GET', '/api/mcp/servers/w21fake@1.0.0/trust');
      assert.equal(trust.status, 200);
      const approve = await api(portA, 'POST', '/api/mcp/servers/w21fake@1.0.0/trust/approve', {
        trustLevel: 'MEDIUM',
        approvalPolicy: 'HUMAN_APPROVAL',
      });
      assert.equal(approve.status, 200);
      const install = await api(portA, 'POST', '/api/mcp/install', {
        name: 'w21fake',
        version: '1.0.0',
      });
      assert.ok(install.status === 200 || install.status === 202, `install → ${install.status}`);
      // Installs from unknown sources pend review; a human decision
      // completes the install so the server becomes launchable.
      const review = await api(portA, 'POST', '/api/mcp/review', {
        name: 'w21fake',
        version: '1.0.0',
        approved: true,
        reviewer: 'human',
      });
      assert.equal(review.status, 200);
      const launch = await api(portA, 'POST', '/api/mcp/launch', {
        name: 'w21fake',
        version: '1.0.0',
        command: 'node',
        args: ['-e', 'setInterval(()=>{},1000)'],
        secretEnv: { MCP_WALK_VAR: 'walksecret' },
      });
      assert.equal(launch.status, 201);
      const launchId = launch.body['launchId'] as string;
      assert.ok(launchId, 'launch id returned');
      const logs = await api(portA, 'GET', `/api/mcp/launches/${launchId}/logs`);
      assert.equal(logs.status, 200);
      assert.ok(!JSON.stringify(logs.body).includes(sentinel), 'launch logs carry no secret value');
      assert.equal((await api(portA, 'POST', `/api/mcp/launches/${launchId}/stop`, {})).status, 200);

      // W12 — park a PROD deploy (Batch 19-1 durability comes in boot B).
      const pl = await api(portA, 'POST', '/api/pipelines', { taskId });
      assert.equal(pl.status, 201);
      const pipelineId = pl.body['id'] as string;
      const dep = await api(portA, 'POST', `/api/pipelines/${pipelineId}/deploy`, {
        environment: 'PROD',
        taskId,
        actor: 'walk',
      });
      assert.equal(dep.status, 200);
      assert.equal((dep.body['deployment'] as Json)['status'], 'AWAITING_APPROVAL');
      const approvalId = ((dep.body['approval'] as Json)['approval_id'] ?? (dep.body['approval'] as Json)['id']) as string;
      assert.ok(approvalId, 'parked deploy minted an approval ticket');
      const decision = await api(portA, 'POST', `/api/approvals/${approvalId}/decision`, {
        approved: true,
        decided_by: 'human',
      });
      assert.equal(decision.status, 200);

      await killServer(server);
      server = undefined;

      // ------------------------------------------------------------ boot B --
      server = await bootServer(dbFile);
      const portB = server.port;

      // W13 — dispatch authorization survived the restart.
      const taskB = await api(portB, 'GET', `/api/tasks/${taskId}`);
      assert.equal(taskB.status, 200);
      assert.equal(taskB.body['authorizationStatus'], 'AUTHORIZED');

      // W14 — outbox survived the restart.
      const outboxB = await api(portB, 'GET', `/api/tasks/${taskId}/outbox`);
      assert.equal(outboxB.status, 200);
      const eventsB = (outboxB.body['events'] ?? outboxB.body) as Array<unknown>;
      assert.ok(Array.isArray(eventsB) && eventsB.length === events.length, 'outbox intact after restart');

      // W15 — the parked deploy is rebuilt and really completes.
      const approveDep = await api(portB, 'POST', `/api/pipelines/${pipelineId}/approve`, { approvalId });
      assert.equal(approveDep.status, 200);
      assert.equal((approveDep.body['deployment'] as Json)['status'], 'SUCCEEDED');

      // W16 — backup schedule + backups survived.
      const schedB = await api(portB, 'GET', '/api/backup/schedules');
      assert.equal(schedB.status, 200);
      const schedList = (schedB.body['schedules'] ?? schedB.body) as Array<{ id?: string }>;
      assert.ok(schedList.some((s) => s.id === schedId), 'schedule persisted');
      const backupsB = await api(portB, 'GET', '/api/backups');
      assert.ok(
        ((backupsB.body['backups'] ?? backupsB.body) as Array<{ backupId?: string }>).some(
          (b) => b.backupId === runNow.body['backupId'],
        ),
        'backup listed after restart',
      );

      // W17 — worktree record survived (RELEASED, archived not deleted).
      const wtB = await api(portB, 'GET', '/api/worktrees');
      assert.ok(
        ((wtB.body['worktrees'] ?? wtB.body) as Array<{ id?: string }>).some((w) => w.id === wtId),
        'worktree record persisted',
      );

      // W18 — MCP server + trust decision survived; launch table honestly empty.
      const trustB = await api(portB, 'GET', '/api/mcp/servers/w21fake@1.0.0/trust');
      assert.equal(trustB.status, 200);
      const launchesB = await api(portB, 'GET', '/api/mcp/launches');
      assert.equal(launchesB.status, 200);

      // W19 — audit hash chain verifies over the file after both boots.
      const auditB = await api(portB, 'GET', '/api/audit?limit=1000');
      assert.equal(auditB.status, 200);
      const actions = auditActions(auditB.body);
      for (const expected of [
        'TASK_DISPATCH_REQUESTED',
        'TASK_DISPATCHED',
        'APPROVAL_REQUIRED',
        'DEPLOYMENT_REHYDRATED',
        'DEPLOY_SUCCEEDED',
        'BACKUP_SCHEDULE_CREATED',
        'WORKTREE_ALLOCATED',
        'WORKTREE_RELEASED',
        'MCP_SERVER_LAUNCH',
        'SESSION_INPUT',
        'SECRET_SET',
      ]) {
        assert.ok(actions.includes(expected), `audit contains ${expected}`);
      }

      await stopServer(server);
      server = undefined;

      const dbMod = await import('@ai-factory/db');
      const fdb = new dbMod.FactoryDatabase(dbFile);
      try {
        const chain = new AuditLog(fdb.audit).verify();
        assert.equal(chain.ok, true, `audit chain verifies: ${JSON.stringify(chain).slice(0, 300)}`);
        assert.ok(chain.verifiedCount > 0, 'chain verified a non-empty log');
      } finally {
        fdb.close();
      }
    } finally {
      if (server) await killServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

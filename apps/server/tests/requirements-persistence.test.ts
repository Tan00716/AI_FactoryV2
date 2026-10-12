/**
 * Requirements persistence — first-run walkthrough F2 regression.
 *
 * F2: the RequirementManager behind /api/requirements was an in-memory
 * process singleton. After a restart the requirement versions were
 * gone — registering evidence with a requirement pin 400'd ("unknown
 * requirement version") and a task caught mid-STALE-gate could only
 * proceed after an operator recreated the requirement, its versions,
 * and the §16 compatibility declarations in the new process.
 *
 * This test pins the fix end to end over real HTTP, three boots of the
 * compiled server over ONE temp DB file:
 *
 *   Boot A — build the trap: requirement v1, evidence pinned to @1,
 *   task walks to PLANNING under the @1 pin, requirement bumps to v2,
 *   impact analysis suspends the task's promotion (hold), the @2
 *   transition is refused STALE_EVIDENCE, and a compatibility
 *   declaration for the pinned evidence is recorded — but the task is
 *   NOT advanced. The server stops with the task mid-STALE-gate.
 *   Boot B — plain restart: the requirement and both versions are
 *   still there, the hold still gates promotion, registering evidence
 *   pinned to @2 succeeds (F2's 400), and the stored compatibility
 *   declaration releases the STALE gate — the task advances with no
 *   recreation of anything. The hold is then released.
 *   Boot C — one more restart: the release persisted too.
 *
 * Requires the workspace build (root `npm run build`): the server
 * under test is dist/index.js — same precondition as
 * first-run-walkthrough.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function bootServer(dbFile: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), DB_PATH: dbFile };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_RUNTIME_TOOLS'];
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

// ------------------------------------------------------------------- test --

describe('requirements persistence (F2: manager state survives restarts)', () => {
  it('a task caught mid-STALE-gate proceeds after a restart with nothing recreated', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-req-persist-'));
    const dbFile = join(dir, 'factory.db');
    let server: BootedServer | undefined;
    try {
      // ---------------------------------------------------------- boot A --
      server = await bootServer(dbFile);
      const port = server.port;

      const health = await api(port, 'GET', '/api/health');
      assert.equal(health.status, 200);
      const reqHealth = health.body['requirements'] as Record<string, unknown>;
      assert.equal(reqHealth['store'], 'sqlite');
      assert.equal(reqHealth['stored'], 0);

      const project = await api(port, 'POST', '/api/projects', {
        name: 'F2 Regression',
        description: 'requirements persistence',
      });
      assert.equal(project.status, 201);
      const task = await api(port, 'POST', '/api/tasks', {
        projectId: project.body['id'] as string,
        title: 'Caught mid-STALE-gate',
        goal: 'prove F2 is fixed',
      });
      assert.equal(task.status, 201);
      const taskId = task.body['id'] as string;

      const req = await api(port, 'POST', '/api/requirements', {
        id: 'REQ-001',
        businessGoal: 'ship the feature',
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
        payload: { summary: 'pinned to REQ@1' },
        createdBy: 'human',
        requirementId: 'REQ-001',
        requirementVersion: 1,
      });
      assert.equal(plan.status, 201);
      const planId = plan.body['id'] as string;

      const links = await api(port, 'POST', '/api/requirements/REQ-001/links', {
        version: 1,
        taskIds: [taskId],
        evidenceIds: [planId],
      });
      assert.equal(links.status, 200);

      const toPlanning = await api(port, 'POST', `/api/tasks/${taskId}/v2-transition`, {
        toState: 'PLANNING',
        by: 'human',
        requirementVersion: 'REQ-001@1',
      });
      assert.equal(toPlanning.status, 200);

      const v2 = await api(port, 'POST', '/api/requirements/REQ-001/versions', {
        changeKind: 'CORRECTION',
        changeNote: 'fix rationale typo',
        createdBy: 'human',
        patch: { rationale: 'corrected rationale' },
      });
      assert.equal(v2.status, 201);

      // Impact analysis suspends the linked task's promotion (§16 G-05).
      const impact = await api(port, 'POST', '/api/requirements/REQ-001/impact', {
        fromVersion: 1,
        toVersion: 2,
        by: 'human',
      });
      assert.equal(impact.status, 200);
      const holds = (impact.body['impact'] as { suspendedPromotions: Array<{ id: string }> })
        .suspendedPromotions;
      assert.equal(holds.length, 1);
      const holdId = holds[0]!.id;

      const held = await api(port, 'POST', '/api/requirements/promotion-check', { taskId });
      assert.equal(held.status, 409);

      // The trap springs: under the @2 pin the @1-pinned plan is STALE.
      const stale = await api(port, 'POST', `/api/tasks/${taskId}/v2-transition`, {
        toState: 'IN_PROGRESS',
        by: 'human',
        requirementVersion: 'REQ-001@2',
        budgetOk: true,
      });
      assert.equal(stale.status, 422);
      assert.equal(stale.body['reasonCode'], 'STALE_EVIDENCE');

      // The operator records the §16 compatibility declaration — and
      // then the process stops, task still mid-gate.
      const compat = await api(port, 'POST', '/api/requirements/REQ-001/compatibility', {
        evidenceId: planId,
        requirementVersion: 2,
        compatible: true,
        basis: 'ACs unchanged by the v2 correction',
        checkedBy: 'human',
      });
      assert.equal(compat.status, 201);

      await stopServer(server);
      server = undefined;

      // ---------------------------------------------------------- boot B --
      server = await bootServer(dbFile);
      const portB = server.port;

      const healthB = await api(portB, 'GET', '/api/health');
      assert.equal(
        (healthB.body['requirements'] as Record<string, unknown>)['stored'],
        1,
        'the requirement itself survived the restart',
      );

      // Versions are back — the read F2 lost (404 before the fix).
      const reqB = await api(portB, 'GET', '/api/requirements/REQ-001');
      assert.equal(reqB.status, 200);
      const versions = (reqB.body['requirement'] as { versions: Array<{ version: number }> })
        .versions;
      assert.equal(versions.length, 2);
      const v1B = await api(portB, 'GET', '/api/requirements/REQ-001/versions/1');
      assert.equal(v1B.status, 200);
      assert.equal((v1B.body['version'] as { rationale: string }).rationale, 'initial rationale');

      // The promotion hold survived, still active, still gating.
      const holdsB = await api(portB, 'GET', `/api/requirements/holds?taskId=${taskId}`);
      assert.equal(holdsB.status, 200);
      const holdRows = holdsB.body['holds'] as unknown as Array<{
        id: string;
        releasedAt: string | null;
      }>;
      assert.equal(holdRows.length, 1);
      assert.equal(holdRows[0]!.id, holdId);
      assert.equal(holdRows[0]!.releasedAt, null);
      const heldB = await api(portB, 'POST', '/api/requirements/promotion-check', { taskId });
      assert.equal(heldB.status, 409);

      // F2's headline failure: registering evidence with a pin 400'd
      // after a restart ("unknown requirement version"). Now it lands.
      const pinned = await api(portB, 'POST', `/api/tasks/${taskId}/evidence`, {
        type: 'code_change',
        title: 'Implementation under v2',
        payload: { sha: 'cand-2' },
        createdBy: 'human',
        requirementId: 'REQ-001',
        requirementVersion: 2,
      });
      assert.equal(pinned.status, 201);
      assert.equal(pinned.body['requirementVersion'], 'REQ-001@2');

      // The stored compatibility declaration releases the STALE gate:
      // the task advances with nothing recreated by hand.
      const promoted = await api(portB, 'POST', `/api/tasks/${taskId}/v2-transition`, {
        toState: 'IN_PROGRESS',
        by: 'human',
        requirementVersion: 'REQ-001@2',
        budgetOk: true,
      });
      assert.equal(promoted.status, 200, `transition after restart: ${JSON.stringify(promoted.body)}`);
      assert.equal(
        (promoted.body['state'] as Record<string, unknown>)['stage'],
        'IN_PROGRESS',
      );

      // Release the hold in this process — the release must persist too.
      const released = await api(portB, 'POST', `/api/requirements/holds/${holdId}/release`, {
        by: 'human',
        revalidationNote: 're-validated after restart',
      });
      assert.equal(released.status, 200);
      const allowedB = await api(portB, 'POST', '/api/requirements/promotion-check', { taskId });
      assert.equal(allowedB.status, 200);

      await stopServer(server);
      server = undefined;

      // ---------------------------------------------------------- boot C --
      server = await bootServer(dbFile);
      const portC = server.port;
      const allowedC = await api(portC, 'POST', '/api/requirements/promotion-check', { taskId });
      assert.equal(allowedC.status, 200, 'the boot-B hold release persisted');
      const reqC = await api(portC, 'GET', '/api/requirements/REQ-001');
      assert.equal(reqC.status, 200);
      assert.equal(
        (reqC.body['requirement'] as { versions: unknown[] }).versions.length,
        2,
      );

      await stopServer(server);
      server = undefined;
    } finally {
      if (server) await stopServer(server).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

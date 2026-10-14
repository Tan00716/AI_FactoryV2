/**
 * First-run walkthrough, ninth edition — §81 needsHuman full-trigger sweep
 * (Batch 50-2).
 *
 * Fires all eight §81 triggers against the real compiled server over a fresh
 * temp SQLite file, pure HTTP, zero mocks, and asserts each one leaves an
 * OPEN needs-human record whose detailJson.narrative carries the honest
 * qualifier (the F19/Batch-45 persistence contract).
 *
 * Honest scope note: seven triggers fire deterministically over HTTP. The
 * eighth — 'irrecoverable-env-error' — does NOT: this server's HTTP surface
 * has no input that can put a stagnation signature into ENV_ERROR_CODES
 * (Batch 44/45 honest boundary: the default stepFn masks tool FactoryError
 * codes to tool:<name>:fail, only echo/add are registered, StubAdapter never
 * throws, assertSandboxAvailable has zero callers; the narrow Batch-45
 * passthrough only makes the emission reachable at the tool layer in
 * principle). That leg asserts the negative boundary instead: a non-env
 * stagnation emits exactly one 'repeated-failure' and zero
 * 'irrecoverable-env-error' records. Faking a positive path would be
 * dishonest — see finding F28 in docs/FIRST_RUN_WALKTHROUGH.md.
 *
 * The walk runs in AUTH mode (FACTORY_API_TOKENS) so the brute-force leg
 * (10 × wrong Bearer → 401) is reachable; every other call carries the
 * admin Bearer. The 10 bad requests run back-to-back with no successful
 * admin read between them (a successful login clears the source counter).
 *
 * Requires the workspace build (root `npm run build`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = 'needshuman-walk-admin-token';

type Json = Record<string, unknown>;

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
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

async function bootServer(dbFile: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKENS: `admin:${ADMIN}`,
    // Hermetic secrets: point the file vault at a temp dir so the walk
    // never inherits the developer's local (git-ignored) vault.
    FACTORY_SECRETS_DIR: join(tmpdir(), `factory-walk-nh-secrets-${port}`),
  };
  delete env['FACTORY_API_TOKEN'];
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

function stopServer(s: BootedServer): Promise<void> {
  return new Promise((resolve) => {
    s.child.once('exit', () => resolve());
    s.child.kill('SIGTERM');
    setTimeout(() => {
      try {
        s.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, 5_000).unref();
  });
}

async function openNeedsHuman(port: number): Promise<Array<Json>> {
  const r = await api(port, 'GET', '/api/needs-human?status=open');
  assert.equal(r.status, 200);
  return (r.body['items'] ?? []) as Array<Json>;
}

function narrativeOf(row: Json): string {
  const detail = JSON.parse(String(row['detailJson'] ?? '{}')) as Json;
  return String(detail['narrative'] ?? '');
}

async function waitForRun(port: number, runId: string): Promise<Json> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const r = await api(port, 'GET', `/api/runtime/runs/${runId}`);
    assert.equal(r.status, 200);
    if (r.body['status'] !== 'RUNNING') return r.body;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in 60000ms`);
    await new Promise((r2) => setTimeout(r2, 200));
  }
}

// ------------------------------------------------------------------ the walk --

describe('first-run walkthrough, ninth edition — §81 full-trigger sweep (Batch 50-2)', () => {
  it('all eight §81 triggers: seven fire over HTTP, env-error holds its honest negative boundary', { timeout: 600_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-walk-nh-'));
    const dbFile = join(dir, 'factory.db');
    let server: BootedServer | undefined;
    try {
      server = await bootServer(dbFile);
      const port = server.port;
      const base = `http://127.0.0.1:${port}`;

      // ------------------------------------------------- S1 security-issue --
      // Batch 42: 10 × wrong Bearer (back-to-back, no successful admin read
      // between them — a successful login clears the source counter).
      for (let i = 0; i < 10; i++) {
        const r = await fetch(`${base}/api/tasks`, {
          headers: { Authorization: 'Bearer wrong-token' },
        });
        assert.equal(r.status, 401, `wrong bearer attempt ${i + 1} → 401`);
      }
      let upgrades = await openNeedsHuman(port);
      let rows = upgrades.filter((u) => u['reason'] === 'security-issue');
      assert.equal(rows.length, 1, 'exactly one OPEN security-issue after 10 × 401');
      assert.match(String(rows[0]!['source']), /^auth-bruteforce:/);
      assert.ok(
        narrativeOf(rows[0]!).includes('counting fact'),
        'honest qualifier survives: a counting fact, not a heuristic classification',
      );
      t.diagnostic('S1 security-issue: 10 × 401 → 1 OPEN, counting-fact narrative in place');

      // ------------------------------------------------ policy-violation --
      // Batch 41: the same granter's empty-taskScope denials hit the
      // threshold (3) → one OPEN record; single denials never emit.
      const granter = 'walk-granter-nh';
      for (let i = 0; i < 3; i++) {
        const r = await api(port, 'POST', '/api/workforce/employees', {
          jobTitle: 'Walk NH Engineer',
          requestedBy: granter,
          taskScope: [],
        });
        assert.equal(r.status, 403, `empty task scope denial ${i + 1} → 403`);
      }
      upgrades = await openNeedsHuman(port);
      rows = upgrades.filter((u) => u['reason'] === 'policy-violation');
      assert.equal(rows.length, 1, 'exactly one OPEN policy-violation after 3 denials');
      assert.equal(rows[0]!['source'], `policy-denial:${granter}`);
      assert.ok(
        narrativeOf(rows[0]!).includes('The policy held on every attempt'),
        'honest qualifier survives: the policy held, no elevation occurred',
      );
      t.diagnostic('S2 policy-violation: 3 × 403 → 1 OPEN, honest narrative in place');

      // ------------------------------------------ requirement-ambiguity --
      // Batch 42: three consecutive AC refinements → the clarification
      // path is not converging → one OPEN record.
      const reqId = 'REQ-WALK-NH-AMB';
      const ac = [
        {
          id: 'AC-001',
          description: 'the thing works',
          verificationType: 'AUTOMATED_TEST',
          verifiedBy: 'INDEPENDENT_QA',
          expectedEvidence: 'qa_result with verdict PASS',
          applicableEnvironments: ['DEV'],
        },
      ];
      const cr = await api(port, 'POST', '/api/requirements', {
        id: reqId,
        businessGoal: 'ship the thing',
        acceptanceCriteria: ac,
      });
      assert.equal(cr.status, 201, 'requirement created');
      for (const note of ['one', 'two', 'three']) {
        const r = await api(port, 'POST', `/api/requirements/${reqId}/ac-refinement`, {
          acId: 'AC-001',
          patch: { description: `clarified: ${note}` },
          by: 'agent:pm-1',
        });
        assert.equal(r.status, 201, `refinement ${note} → 201`);
      }
      upgrades = await openNeedsHuman(port);
      rows = upgrades.filter((u) => u['reason'] === 'requirement-ambiguity');
      assert.equal(rows.length, 1, 'exactly one OPEN requirement-ambiguity after 3 refinements');
      assert.ok(
        narrativeOf(rows[0]!).includes('may be ambiguous'),
        'honest qualifier survives: the requirement may be ambiguous',
      );
      t.diagnostic('S3 requirement-ambiguity: 3 × refinement → 1 OPEN, honest narrative in place');

      // -------------------------------------------------- ai-disagreement --
      // Batch 36: two same-rank principals issue genuinely incompatible
      // directives on the same run target → conflict OPEN → one record.
      const target = `run-walk-nh-${Date.now()}`;
      const d1 = await api(port, 'POST', '/api/authority/directives', {
        principalId: 'mgr-a',
        authorityLevel: 'manager',
        targetKind: 'run',
        targetId: target,
        effect: 'ALLOW',
        instruction: 'proceed',
      });
      assert.equal(d1.status, 200);
      assert.equal(d1.body['conflict'], null, 'first directive: no conflict yet');
      const d2 = await api(port, 'POST', '/api/authority/directives', {
        principalId: 'mgr-b',
        authorityLevel: 'manager',
        targetKind: 'run',
        targetId: target,
        effect: 'BLOCK',
        instruction: 'hold for review',
      });
      assert.equal(d2.status, 200);
      const conflict = d2.body['conflict'] as Json;
      assert.ok(conflict, 'second directive opens the conflict');
      assert.equal(conflict['status'], 'OPEN');
      upgrades = await openNeedsHuman(port);
      rows = upgrades.filter((u) => u['reason'] === 'ai-disagreement');
      assert.equal(rows.length, 1, 'exactly one OPEN ai-disagreement');
      assert.ok(
        narrativeOf(rows[0]!).includes('the conflict is structural, not a judgment on either principal'),
        'honest qualifier survives: structural conflict, no judgment',
      );
      t.diagnostic('S4 ai-disagreement: ALLOW vs BLOCK → 1 OPEN, honest narrative in place');

      // --------------------------------------------- high-risk-deployment --
      // Batch 39: deploy with no risk signals → assessRisk computes HIGH
      // (unknown → strict, not a hardcode) → parked at AWAITING_APPROVAL
      // and one OPEN record; nothing is actually deployed.
      const dp = await api(port, 'POST', '/api/projects', { name: 'walk-nh-deploy' });
      assert.equal(dp.status, 201);
      const dt = await api(port, 'POST', '/api/tasks', {
        projectId: dp.body['id'],
        title: 'walk-nh-deploy',
        goal: 'pin the high-risk deployment gate',
      });
      assert.equal(dt.status, 201);
      const pl = await api(port, 'POST', '/api/pipelines', { taskId: dt.body['id'] });
      assert.equal(pl.status, 201);
      const dep = await api(port, 'POST', `/api/pipelines/${pl.body['id']}/deploy`, {
        environment: 'PROD',
        taskId: dt.body['id'],
        actor: 'deploy-bot',
      });
      assert.equal(dep.status, 200);
      assert.equal(
        (dep.body['deployment'] as Json)['status'],
        'AWAITING_APPROVAL',
        'deploy parks at the approval gate',
      );
      upgrades = await openNeedsHuman(port);
      rows = upgrades.filter((u) => u['reason'] === 'high-risk-deployment');
      assert.equal(rows.length, 1, 'exactly one OPEN high-risk-deployment');
      assert.ok(
        narrativeOf(rows[0]!).includes('no deployment was executed — the gate held'),
        'honest qualifier survives: parked, nothing executed',
      );
      t.diagnostic('S5 high-risk-deployment: no-signal deploy → HIGH → 1 OPEN, honest narrative in place');

      // ------------------------------------------------- budget-exceeded --
      // Batch 49 (F14): per-request budgets {maxSteps: 3} make the run
      // genuinely exceed its budget → FAILED / BUDGET_EXCEEDED → one
      // OPEN record. First deterministic HTTP trigger for this reason.
      const agent = await api(port, 'POST', '/api/agents', { name: 'walk-nh', jobTitle: 'Engineer' });
      assert.equal(agent.status, 201);
      const bp = await api(port, 'POST', '/api/projects', { name: 'walk-nh-run' });
      assert.equal(bp.status, 201);
      const bt = await api(port, 'POST', '/api/tasks', {
        projectId: bp.body['id'],
        title: 'walk-nh-budget',
        goal: 'pin the budget-exceeded trigger',
      });
      assert.equal(bt.status, 201);
      const br = await api(port, 'POST', '/api/runtime/runs', {
        agentId: agent.body['id'],
        taskId: bt.body['id'],
        budgets: { maxSteps: 3 },
      });
      assert.equal(br.status, 202);
      const budgetRunId = String(br.body['id']);
      const budgetRec = await waitForRun(port, budgetRunId);
      assert.equal(budgetRec['status'], 'FAILED', 'tight budget → run FAILED');
      upgrades = await openNeedsHuman(port);
      rows = upgrades.filter(
        (u) => u['reason'] === 'budget-exceeded' && String(u['source'] ?? '') === `runtime-run:${budgetRunId}`,
      );
      assert.equal(rows.length, 1, 'exactly one OPEN budget-exceeded for the run');
      assert.ok(
        narrativeOf(rows[0]!).includes('resource fact'),
        'honest qualifier survives: the budget limit is a resource fact',
      );
      t.diagnostic('S6 budget-exceeded: budgets {maxSteps:3} → FAILED → 1 OPEN, honest narrative in place');

      // ------------------------------------------------ repeated-failure --
      // Batch 38: the same unknown-tool error three times → stagnation →
      // LOOP_STAGNATION → ESCALATED → one OPEN 'repeated-failure'.
      const rt = await api(port, 'POST', '/api/tasks', {
        projectId: bp.body['id'],
        title: 'walk-nh-stagnation',
        goal: 'pin the repeated-failure trigger',
      });
      assert.equal(rt.status, 201);
      const script = Array.from({ length: 4 }, (_, i) => ({
        text: `broken step ${i}`,
        toolCalls: [{ tool: 'no-such-tool-walk-nh', args: {} }],
      }));
      const rr = await api(port, 'POST', '/api/runtime/runs', {
        agentId: agent.body['id'],
        taskId: rt.body['id'],
        script,
      });
      assert.equal(rr.status, 202);
      const stagRunId = String(rr.body['id']);
      const stagRec = await waitForRun(port, stagRunId);
      assert.equal(stagRec['status'], 'ESCALATED', 'unknown-tool 3× → run escalates');
      upgrades = await openNeedsHuman(port);
      rows = upgrades.filter(
        (u) => u['reason'] === 'repeated-failure' && String(u['source'] ?? '') === `runtime-run:${stagRunId}`,
      );
      assert.equal(rows.length, 1, 'exactly one OPEN repeated-failure for the run');
      assert.ok(
        narrativeOf(rows[0]!).includes('retry budget was exhausted'),
        'honest qualifier survives: the loop\u2019s own retry budget was exhausted',
      );
      t.diagnostic('S7 repeated-failure: unknown-tool 3× → 1 OPEN, honest narrative in place');

      // -------------------------------------- irrecoverable-env-error (—) --
      // The honest negative control (Batch 44/45 boundary): this server's
      // HTTP surface has no input that can put a stagnation signature into
      // ENV_ERROR_CODES — so there must be ZERO such records, even though
      // the emission block exists. The non-env stagnation above must have
      // produced exactly one repeated-failure and nothing else.
      upgrades = await openNeedsHuman(port);
      const envRows = upgrades.filter((u) => u['reason'] === 'irrecoverable-env-error');
      assert.equal(
        envRows.length,
        0,
        'HTTP positive path does not exist: zero irrecoverable-env-error records',
      );
      const stagAll = upgrades.filter(
        (u) => String(u['source'] ?? '') === `runtime-run:${stagRunId}`,
      );
      assert.equal(
        stagAll.length,
        1,
        'the non-env stagnation produced exactly one upgrade record (repeated-failure)',
      );
      t.diagnostic('S8 irrecoverable-env-error: negative control holds — 0 records, boundary documented');

      // ------------------------------------------------------------- tally --
      const reasons = new Set(upgrades.map((u) => String(u['reason'])));
      for (const expected of [
        'security-issue',
        'policy-violation',
        'requirement-ambiguity',
        'ai-disagreement',
        'high-risk-deployment',
        'budget-exceeded',
        'repeated-failure',
      ]) {
        assert.ok(reasons.has(expected), `OPEN set includes ${expected}`);
      }
      assert.ok(!reasons.has('irrecoverable-env-error'), 'no env-error record in the honest walk');
      t.diagnostic(`tally: 7 fired + 1 honest negative boundary (${upgrades.length} OPEN rows total)`);

      await stopServer(server);
      server = undefined;
    } finally {
      if (server) await stopServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

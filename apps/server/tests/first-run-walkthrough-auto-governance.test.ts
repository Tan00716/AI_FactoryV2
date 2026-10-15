/**
 * Walkthrough: §45.4 automatic governance leg (Batch 64, G10 / INV-28).
 *
 * What this pins, end to end (real compiled server process, pure
 * HTTP, zero mocks, fresh temp SQLite):
 *
 *   A. A healthy case (v1, passing canary observations) gets ZERO
 *      auto-governance decisions — nothing is disabled on success.
 *   B. A failing case (v2, two failing canary observations) gets
 *      disable-version + switch-to-fallback + downgrade-autonomy from
 *      POST /api/loops/:id/advance {step:'auto-govern'}; the loop ends
 *      up on the approved fallback v0 via an explicit, admission-checked
 *      migration.
 *   C. The running case on v1 stays pinned — auto-governance of the v2
 *      case never touches it.
 *   D. A NEW case cannot (re-)activate the disabled v2: 422 with
 *      DISABLED_VERSION in the error.
 *   E. The audit trail contains AUTO_GOVERNANCE_APPLIED with the three
 *      decisions.
 *
 * Honest boundary: this pins the *decisions and their enforcement
 * inside the improvement loop* (disable → refused activation/promotion;
 * fallback → explicit migration). The `downgrade-autonomy` decision is
 * recorded on the case's admission trail; actually mutating the
 * autonomy store is the autonomy layer's job — the evaluation package
 * is zero-dependency by convention, so the server does not pretend to
 * execute it here. Nothing here auto-grants privileges: high scores
 * yield zero decisions (pinned at the package level).
 *
 * Requires the workspace build (root `npm run build`): boots
 * ../dist/index.js. Hermetic: temp DB_PATH + temp FACTORY_SECRETS_DIR
 * + temp FACTORY_PROJECTS_ROOT per leg, no API tokens. Dual-mode: node
 * builtins + fetch only, zero src imports.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

const children: ChildProcess[] = [];
after(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      // already dead
    }
  }
});

async function bootServer(
  dir: string,
  dbFile: string,
): Promise<{ child: ChildProcess; port: number }> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
    FACTORY_PROJECTS_ROOT: join(dir, 'projects'),
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
  delete env['NODE_TEST_CONTEXT'];
  delete env['NODE_TEST_WORKER_ID'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  children.push(child);
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
    if (Date.now() > deadline) throw new Error('server did not boot in time');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function post(port: number, path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function get(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function evalResult() {
  return {
    evaluationId: 'eval_http_1',
    taskId: 'task-http',
    agentId: 'agent-http',
    summary: 'done',
    evidenceIds: ['ev1'],
    metrics: {
      taskSuccess: 1, testPassRate: 0.9, regressionRate: 0, reviewRejectionRate: 0,
      loopEfficiency: 1, durationMs: 100, tokenUsage: 10, toolErrorRate: 0,
      falseCompletionRate: 0, rollbackRate: 0, humanEscalationRate: 0,
    },
    score: 0.9,
    verdict: 'GOOD',
    repairLoops: 0,
    evaluatedAt: 1,
  };
}

function evalRun(runId: string) {
  return {
    runId,
    sampleId: 'sample-http',
    purpose: 'independent_check',
    attempts: [],
    totalCost: { durationMs: 100, tokensUsed: 10 },
    bestScore: 0.9,
    passed: true,
    executedAt: 1,
  };
}

/** Drive a loop case to LIMITED_ACTIVATION on `version` over HTTP. */
async function driveToActivate(
  port: number,
  version: string,
  employees: string[],
): Promise<string> {
  const started = await post(port, '/api/loops', { taskId: `task-${version}`, verifiedBy: 'human:qa' });
  assert.equal(started.status, 201, 'POST /api/loops');
  const caseId = (started.json['loop'] as { caseId: string }).caseId;

  const steps: Array<[string, Record<string, unknown>]> = [
    ['outcome_eval', { evaluation: evalResult(), by: 'eval-service' }],
    ['lesson', { lesson: { lessonId: 'lesson_http_1', taskId: `task-${version}`, agentId: 'agent-http', title: 't', content: 'c', severity: 'warning', confidence: 0.8, evidenceIds: [], createdAt: 1 }, by: 'analyst' }],
    ['proposal', { kind: 'skill-improvement', title: `improve-${version}`, description: 'd', by: 'agent-1' }],
    ['independent_eval', { regression: evalRun(`reg-${version}`), security: evalRun(`sec-${version}`), by: 'eval-service' }],
    ['version', { version, by: 'agent-1' }],
    ['approve', { approver: 'human:cto', by: 'human:cto' }],
    ['activate', { employees, note: 'canary', by: 'human:cto' }],
  ];
  for (const [step, body] of steps) {
    const r = await post(port, `/api/loops/${caseId}/advance`, { step, ...body });
    assert.equal(r.status, 200, `advance ${step} on ${version}`);
  }
  return caseId;
}

async function observe(port: number, caseId: string, success: boolean, note: string) {
  const r = await post(port, `/api/loops/${caseId}/advance`, {
    step: 'observe',
    note,
    success,
    by: 'eval-service',
  });
  assert.equal(r.status, 200, 'observe');
}

describe('auto-governance walkthrough (G10 / INV-28)', () => {
  it('failing version auto-disabled + fallback switched; healthy case stays pinned', async () => {
    // $HOME, not /tmp (512MB tmpfs on this machine; see F45).
    const dir = mkdtempSync(join(homedir(), 'auto-gov-a-'));
    const { port } = await bootServer(dir, join(dir, 'factory.db'));

    // Approved fallback v0 (driven to LIMITED_ACTIVATION; POLICY_APPROVAL
    // is what makes it fallback-eligible).
    await driveToActivate(port, 'v0', ['emp-fallback']);

    // A. Healthy case on v1: passing observations → zero decisions.
    const caseA = await driveToActivate(port, 'v1', ['emp-a']);
    await observe(port, caseA, true, 'ok');
    await observe(port, caseA, true, 'ok');
    const govA = await post(port, `/api/loops/${caseA}/advance`, { step: 'auto-govern', by: 'policy-engine' });
    assert.equal(govA.status, 200, 'auto-govern on healthy case');
    assert.deepEqual(govA.json['decisions'], [], 'healthy case: zero decisions');

    // B+C. Failing case on v2: two failing observations → 3 decisions,
    //     explicit migration to the approved fallback v0.
    const caseB = await driveToActivate(port, 'v2', ['emp-b']);
    await observe(port, caseB, false, 'canary crash');
    await observe(port, caseB, false, 'canary crash again');
    const govB = await post(port, `/api/loops/${caseB}/advance`, { step: 'auto-govern', by: 'policy-engine' });
    assert.equal(govB.status, 200, 'auto-govern on failing case');
    const decisions = govB.json['decisions'] as Array<{ action: string; version: string; targetVersion?: string }>;
    const actions = decisions.map((d) => d.action).sort();
    assert.deepEqual(actions, ['disable-version', 'downgrade-autonomy', 'switch-to-fallback']);
    const sw = decisions.find((d) => d.action === 'switch-to-fallback')!;
    assert.equal(sw.version, 'v2');
    assert.equal(sw.targetVersion, 'v0');

    const loopB = (await get(port, `/api/loops/${caseB}`)).json['loop'] as {
      version: string;
      onFallbackVersion: boolean;
    };
    assert.equal(loopB.version, 'v0', 'case B explicitly migrated to fallback v0');
    assert.equal(loopB.onFallbackVersion, true);

    // D. The running case on v1 stays pinned.
    const loopA = (await get(port, `/api/loops/${caseA}`)).json['loop'] as { version: string };
    assert.equal(loopA.version, 'v1', 'running case stays pinned to v1');

    // E. A new case cannot (re-)activate the disabled v2.
    const caseCStarted = await post(port, '/api/loops', { taskId: 'task-v2c', verifiedBy: 'human:qa' });
    const caseC = (caseCStarted.json['loop'] as { caseId: string }).caseId;
    for (const [step, body] of [
      ['outcome_eval', { evaluation: evalResult(), by: 'eval-service' }],
      ['lesson', { lesson: { lessonId: 'lesson_c', taskId: 'task-v2c', agentId: 'a', title: 't', content: 'c', severity: 'info', confidence: 0.5, evidenceIds: [], createdAt: 1 }, by: 'analyst' }],
      ['proposal', { kind: 'skill-improvement', title: 't', description: 'd', by: 'agent-1' }],
      ['independent_eval', { regression: evalRun('reg-c'), security: evalRun('sec-c'), by: 'eval-service' }],
      ['version', { version: 'v2', by: 'agent-1' }],
      ['approve', { approver: 'human:cto', by: 'human:cto' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await post(port, `/api/loops/${caseC}/advance`, { step, ...body });
      assert.equal(r.status, 200, `case C advance ${step}`);
    }
    const actC = await post(port, `/api/loops/${caseC}/advance`, {
      step: 'activate',
      employees: ['emp-c'],
      note: 'x',
      by: 'human:cto',
    });
    assert.equal(actC.status, 422, 'activating disabled v2 must be refused');
    assert.match(String(actC.json['error']), /DISABLED_VERSION/);

    // F. Audit trail carries the governance decisions.
    const auditRes = await get(port, '/api/audit?limit=300');
    assert.equal(auditRes.status, 200, 'GET /api/audit');
    const records = auditRes.json as unknown as Array<{ action: string; details?: Record<string, unknown> }>;
    const gov = records.find((r) => r.action === 'AUTO_GOVERNANCE_APPLIED');
    assert.ok(gov, 'AUTO_GOVERNANCE_APPLIED audit record exists');
    const decided = (gov!.details as { decisions: Array<{ action: string }> }).decisions;
    assert.deepEqual(decided.map((d) => d.action).sort(), [
      'disable-version',
      'downgrade-autonomy',
      'switch-to-fallback',
    ]);
  });
});

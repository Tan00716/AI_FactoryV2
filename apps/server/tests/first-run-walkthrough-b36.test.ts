/**
 * First-run walkthrough, fourth edition — B31–B35 governance + persistence
 * chains (Batch 36-4).
 *
 * Walks the chains that landed in B31–B35 — the "governance plane" — on the
 * real compiled server over a fresh temp SQLite file:
 *
 * Boot A (fresh DB, FACTORY_BUILD_COMMAND + FACTORY_SBOM_DIR configured):
 *   P1 — a pipeline is created (QUEUED, full 12-stage definition
 *        persisted); then exactly the mid-run row shape a SIGKILL would
 *        leave (pipeline RUNNING + one stage RUNNING, stages 0/1
 *        SUCCEEDED) is written through the same per-stage-end write-through
 *        the server performs — the hydrate logic under test is real, the
 *        row shape is honest about being a simulation (see the note below);
 *   B1 — a landed merge triggers a REAL build; the build is observed
 *        landing SUCCEEDED over pure HTTP (GET /api/builds?prId=) — the
 *        walkthrough F9 gap is closed and exercised here;
 *   A1 — two same-rank managers register incompatible directives
 *        (BLOCK vs ALLOW) on the same task → AUTHORITY_CONFLICT (OPEN),
 *        the target is paused; an owner escalates a decision and the pause
 *        lifts;
 *   D1 — an employee is created under a task scope that covers its grant
 *        (201); creating one under an empty task scope is refused
 *        grant-exceeds-task-scope (403) and the refusal is audited;
 *   G1 — a delegation is created + activated (ACTIVE); a gate definition
 *        is upserted and evaluated to a real verdict (caller-supplied
 *        evidence, never caller-supplied verdict); a proposal decision is
 *        recorded; a no-evidence dispute escalates (ESCALATED);
 *   R1 — a project record with the §6.1 fields and a §6.4 knowledge entry
 *        are persisted.
 * SIGKILL.
 * Boot B (same DB):
 *   P1 — the mid-run pipeline hydrates as INTERRUPTED (never RUNNING),
 *        the in-flight stage as INTERRUPTED; /run keeps 409ing
 *        (PIPELINE_NOT_REHYDRATABLE — a record, not an execution);
 *   B1 — the build record is still SUCCEEDED over HTTP;
 *   G1 — the delegation is INTERRUPTED (never re-enters the live manager),
 *        the gate definition + evaluation survive, the proposal decision
 *        history survives, the escalation survives;
 *   R1 — the §6.1 record and the knowledge entry survive intact;
 *   A2 — every chain left its mark in the hash-chained audit log, which
 *        still verifies over the file.
 *
 * Honest note on the mid-run pipeline: /run's simulated stage handlers
 * complete in milliseconds, so a true SIGKILL cannot land mid-run over
 * HTTP. The script writes exactly the row shape a mid-run kill would leave
 * (pipeline RUNNING + stage 2 RUNNING, via the same table columns the
 * server's own per-stage-end write-through writes) and then SIGKILLs —
 * the hydrate-and-demote logic under test is real. The QUEUED path (create
 * → kill → still QUEUED, /run 409s) is exercised pure-real right before it.
 *
 * Findings are pinned in docs/FIRST_RUN_WALKTHROUGH.md (Batch 36 section).
 *
 * Requires the workspace build (root `npm run build`); run with
 * `npm run demo:e2e-v4`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AuditLog } from '@ai-factory/core';
import { FactoryDatabase } from '@ai-factory/db';

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
    FACTORY_SECRETS_DIR: join(tmpdir(), `factory-walk-b36-secrets-${port}`),
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

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** Real repo whose lockfile carries real package entries (for SBOM). */
function makeRepoWithDeps(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-walkb36-'));
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'user.name', 'walk']);
  git(dir, ['config', 'user.email', 'walk@example.com']);
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        '': { name: 'demo', version: '1.0.0' },
        'node_modules/left-pad': { version: '1.3.0' },
      },
    }),
  );
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'root']);
  git(dir, ['checkout', '-qb', 'feat']);
  writeFileSync(join(dir, 'f.txt'), 'f\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'feat']);
  git(dir, ['checkout', '-q', 'main']);
  return dir;
}

/** Poll the pure-HTTP builds surface until the record leaves NOT_EXECUTED. */
async function waitForTerminalBuildHttp(
  port: number,
  prId: string,
  timeoutMs = 90_000,
): Promise<Json | null> {
  const deadline = Date.now() + timeoutMs;
  let last: Json | null = null;
  for (;;) {
    try {
      const res = await api(port, 'GET', `/api/builds?prId=${encodeURIComponent(prId)}`);
      if (res.status === 200) {
        const items = (res.body['items'] ?? []) as Array<Json>;
        last = items[0] ?? null;
        if (last && last['status'] !== 'NOT_EXECUTED') return last;
      }
    } catch {
      /* transient — retry */
    }
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
}

function auditActions(body: Json | unknown[]): string[] {
  const recs = (Array.isArray(body) ? body : ((body as Json)['records'] ?? [])) as Array<{
    action?: string;
  }>;
  return recs.map((r) => r.action ?? '').filter(Boolean);
}

// ------------------------------------------------------------------ the run --

describe('first-run walkthrough, fourth edition — B31–B35 governance + persistence chains (Batch 36-4)', () => {
  it('pipeline write-through → build over HTTP → authority conflict → relative ceiling → §48.2 entities → project record + knowledge, durable across a SIGKILL restart', { timeout: 600_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-walk-b36-'));
    const dbFile = join(dir, 'factory.db');
    const sbomDir = join(dir, 'sboms');
    const workRoot = mkdtempSync(join(tmpdir(), 'walk-b36-buildwork-'));
    const repo = makeRepoWithDeps();
    let server: BootedServer | undefined;
    let pipelineId = '';
    let prId = '';
    let conflictId = '';
    let delegationId = '';
    let projectId = '';
    try {
      // ------------------------------------------------------------ boot A --
      server = await bootServer(dbFile, {
        FACTORY_BUILD_COMMAND: `node -e \"require('fs').writeFileSync('built.txt','ok')\"`,
        FACTORY_BUILD_WORK_ROOT: workRoot,
        FACTORY_BUILD_TIMEOUT_MS: '30000',
        FACTORY_SBOM_DIR: sbomDir,
        FACTORY_BUILD_CONFIG_FILES: 'package-lock.json',
      });
      const portA = server.port;

      // P1 — create a pipeline: QUEUED, 12 stages persisted. Pure real.
      const pl = await api(portA, 'POST', '/api/pipelines', { environment: 'DEV' });
      assert.equal(pl.status, 201);
      pipelineId = pl.body['id'] as string;
      assert.ok(pipelineId, 'pipeline id returned');
      const got0 = await api(portA, 'GET', `/api/pipelines/${pipelineId}`);
      assert.equal(got0.status, 200);
      assert.equal(got0.body['status'], 'QUEUED');
      assert.equal(((got0.body['stages'] ?? []) as unknown[]).length, 12, 'full stage definition persisted');

      // Then the honest mid-run simulation (see header note): write exactly
      // the row shape a mid-run SIGKILL would leave behind.
      {
        const raw = new DatabaseSync(dbFile);
        raw.prepare("UPDATE pipeline_records SET status = 'RUNNING' WHERE id = ?").run(pipelineId);
        raw
          .prepare(
            "UPDATE pipeline_stages SET status = 'SUCCEEDED', ended_at = '2026-10-13T00:00:01.000Z' WHERE pipeline_id = ? AND position IN (0, 1)",
          )
          .run(pipelineId);
        raw
          .prepare(
            "UPDATE pipeline_stages SET status = 'RUNNING', started_at = '2026-10-13T00:00:02.000Z' WHERE pipeline_id = ? AND position = 2",
          )
          .run(pipelineId);
        raw.close();
      }
      // Note: GET /api/pipelines/:id prefers the live in-memory record
      // while the process lives, so the simulated rows are only visible
      // after the restart — which is exactly the honest path.

      // B1 — a landed merge triggers a REAL build, observed over pure HTTP.
      const project = await api(portA, 'POST', '/api/projects', { name: 'Walk B36' });
      assert.equal(project.status, 201);
      const task = await api(portA, 'POST', '/api/tasks', {
        projectId: project.body['id'],
        title: 'build http task',
        goal: 'run a real build and watch it over HTTP',
      });
      assert.equal(task.status, 201);
      const taskId = task.body['id'] as string;
      const pr = await api(portA, 'POST', '/api/git/pr', {
        repo,
        taskId,
        sourceBranch: 'feat',
        targetBranch: 'main',
        title: 'Merge feat',
      });
      assert.equal(pr.status, 201);
      prId = pr.body['id'] as string;
      const merged = await api(portA, 'POST', `/api/git/pr/${prId}/merge`, { repo, actor: 'human' });
      assert.equal(merged.status, 200);
      const buildRow = await waitForTerminalBuildHttp(portA, prId);
      assert.ok(buildRow, 'build record reached a terminal state over HTTP');
      assert.equal(buildRow!['status'], 'SUCCEEDED', `build really ran; failureReason=${buildRow!['failureReason']}`);
      assert.match(String(buildRow!['digest'] ?? ''), /^[0-9a-f]{64}$/, 'real 64-hex digest');
      assert.equal(buildRow!['prId'], prId, 'build bound to the candidate PR');
      const byId = await api(portA, 'GET', `/api/builds/${buildRow!['id']}`);
      assert.equal(byId.status, 200);
      assert.equal((byId.body['build'] as Json)['status'], 'SUCCEEDED');

      // A1 — two same-rank managers, incompatible directives → conflict.
      const d1 = await api(portA, 'POST', '/api/authority/directives', {
        principalId: 'mgr-a',
        authorityLevel: 'manager',
        targetKind: 'task',
        targetId: taskId,
        effect: 'BLOCK',
        instruction: 'hold the deploy',
      });
      assert.equal(d1.status, 200);
      assert.equal((d1.body['conflict'] as Json | null) ?? null, null, 'no conflict on the first directive');
      const blockId = ((d1.body['directive'] ?? {}) as Json)['directiveId'] as string;
      const d2 = await api(portA, 'POST', '/api/authority/directives', {
        principalId: 'mgr-b',
        authorityLevel: 'manager',
        targetKind: 'task',
        targetId: taskId,
        effect: 'ALLOW',
        instruction: 'ship it now',
      });
      assert.equal(d2.status, 200);
      const conflict = d2.body['conflict'] as Json | null;
      assert.ok(conflict, 'equal-rank incompatible directives open AUTHORITY_CONFLICT');
      assert.equal(conflict!['status'], 'OPEN');
      conflictId = conflict!['conflictId'] as string;
      assert.equal(d2.body['paused'], true, 'target is paused while the conflict is open');
      const tgt = await api(portA, 'GET', `/api/authority/targets/task/${encodeURIComponent(taskId)}`);
      assert.equal(tgt.status, 200);
      assert.equal(tgt.body['paused'], true);
      // Same-rank resolution must be refused; a strictly higher rank (owner) decides.
      const flat = await api(portA, 'POST', `/api/authority/conflicts/${conflictId}/resolve`, {
        decidedByPrincipalId: 'mgr-c',
        decidedByLevel: 'manager',
        winningDirectiveId: blockId,
        rationale: 'peer tries to settle',
      });
      assert.equal(flat.status, 400, 'same-rank escalation decision is refused');
      const res2 = await api(portA, 'POST', `/api/authority/conflicts/${conflictId}/resolve`, {
        decidedByPrincipalId: 'owner-1',
        decidedByLevel: 'owner',
        winningDirectiveId: blockId,
        rationale: 'safety beats speed',
      });
      assert.equal(res2.status, 200);
      assert.equal((res2.body['conflict'] as Json)['status'], 'RESOLVED');
      const tgt2 = await api(portA, 'GET', `/api/authority/targets/task/${encodeURIComponent(taskId)}`);
      assert.equal(tgt2.body['paused'], false, 'pause lifts after the escalation decision');

      // D1 — employee creation under a covering task scope succeeds…
      const okEmp = await api(portA, 'POST', '/api/workforce/employees', {
        jobTitle: 'Walk Engineer',
        requestedBy: 'human',
        taskScope: [
          'tool:Repository',
          'tool:Terminal',
          'permission:filesystem.read',
          'permission:filesystem.write',
          'permission:shell.execute',
          'permission:git.commit',
          'permission:github.pull_request',
          'permission:database.read',
        ],
      });
      assert.equal(okEmp.status, 201);
      assert.ok(okEmp.body['id'], 'employee created within its task scope');
      // …and under an empty task scope is refused, and the refusal audited.
      const over = await api(portA, 'POST', '/api/workforce/employees', {
        jobTitle: 'Walk Engineer',
        requestedBy: 'human',
        taskScope: [],
      });
      assert.equal(over.status, 403);
      assert.match(String(over.body['error'] ?? ''), /grant-exceeds-task-scope/);

      // G1 — delegation create + activate (ACTIVE at kill time).
      const del = await api(portA, 'POST', '/api/delegations', {
        delegation_id: 'del-walk-b36',
        delegator: 'mgr',
        delegatee: 'worker',
        root_authorization_id: 'auth-1',
        task_id: 'task-1',
        requirement_version: 'REQ-1@1',
        scope: ['tool:shell'],
        budget_reservation: 10,
      });
      assert.equal(del.status, 201);
      delegationId = ((del.body['delegation'] ?? {}) as Json)['delegation_id'] as string;
      const act = await api(portA, 'POST', `/api/delegations/${delegationId}/activate`);
      assert.equal(act.status, 200);
      assert.equal(((act.body['delegation'] ?? {}) as Json)['status'], 'ACTIVE');

      // G1 — gate definition upsert + a real deterministic evaluation.
      const gput = await api(portA, 'PUT', '/api/gates/definitions/gate-walk-b36', {
        mandatory_ac_ids: ['AC-1'],
        max_failed: 0,
        max_skipped: 0,
        require_independent_review: false,
        max_finding_severity: 'HIGH',
        freshness_ms: null,
      });
      assert.equal(gput.status, 200);
      const gev = await api(portA, 'POST', '/api/gates/definitions/gate-walk-b36/evaluate', {
        evidence: [
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
        ],
      });
      assert.equal(gev.status, 200);
      assert.equal(((gev.body['evaluation'] ?? {}) as Json)['verdict'], 'PASSED');
      assert.equal(gev.body['evidence_source'], 'caller-supplied');

      // G1 — a proposal decision is persisted (insert-only).
      const prop = await api(portA, 'POST', '/api/workforce/proposals', {
        kind: 'create',
        target: 'Production Administrator',
        rationale: 'someone has to own prod',
        requestedBy: 'agent-1',
      });
      assert.equal(prop.status, 201);
      const propId = prop.body['id'] as string;
      assert.ok(propId, 'proposal id returned');

      // G1 — a no-evidence dispute escalates (append-only escalation record).
      const disp = await api(portA, 'POST', '/api/disputes', {
        verdictA: { agent: 'qa-1', verdict: 'PASS', evidenceIds: [], reason: 'looks fine' },
        verdictB: { agent: 'qa-2', verdict: 'FAIL', evidenceIds: [], reason: 'looks broken' },
      });
      assert.equal(disp.status, 200);
      const esc = ((disp.body['outcome'] ?? {}) as Json)['escalation'] as Json;
      assert.equal(((disp.body['outcome'] ?? {}) as Json)['status'], 'ESCALATED');
      assert.ok(esc['escalationId'], 'escalation record id');

      // R1 — a §6.1 project record with the real fields, plus knowledge.
      const rp = await api(portA, 'POST', '/api/projects', {
        name: 'Walk B36 Project',
        organization_id: 'org-1',
        lifecycle_state: 'active',
        policy_version: 'v2',
      });
      assert.equal(rp.status, 201);
      projectId = rp.body['id'] as string;
      const kput = await api(portA, 'PUT', `/api/projects/${projectId}/knowledge`, {
        title: 'walk decision',
        category: 'decisions',
        content: 'summary: chose the simplest thing that survives restart',
        sourcePath: 'docs/plan.md',
        sourceVersion: '1.0.0',
      });
      assert.equal(kput.status, 200);
      const badCat = await api(portA, 'PUT', `/api/projects/${projectId}/knowledge`, {
        title: 'bad',
        category: 'not-a-category',
        content: 'x',
      });
      assert.equal(badCat.status, 400, 'unknown knowledge category is refused loudly');

      await killServer(server);
      server = undefined;

      // ------------------------------------------------------------ boot B --
      server = await bootServer(dbFile, {
        FACTORY_BUILD_COMMAND: `node -e \"require('fs').writeFileSync('built.txt','ok')\"`,
        FACTORY_BUILD_WORK_ROOT: workRoot,
        FACTORY_BUILD_TIMEOUT_MS: '30000',
        FACTORY_SBOM_DIR: sbomDir,
      });
      const portB = server.port;

      // P1 — the mid-run pipeline hydrates as INTERRUPTED, never RUNNING.
      const got = await api(portB, 'GET', `/api/pipelines/${pipelineId}`);
      assert.equal(got.status, 200);
      assert.equal(got.body['status'], 'INTERRUPTED', 'in-flight pipeline is INTERRUPTED, not RUNNING');
      const stages = got.body['stages'] as Array<{ name: string; status: string }>;
      assert.equal(stages[0].status, 'SUCCEEDED');
      assert.equal(stages[1].status, 'SUCCEEDED');
      assert.equal(stages[2].status, 'INTERRUPTED', 'in-flight stage is INTERRUPTED, not RUNNING');
      const runB = await api(portB, 'POST', `/api/pipelines/${pipelineId}/run`, {});
      assert.equal(runB.status, 409);
      assert.equal(runB.body['name'], 'PIPELINE_NOT_REHYDRATABLE');

      // B1 — the build record is still SUCCEEDED over HTTP.
      const rowB = await waitForTerminalBuildHttp(portB, prId, 5_000);
      assert.ok(rowB, 'build record still present after the restart');
      assert.equal(rowB!['status'], 'SUCCEEDED');

      // G1 — the delegation is INTERRUPTED and stays out of the live manager.
      const delB = await api(portB, 'GET', `/api/delegations/${delegationId}`);
      assert.equal(delB.status, 200);
      // An INTERRUPTED delegation reads back as a flat rehydrated record
      // (delegation_id/status at top level), never a live delegation.
      assert.equal(delB.body['status'], 'INTERRUPTED');
      const delMut = await api(portB, 'POST', `/api/delegations/${delegationId}/complete`);
      assert.equal(delMut.status, 409, 'INTERRUPTED delegation cannot be completed');

      // G1 — the gate definition + evaluation survive.
      const gdefB = await api(portB, 'GET', '/api/gates/definitions/gate-walk-b36');
      assert.equal(gdefB.status, 200);
      const evlogB = await api(portB, 'GET', '/api/gates/evaluations');
      assert.equal(evlogB.status, 200);
      assert.ok(
        ((evlogB.body['evaluations'] ?? []) as Array<Json>).some(
          (e) => e['verdict'] === 'PASSED',
        ),
        'gate evaluation survived the restart',
      );

      // G1 — the proposal decision history and the escalation survive.
      const propsB = await api(portB, 'GET', '/api/workforce/proposals');
      assert.equal(propsB.status, 200);
      assert.ok(
        ((propsB.body['items'] ?? []) as Array<Json>).some((p) => p['id'] === propId),
        'proposal decision survived the restart',
      );
      const escsB = await api(portB, 'GET', '/api/disputes/escalations');
      assert.equal(escsB.status, 200);
      assert.ok(
        ((escsB.body['escalations'] ?? []) as Array<Json>).some(
          (e) => e['escalationId'] === esc['escalationId'],
        ),
        'escalation survived the restart',
      );

      // R1 — the §6.1 record and the knowledge entry survive intact.
      const projB = await api(portB, 'GET', `/api/projects/${projectId}`);
      assert.equal(projB.status, 200);
      const projFull = (projB.body['project'] ?? {}) as Json;
      assert.equal(projFull['organization_id'], 'org-1');
      assert.equal(projFull['lifecycle_state'], 'active');
      const knowB = await api(portB, 'GET', `/api/projects/${projectId}/knowledge?category=decisions`);
      assert.equal(knowB.status, 200);
      assert.ok(
        ((knowB.body['items'] ?? []) as Array<Json>).some((e) => e['title'] === 'walk decision'),
        'knowledge entry survived the restart',
      );

      // A2 — every chain left its mark in the hash-chained audit log.
      const auditB = await api(portB, 'GET', '/api/audit?limit=2000');
      assert.equal(auditB.status, 200);
      const actions = auditActions(auditB.body);
      for (const expected of [
        'PIPELINE_REHYDRATED',
        'BUILD_SUCCEEDED',
        'AUTHORITY_DIRECTIVE_REGISTERED',
        'AUTHORITY_CONFLICT_DETECTED',
        'AUTHORITY_CONFLICT_HUMAN_RESOLVED',
        'TASK_SCOPE_CEILING_DENIED', // D1: the empty-scope refusal, loudly audited
        'EMPLOYEE_CREATED',
        'DELEGATION_CREATED',
        'DELEGATION_INTERRUPTED_ON_RESTART',
        'GATE_EVALUATED',
        'SELF_MODIFICATION_PROPOSED',
        'PROJECT_KNOWLEDGE_UPSERTED',
      ]) {
        assert.ok(actions.includes(expected), `audit contains ${expected}`);
      }

      await stopServer(server);
      server = undefined;

      const fdb = new FactoryDatabase(dbFile);
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
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

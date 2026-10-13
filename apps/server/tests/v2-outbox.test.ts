/**
 * Durable v2 outbox — SPEC v2 §18.2 (G-17) / §48.4 (Batch 17).
 *
 * The engine's outbox (one event per COMMITTED stage change) used to
 * be a process-local array while the outbox_events table sat in the
 * schema with no writer. With FactoryDatabase.outbox wired into
 * V2TransitionService as the engine's OutboxSink, this file pins:
 *
 *  1. Committed transitions append rows to outbox_events in the same
 *     step — payload field-for-field equal to the engine's events,
 *     columns the faithful projection, dispatched_at NULL; finalize
 *     appends its WORKFLOW_FINALIZED / REQUEST_COMPLETE row too.
 *  2. Denied transitions (illegal edge, direct-to-DONE) append
 *     NOTHING — the outbox records what committed, only.
 *  3. Restart: undispatched events are restored into a fresh service's
 *     engine and served by GET /api/tasks/:id/outbox (route level);
 *     unknown task 404s.
 *  4. Drain semantics: drainOutbox stamps dispatched_at — the rows
 *     REMAIN (confirm, never delete) — a per-task drain leaves other
 *     tasks' events pending, and a restart restores nothing drained.
 *  5. Real server (dist) e2e: /api/health reports outbox.pending 0,
 *     one HTTP v2-transition makes it 1 and GET /outbox serves the
 *     event; after SIGKILL + reboot both still say 1 / the same event.
 *
 * Like v2-state-persistence.test.ts this runs against the compiled
 * dist and requires `npm run build -w @ai-factory/server` first. The
 * route handler is invoked in exactly ONE test (test 3): the handler's
 * service is a process-wide singleton built from the first ctx, so
 * every other test uses createV2TransitionService directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AuditLog,
  EvidenceEngine,
  TaskManager,
} from '@ai-factory/core';
import type { Evidence, OutboxEvent } from '@ai-factory/core';
import { FactoryDatabase, eventTypeOf } from '@ai-factory/db';
import { RequirementManager } from '@ai-factory/requirements';
import {
  createV2TransitionService,
  handleV2TransitionRoutes,
} from '../dist/routes/v2-transitions.js';
import type { V2TransitionService } from '../dist/routes/v2-transitions.js';

// ------------------------------------------------------------ fixtures --

const PIN = 'REQ-001@1';

const EVIDENCE_PLAN: Array<[string, Record<string, unknown>]> = [
  ['plan', {}],
  ['code_change', { sha: 'cand-1' }],
  ['code_review', { verdict: 'PASS' }],
  ['ci_result', { verdict: 'PASS' }],
  ['qa_result', { verdict: 'PASS' }],
  ['security_report', { verdict: 'PASS' }],
  ['merge', { pr: 'PR-1' }],
  ['uat_result', { verdict: 'PASS' }],
  ['approval', { verdict: 'APPROVED' }],
  ['deployment', { environment: 'prod', digest: 'cand-1' }],
  ['smoke_test', { verdict: 'PASS' }],
];

function seedEvidence(evidence: EvidenceEngine, taskId: string, pin?: string): void {
  for (const [type, payload] of EVIDENCE_PLAN) {
    evidence.create({
      taskId,
      type: type as Evidence['type'],
      title: `${type} (outbox test)`,
      payload,
      createdBy: 'human',
      requirementVersion: type === 'plan' && pin ? pin : null,
    });
  }
}

function makeManager(): RequirementManager {
  const mgr = new RequirementManager();
  mgr.create({
    id: 'REQ-001',
    businessGoal: 'ship the thing',
    acceptanceCriteria: [
      {
        id: 'AC-001',
        description: 'the thing works',
        verificationType: 'AUTOMATED_TEST',
        verifiedBy: 'INDEPENDENT_QA',
        expectedEvidence: 'qa_result with verdict PASS',
        applicableEnvironments: ['DEV'],
      },
    ],
    createdBy: 'human',
  } as never);
  return mgr;
}

function makeWorld(file: string) {
  const fdb = new FactoryDatabase(file);
  const tasks = new TaskManager(fdb.tasks);
  const evidence = new EvidenceEngine(fdb.evidence);
  const audit = new AuditLog(fdb.audit);
  const service = createV2TransitionService({
    tasks,
    evidence,
    audit,
    requirements: makeManager(),
    v2States: fdb.taskV2States,
    outbox: fdb.outbox,
  });
  return { fdb, tasks, evidence, audit, service };
}

function newTask(world: ReturnType<typeof makeWorld>, title: string): string {
  if (!world.fdb.getProject('p1')) {
    world.fdb.createProject({ id: 'p1', name: 'P', description: '', path: '' });
  }
  return world.tasks.create({
    projectId: 'p1',
    title,
    goal: 'g',
    description: '',
    priority: 'P2',
    acceptanceCriteria: [],
    constraints: [],
    creator: 'human',
  }).id;
}

type Stage = Parameters<V2TransitionService['transition']>[1];

const WALK: Array<[Stage, Record<string, unknown>]> = [
  ['PLANNING', {}],
  ['IN_PROGRESS', { budgetOk: true }],
  ['CODE_REVIEW', {
    candidateDigest: 'cand-1',
    confinementOk: true,
    leaseValid: true,
    leaseId: 'lease-1',
    implementerId: 'agent-1',
  }],
  ['PENDING_QA', { implementerId: 'agent-1' }],
  ['QA', { quotaOk: true }],
  ['PENDING_UAT_MERGE', {}],
  ['UAT', { candidateDigest: 'cand-1' }],
  ['PENDING_PROD', {}],
  ['PROD_DEPLOYING', {}],
  ['PROD_VERIFICATION', { leaseValid: true, leaseId: 'lease-2' }],
  ['OUTCOME_VERIFICATION', {}],
];

function walk(
  service: V2TransitionService,
  taskId: string,
  steps: Array<[Stage, Record<string, unknown>]>,
): void {
  for (const [to, extra] of steps) {
    const r = service.transition(taskId, to, 'human', {
      requirementVersion: PIN,
      ...extra,
    });
    assert.equal(r.ok, true, `walk → ${to}: ${JSON.stringify(r)}`);
  }
}

function tmpDir(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-server-outbox-'));
  return { dir, file: join(dir, 'factory.db') };
}

interface OutboxRow {
  event_id: string;
  event_type: string;
  aggregate_id: string;
  occurred_at: string;
  payload: string;
  dispatched_at: string | null;
}

function outboxRows(fdb: FactoryDatabase, taskId?: string): OutboxRow[] {
  const rows = (
    taskId === undefined
      ? fdb.db.prepare('SELECT * FROM outbox_events ORDER BY rowid').all()
      : fdb.db
          .prepare('SELECT * FROM outbox_events WHERE aggregate_id = ? ORDER BY rowid')
          .all(taskId)
  ) as unknown as OutboxRow[];
  return rows;
}

// ------------------------------------------------------------- tests --

describe('durable v2 outbox (§18.2/§48.4, Batch 17)', () => {
  it('committed transitions and finalize append faithful rows; denials append nothing', () => {
    const { dir, file } = tmpDir();
    try {
      const w = makeWorld(file);
      const taskId = newTask(w, 'outbox fidelity');
      seedEvidence(w.evidence, taskId, PIN);

      // Denied first: an illegal edge and a direct-to-DONE both write
      // nothing — the outbox records commits only.
      const illegal = w.service.transition(taskId, 'IN_PROGRESS', 'human', {
        requirementVersion: PIN,
      });
      assert.equal(illegal.ok, false);
      assert.equal(outboxRows(w.fdb).length, 0);

      walk(w.service, taskId, WALK.slice(0, 3));
      const deniedDone = w.service.transition(taskId, 'DONE', 'human', {
        requirementVersion: PIN,
      });
      assert.equal(deniedDone.ok, false);
      assert.equal(outboxRows(w.fdb).length, 3);

      // Rows are the engine's events, field-for-field, columns projected.
      const engineEvents: OutboxEvent[] = w.service.engine.listOutbox(taskId);
      assert.equal(engineEvents.length, 3);
      const rows = outboxRows(w.fdb, taskId);
      assert.equal(rows.length, 3);
      for (let i = 0; i < rows.length; i++) {
        assert.equal(rows[i].aggregate_id, taskId);
        assert.equal(rows[i].event_type, 'WORKFLOW_TRANSITIONED');
        assert.equal(rows[i].occurred_at, engineEvents[i].at);
        assert.equal(rows[i].dispatched_at, null);
        assert.deepEqual(JSON.parse(rows[i].payload), engineEvents[i]);
      }
      assert.deepEqual(
        engineEvents.map((e) => [e.from, e.to]),
        [
          ['TODO', 'PLANNING'],
          ['PLANNING', 'IN_PROGRESS'],
          ['IN_PROGRESS', 'CODE_REVIEW'],
        ],
      );

      // The rest of the lifecycle + finalize: 11 transitions + 1
      // finalize event, the last row the REQUEST_COMPLETE one.
      walk(w.service, taskId, WALK.slice(3));
      const done = w.service.complete(taskId, 'human', {});
      assert.equal(done.ok, true, JSON.stringify(done));
      const all = outboxRows(w.fdb, taskId);
      assert.equal(all.length, 12);
      const last = all[all.length - 1];
      assert.equal(last.event_type, 'WORKFLOW_FINALIZED');
      const lastEvent = JSON.parse(last.payload) as OutboxEvent;
      assert.equal(lastEvent.from, 'OUTCOME_VERIFICATION');
      assert.equal(lastEvent.to, 'DONE');
      assert.equal(lastEvent.intent, 'REQUEST_COMPLETE');
      w.fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drain stamps dispatched_at (rows remain), is per-task, and stays drained across a restart', () => {
    const { dir, file } = tmpDir();
    try {
      const a = makeWorld(file);
      const t1 = newTask(a, 'drain one');
      const t2 = newTask(a, 'drain two');
      seedEvidence(a.evidence, t1, PIN);
      seedEvidence(a.evidence, t2, PIN);
      walk(a.service, t1, WALK.slice(0, 2));
      walk(a.service, t2, WALK.slice(0, 1));
      assert.equal(a.fdb.outbox.countPending(), 3);

      const drained = a.service.engine.drainOutbox(t1);
      assert.equal(drained.length, 2);
      assert.equal(a.fdb.outbox.countPending(), 1);

      // Confirm, never delete: all three rows remain; t1's are stamped,
      // t2's is not.
      const rows = outboxRows(a.fdb);
      assert.equal(rows.length, 3);
      for (const row of rows) {
        if (row.aggregate_id === t1) assert.ok(row.dispatched_at !== null);
        else assert.equal(row.dispatched_at, null);
      }
      assert.deepEqual(a.service.outboxView(t1).events, []);
      assert.equal(a.service.outboxView(t2).events.length, 1);
      a.fdb.close();

      // Restart: the drained events do not come back; t2's pending
      // event is restored exactly.
      const b = makeWorld(file);
      assert.deepEqual(b.service.engine.listOutbox(t1), []);
      const restored = b.service.engine.listOutbox(t2);
      assert.equal(restored.length, 1);
      assert.equal(restored[0].from, 'TODO');
      assert.equal(restored[0].to, 'PLANNING');
      assert.equal(b.fdb.outbox.countPending(), 1);
      b.fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('route level: GET /outbox after a restart serves the restored pending events; unknown task 404s', async () => {
    const { dir, file } = tmpDir();
    try {
      // Boot A: two committed transitions at service level, then close.
      const a = makeWorld(file);
      const taskId = newTask(a, 'route-level outbox');
      seedEvidence(a.evidence, taskId, PIN);
      walk(a.service, taskId, WALK.slice(0, 2));
      const committed = a.service.engine.listOutbox(taskId);
      assert.equal(committed.length, 2);
      a.fdb.close();

      // Boot B: the real route handler over a fresh world — the
      // singleton service must pick ctx.fdb.outbox up behind its shape
      // guard and hydrate the pending queue from the table.
      const b = makeWorld(file);
      const call = async (method: string, path: string) => {
        const calls: Array<{ status: number; body: unknown }> = [];
        const ctx = {
          tasks: b.tasks,
          evidence: b.evidence,
          audit: b.audit,
          fdb: b.fdb,
          bus: { emit: () => {} },
          readBody: async () => ({}),
          json: (_res: unknown, status: number, body: unknown) => {
            calls.push({ status, body });
          },
        } as never;
        const handled = await handleV2TransitionRoutes(
          { method } as never,
          {} as never,
          new URL(`http://localhost${path}`),
          ctx,
        );
        assert.equal(handled, true);
        assert.equal(calls.length, 1);
        return calls[0];
      };

      const r = await call('GET', `/api/tasks/${taskId}/outbox`);
      assert.equal(r.status, 200);
      const body = r.body as {
        taskId: string;
        events: Array<OutboxEvent & { eventType: string }>;
      };
      assert.equal(body.taskId, taskId);
      // Batch 22 (F7): the HTTP shape carries eventType, derived from
      // the same rule as the outbox_events.event_type column.
      assert.deepEqual(
        body.events,
        committed.map((e) => ({ ...e, eventType: eventTypeOf(e) })),
      );

      const missing = await call('GET', '/api/tasks/no-such-task/outbox');
      assert.equal(missing.status, 404);
      b.fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F7 (Batch 22): GET /outbox exposes the DB event vocabulary — finalize events read WORKFLOW_FINALIZED', async () => {
    const { dir, file } = tmpDir();
    try {
      const w = makeWorld(file);
      const taskId = newTask(w, 'f7 event vocabulary');
      seedEvidence(w.evidence, taskId, PIN);
      walk(w.service, taskId, WALK);
      const done = w.service.complete(taskId, 'human', {});
      assert.equal(done.ok, true, JSON.stringify(done));
      w.fdb.close();

      const b = makeWorld(file);
      // NOTE: outboxView is asserted at the service level here, not
      // through handleV2TransitionRoutes: the route uses a process-wide
      // service singleton, which the earlier route-level test above has
      // already bound to its (now deleted) world — a test-isolation
      // artifact of the singleton, not of the product. The route handler
      // passes outboxView's return value straight through (covered
      // above), and the finalize vocabulary is what this test pins.
      const body = b.service.outboxView(taskId);
      assert.equal(body.taskId, taskId);
      // 11 transitions + 1 finalize.
      assert.equal(body.events.length, 12);
      for (const e of body.events.slice(0, -1)) {
        assert.equal(e.eventType, 'WORKFLOW_TRANSITIONED');
      }
      const last = body.events[body.events.length - 1];
      assert.equal(last.intent, 'REQUEST_COMPLETE');
      assert.equal(last.eventType, 'WORKFLOW_FINALIZED');
      // The HTTP value matches the event_type column the DB actually wrote.
      const rows = outboxRows(b.fdb, taskId);
      assert.deepEqual(
        body.events.map((e) => e.eventType),
        rows.map((row) => row.event_type),
      );
      b.fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------- real server (dist) e2e -- */

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

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

async function bootServer(dbFile: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
  };
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

async function killServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGKILL');
  await new Promise((r) => s.child.once('exit', r));
}

describe('durable outbox on the real server (§18.2)', () => {
  it('health counts pending, GET /outbox serves the event, both survive a kill + reboot', { timeout: 120_000 }, async () => {
    const { dir, file } = tmpDir();
    try {
      const a = await bootServer(file);
      let eventA: unknown;
      try {
        const health0 = await api(a.port, 'GET', '/api/health');
        assert.deepEqual(health0.body['outbox'], { store: 'sqlite', pending: 0 });

        const project = await api(a.port, 'POST', '/api/projects', {
          name: 'Outbox Demo',
          description: 'batch 17 e2e',
        });
        assert.equal(project.status, 201);
        const task = await api(a.port, 'POST', '/api/tasks', {
          projectId: project.body['id'],
          title: 'Commit one transition',
          goal: 'one durable outbox event',
        });
        assert.equal(task.status, 201);
        const taskId = task.body['id'] as string;

        const tr = await api(a.port, 'POST', `/api/tasks/${taskId}/v2-transition`, {
          toState: 'PLANNING',
          by: 'human',
          requirementVersion: 'REQ-001@1',
        });
        assert.equal(tr.status, 200);

        const out = await api(a.port, 'GET', `/api/tasks/${taskId}/outbox`);
        assert.equal(out.status, 200);
        const events = (out.body as { events: OutboxEvent[] }).events;
        assert.equal(events.length, 1);
        assert.equal(events[0].from, 'TODO');
        assert.equal(events[0].to, 'PLANNING');
        assert.equal(events[0].taskId, taskId);
        eventA = events[0];

        const health1 = await api(a.port, 'GET', '/api/health');
        assert.deepEqual(health1.body['outbox'], { store: 'sqlite', pending: 1 });
      } finally {
        await killServer(a);
      }

      // Boot B over the same file: the committed event is still
      // pending and is served identically.
      const b = await bootServer(file);
      try {
        const health = await api(b.port, 'GET', '/api/health');
        assert.deepEqual(health.body['outbox'], { store: 'sqlite', pending: 1 });
        const taskId = (eventA as OutboxEvent).taskId;
        const out = await api(b.port, 'GET', `/api/tasks/${taskId}/outbox`);
        assert.equal(out.status, 200);
        assert.deepEqual((out.body as { events: unknown[] }).events, [eventA]);
      } finally {
        await killServer(b);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

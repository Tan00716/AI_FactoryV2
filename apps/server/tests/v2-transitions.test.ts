/**
 * v2 transition route tests — SPEC_V2 §18.2 (gap G-18 wiring).
 *
 * The v2 engine is wired into the server: POST /api/tasks/:id/v2-transition
 * runs WorkflowEngineV2 gates, writes the result back to the DB task row on
 * success, and leaves the DB untouched on a gate denial.
 * GET /api/tasks/:id/v2-state exposes the three-state view.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditLog,
  EvidenceEngine,
  TaskManager,
} from '@ai-factory/core';
import { handleV2TransitionRoutes } from '../src/routes/v2-transitions.ts';

const tasks = new TaskManager();
const evidence = new EvidenceEngine();
const audit = new AuditLog();

function makeCtx(body: Record<string, unknown>) {
  const calls: Array<{ status: number; body: unknown }> = [];
  return {
    ctx: {
      tasks,
      evidence,
      audit,
      bus: { emit: () => {} },
      readBody: async () => body,
      json: (_res: unknown, status: number, b: unknown) => {
        calls.push({ status, body: b });
      },
    } as never,
    calls,
  };
}

async function call(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
) {
  const { ctx, calls } = makeCtx(body);
  const handled = await handleV2TransitionRoutes(
    { method } as never,
    {} as never,
    new URL(`http://localhost${path}`),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0];
}

function newTask(title: string): string {
  return tasks.create({ projectId: 'p1', title, creator: 'human' }).id;
}

describe('v2 transition wiring (§18.2, G-18)', () => {
  it('legal transition succeeds and writes the stage back to the DB', async () => {
    const id = newTask('v2 legal');
    const r = await call('POST', `/api/tasks/${id}/v2-transition`, {
      toState: 'PLANNING',
      by: 'human',
      requirementVersion: 'REQ-001@1',
    });
    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean; from: string; to: string; state: { stage: string } };
    assert.equal(body.ok, true);
    assert.equal(body.from, 'TODO');
    assert.equal(body.to, 'PLANNING');
    assert.equal(body.state.stage, 'PLANNING');
    // Write-back: the DB row moved too.
    assert.equal(tasks.get(id).status, 'PLANNING');
  });

  it('illegal jump is denied 422 and the DB is unchanged', async () => {
    const id = newTask('v2 illegal');
    const r = await call('POST', `/api/tasks/${id}/v2-transition`, {
      toState: 'QA',
      by: 'human',
      requirementVersion: 'REQ-001@1',
    });
    assert.equal(r.status, 422);
    const body = r.body as { ok: boolean; reasonCode: string };
    assert.equal(body.ok, false);
    assert.equal(body.reasonCode, 'POLICY_DENIED');
    assert.equal(tasks.get(id).status, 'TODO');
  });

  it('unpinned requirement is denied fail-closed (no fake pass)', async () => {
    const id = newTask('v2 unpinned');
    const r = await call('POST', `/api/tasks/${id}/v2-transition`, {
      toState: 'PLANNING',
      by: 'human',
      // no requirementVersion — the requirement-pinned gate must deny
    });
    assert.equal(r.status, 422);
    assert.equal(tasks.get(id).status, 'TODO');
  });

  it('missing required evidence is denied and the DB is unchanged', async () => {
    const id = newTask('v2 evidence gate');
    const seed = await call('POST', `/api/tasks/${id}/v2-transition`, {
      toState: 'PLANNING',
      by: 'human',
      requirementVersion: 'REQ-001@1',
    });
    assert.equal(seed.status, 200);
    const r = await call('POST', `/api/tasks/${id}/v2-transition`, {
      toState: 'IN_PROGRESS',
      by: 'human',
      requirementVersion: 'REQ-001@1',
      budgetOk: true,
      // no 'plan' evidence attached — PLANNING→IN_PROGRESS requires it
    });
    assert.equal(r.status, 422);
    assert.equal((r.body as { reasonCode: string }).reasonCode, 'MISSING_EVIDENCE');
    assert.equal(tasks.get(id).status, 'PLANNING');
  });

  it('GET v2-state returns the three-state view seeded from the DB', async () => {
    const id = newTask('v2 state view');
    const r = await call('GET', `/api/tasks/${id}/v2-state`);
    assert.equal(r.status, 200);
    const body = r.body as {
      stage: string;
      condition: { condition: string };
      milestones: Record<string, { achieved: boolean }>;
      dbStatus: string;
    };
    assert.equal(body.stage, 'TODO');
    assert.equal(body.condition.condition, 'ACTIVE');
    assert.equal(body.dbStatus, 'TODO');
    assert.equal(body.milestones['DONE'].achieved, false);
  });

  it('unknown task → 404 on both endpoints', async () => {
    const g = await call('GET', '/api/tasks/nope/v2-state');
    assert.equal(g.status, 404);
    const p = await call('POST', '/api/tasks/nope/v2-transition', {
      toState: 'PLANNING',
      requirementVersion: 'REQ-001@1',
    });
    assert.equal(p.status, 404);
  });

  it('missing or unknown target stage → 400', async () => {
    const id = newTask('v2 bad target');
    const missing = await call('POST', `/api/tasks/${id}/v2-transition`, {});
    assert.equal(missing.status, 400);
    const bogus = await call('POST', `/api/tasks/${id}/v2-transition`, {
      toState: 'BLOCKED', // a v1 exception status, not a v2 stage
    });
    assert.equal(bogus.status, 400);
  });
});

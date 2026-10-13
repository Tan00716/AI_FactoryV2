/**
 * §18.2 × §17.2 (Batch 18) — the v2 transition gate now reads the
 * task's own authorization axis: gateContext's authorization is the
 * caller's snapshot COMBINED with the axis, the axis overriding
 * whenever it is not AUTHORIZED. The engine predicates are untouched
 * — what changed is whose facts feed them.
 *
 *  1. A REVOKED task whose caller claims AUTHORIZED is denied at
 *     TODO→PLANNING with the authorization predicate named — the
 *     pre-Batch-18 behaviour (snapshot only) waved this through.
 *  2. A WAITING task is denied the same way (never dispatched).
 *  3. An AUTHORIZED task whose caller reports a lapsed actor-level
 *     authorization is STILL denied — the axis is a task-level fact
 *     and does not rescue the caller's snapshot (old behaviour kept).
 *  4. An AUTHORIZED task with an ordinary caller passes exactly as
 *     before (and a task that never touched the axis — the legacy
 *     shape — passes identically).
 *
 * Runs against dist like v2-transitions.test.ts (see its header for
 * why): requires `npm run build -w @ai-factory/server` first.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditLog,
  EvidenceEngine,
  TaskManager,
} from '@ai-factory/core';
import { handleV2TransitionRoutes } from '../dist/routes/v2-transitions.js';

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
  return calls[0]!;
}

const PLANNING_BODY = {
  toState: 'PLANNING',
  by: 'human',
  requirementVersion: 'REQ-001@1',
};

describe('v2 gate authorization — the §17.2 axis feeds the gate (Batch 18)', () => {
  it('a REVOKED task is denied even when the caller claims AUTHORIZED', async () => {
    const t = tasks.create({
      projectId: 'p1',
      title: 'revoked before planning',
      creator: 'human',
      authorizationStatus: 'DRAFT',
    });
    tasks.requestDispatch(t.id);
    tasks.dispatch(t.id);
    tasks.revokeAuthorization(t.id);

    const r = await call('POST', `/api/tasks/${t.id}/v2-transition`, {
      ...PLANNING_BODY,
      authorizationStatus: 'AUTHORIZED', // the caller's claim
    });
    assert.equal(r.status, 422);
    const body = r.body as { ok: boolean; reasonCode: string; missing: string[] };
    assert.equal(body.ok, false);
    assert.equal(body.reasonCode, 'AUTHORIZATION_EXPIRED');
    assert.ok(
      body.missing.some((m) => m.includes('[authorization-valid]')),
      JSON.stringify(body.missing),
    );
    assert.equal(tasks.get(t.id).status, 'TODO');
  });

  it('a WAITING_HUMAN_DISPATCH task is denied — dispatch never happened', async () => {
    const t = tasks.create({
      projectId: 'p1',
      title: 'waiting for dispatch',
      creator: 'human',
      authorizationStatus: 'WAITING_HUMAN_DISPATCH',
    });
    const r = await call('POST', `/api/tasks/${t.id}/v2-transition`, {
      ...PLANNING_BODY,
    });
    assert.equal(r.status, 422);
    const body = r.body as { missing: string[] };
    assert.ok(body.missing.some((m) => m.includes('[authorization-valid]')));
    assert.equal(tasks.get(t.id).status, 'TODO');
  });

  it('an AUTHORIZED task does not rescue a caller reporting REVOKED', async () => {
    const t = tasks.create({
      projectId: 'p1',
      title: 'authorized task, lapsed actor',
      creator: 'human',
    });
    assert.equal(tasks.get(t.id).authorizationStatus, 'AUTHORIZED');
    const r = await call('POST', `/api/tasks/${t.id}/v2-transition`, {
      ...PLANNING_BODY,
      authorizationStatus: 'REVOKED',
    });
    assert.equal(r.status, 422);
    assert.equal(tasks.get(t.id).status, 'TODO');
  });

  it('an AUTHORIZED task with an ordinary caller passes, as before', async () => {
    const t = tasks.create({
      projectId: 'p1',
      title: 'ordinary authorized',
      creator: 'human',
    });
    const r = await call('POST', `/api/tasks/${t.id}/v2-transition`, {
      ...PLANNING_BODY,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(tasks.get(t.id).status, 'PLANNING');
  });

  it('dispatching a DRAFT task through the axis opens the gate', async () => {
    const t = tasks.create({
      projectId: 'p1',
      title: 'draft then dispatched',
      creator: 'human',
      authorizationStatus: 'DRAFT',
    });
    const denied = await call('POST', `/api/tasks/${t.id}/v2-transition`, {
      ...PLANNING_BODY,
    });
    assert.equal(denied.status, 422);
    tasks.requestDispatch(t.id);
    tasks.dispatch(t.id);
    const allowed = await call('POST', `/api/tasks/${t.id}/v2-transition`, {
      ...PLANNING_BODY,
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(tasks.get(t.id).status, 'PLANNING');
  });
});

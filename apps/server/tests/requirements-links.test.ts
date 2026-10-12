/**
 * Requirement links + promotion-hold FULL HTTP chain — SPEC_V2 §16 (G-05).
 *
 * Batch 2 added the hold gate (promotion-check → 409) but the chain could
 * never be exercised over HTTP: there was no route to bind a task to a
 * requirement version, so analyzeImpact() never suspended anything.
 * This test drives the whole chain through the route handlers:
 *   create → new version → POST /links (bind task-7 to v1) → POST /impact
 *   → promotion-check(task-7) = 409 → release hold → promotion-check = 200.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequirementRoutes } from '../src/routes/requirements.ts';

function makeCtx(body: Record<string, unknown>) {
  const calls: Array<{ status: number; body: unknown }> = [];
  return {
    ctx: {
      audit: { record: () => {} },
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
  const handled = await handleRequirementRoutes(
    { method } as never,
    {} as never,
    new URL(`http://localhost${path}`),
    ctx,
  );
  assert.equal(handled, true, `${method} ${path} should be handled`);
  assert.equal(calls.length, 1);
  return calls[0];
}

const AC = [
  {
    id: 'AC-001',
    description: 'the thing works',
    verificationType: 'AUTOMATED_TEST',
    verifiedBy: 'INDEPENDENT_QA',
    expectedEvidence: 'qa_result with verdict PASS',
    applicableEnvironments: ['DEV'],
  },
];

describe('requirement links + promotion hold chain (§16, G-05)', () => {
  it('binds task-7 via /links, impact suspends it (409), release re-allows it (200)', async () => {
    // 1. create requirement (v1)
    const created = await call('POST', '/api/requirements', {
      id: 'REQ-B3-CHAIN',
      businessGoal: 'ship the thing',
      acceptanceCriteria: AC,
    });
    assert.equal(created.status, 201);

    // 2. add version 2
    const v2 = await call('POST', '/api/requirements/REQ-B3-CHAIN/versions', {
      changeKind: 'SCOPE_CHANGE',
      changeNote: 'scope grew',
      patch: { businessGoal: 'ship the bigger thing' },
    });
    assert.equal(v2.status, 201);

    // control: task-7 is not held before any linking/impact
    const before = await call('POST', '/api/requirements/promotion-check', {
      taskId: 'task-7',
    });
    assert.equal(before.status, 200);
    assert.deepEqual(before.body, { allowed: true });

    // 3. bind task-7 to version 1 over HTTP
    const linked = await call('POST', '/api/requirements/REQ-B3-CHAIN/links', {
      version: 1,
      taskIds: ['task-7'],
    });
    assert.equal(linked.status, 200);
    const links = (linked.body as { links: { taskIds: string[] } }).links;
    assert.deepEqual(links.taskIds, ['task-7']);

    // 4. impact analysis v1 → v2 suspends task-7's promotion
    const impact = await call('POST', '/api/requirements/REQ-B3-CHAIN/impact', {
      fromVersion: 1,
      toVersion: 2,
    });
    assert.equal(impact.status, 200);
    const suspended = (
      impact.body as { impact: { suspendedPromotions: Array<{ taskId: string }> } }
    ).impact.suspendedPromotions;
    assert.equal(suspended.length, 1);
    assert.equal(suspended[0].taskId, 'task-7');

    // 5. THE 409 — at the HTTP layer, for real this time
    const held = await call('POST', '/api/requirements/promotion-check', {
      taskId: 'task-7',
    });
    assert.equal(held.status, 409);
    const heldBody = held.body as {
      allowed: boolean;
      holds: Array<{ id: string; taskId: string }>;
    };
    assert.equal(heldBody.allowed, false);
    assert.equal(heldBody.holds.length, 1);
    assert.equal(heldBody.holds[0].taskId, 'task-7');

    // an unrelated task is NOT held (per-task isolation over HTTP)
    const other = await call('POST', '/api/requirements/promotion-check', {
      taskId: 'task-other',
    });
    assert.equal(other.status, 200);

    // 6. release the hold, promotion is allowed again
    const released = await call(
      'POST',
      `/api/requirements/holds/${heldBody.holds[0].id}/release`,
      { by: 'human', revalidationNote: 're-planned and re-authorized' },
    );
    assert.equal(released.status, 200);

    const after = await call('POST', '/api/requirements/promotion-check', {
      taskId: 'task-7',
    });
    assert.equal(after.status, 200);
    assert.deepEqual(after.body, { allowed: true });
  });

  it('links fails closed: missing version → 400, unknown version → 400, bad field type → 400', async () => {
    const created = await call('POST', '/api/requirements', {
      id: 'REQ-B3-FAILCLOSED',
      businessGoal: 'g',
      acceptanceCriteria: AC,
    });
    assert.equal(created.status, 201);

    const noVersion = await call('POST', '/api/requirements/REQ-B3-FAILCLOSED/links', {
      taskIds: ['task-1'],
    });
    assert.equal(noVersion.status, 400);

    const badVersion = await call('POST', '/api/requirements/REQ-B3-FAILCLOSED/links', {
      version: 99,
      taskIds: ['task-1'],
    });
    assert.equal(badVersion.status, 400);

    const badField = await call('POST', '/api/requirements/REQ-B3-FAILCLOSED/links', {
      version: 1,
      taskIds: 'task-1',
    });
    assert.equal(badField.status, 400);

    // nothing was linked by the failed calls
    const ok = await call('POST', '/api/requirements/REQ-B3-FAILCLOSED/links', {
      version: 1,
      taskIds: ['task-2'],
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(
      (ok.body as { links: { taskIds: string[] } }).links.taskIds,
      ['task-2'],
    );
  });
});

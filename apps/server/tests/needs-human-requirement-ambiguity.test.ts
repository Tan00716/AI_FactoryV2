/**
 * Batch 42 — §81 'requirement-ambiguity' emission on AC-refinement churn.
 *
 * What this pins:
 *  1. The deterministic pattern is N consecutive versions with
 *     changeKind === 'AC_REFINEMENT' on the same requirement — a
 *     deterministic count of structured, recorded events. This is NOT
 *     the QA regex heuristic (packages/qa/src/classify.ts AMBIGUITY_RE),
 *     which Batch 38-4 rejected as "heuristic masquerading as
 *     deterministic".
 *  2. A single refinement is the system working as designed — no
 *     emission. The emission fires on the PATTERN at
 *     REQUIREMENT_REFINEMENT_ESCALATION_THRESHOLD (3), the same
 *     precedent as stagnationLimit=3 / POLICY_DENIAL_ESCALATION_THRESHOLD.
 *  3. The record is honest: detail states the observed pattern (N
 *     consecutive refinements, clarification not converging), not a
 *     proven verdict. reason 'requirement-ambiguity', severity 'medium'
 *     (from @ai-factory/autonomy's REASON_SEVERITY), recipient null (no
 *     named human accounts), requiredDeciderLevel 'manager' (mapping
 *     choice documented in the route: requirement meaning is a
 *     product/business judgment).
 *  4. Circuit breaker: while the upgrade is OPEN, further autonomous
 *     refinements 409 (REQUIREMENT_REFINEMENT_PAUSED); after a human
 *     resolves it, the next threshold-crossing opens a new episode.
 *  5. Write-through failure never breaks the refinement: the 201 is
 *     still returned and NEEDS_HUMAN_PERSIST_FAILED is audited.
 *
 * Tests import the route from src (dual-mode: requirements.ts keeps no
 * extensionless relative VALUE imports — './context' and '@ai-factory/db'
 * are type-only; '@ai-factory/autonomy' is a package import).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryNeedsHumanStore } from '@ai-factory/db';
import {
  handleRequirementRoutes,
  REQUIREMENT_REFINEMENT_ESCALATION_THRESHOLD,
  buildRequirementAmbiguityUpgradeRecord,
  isRefinementPaused,
  requirementRefinementUpgradeSource,
} from '../src/routes/requirements.ts';
import type { RouteContext } from '../src/routes/context.ts';

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

function makeCtx() {
  const needsHuman = new InMemoryNeedsHumanStore();
  const audits: Array<{ actor: string; action: string }> = [];
  let body: Record<string, unknown> = {};
  const calls: Array<{ status: number; body: unknown }> = [];
  const ctx = {
    audit: {
      record: (actor: string, action: string) => {
        audits.push({ actor, action });
      },
    },
    fdb: { needsHuman },
    readBody: async () => body,
    json: (_res: unknown, status: number, b: unknown) => {
      calls.push({ status, body: b });
    },
  } as unknown as RouteContext;
  return {
    ctx,
    needsHuman,
    audits,
    calls,
    setBody(b: Record<string, unknown>) {
      body = b;
    },
  };
}

async function call(
  t: ReturnType<typeof makeCtx>,
  method: string,
  path: string,
  body: Record<string, unknown> = {},
) {
  t.setBody(body);
  t.calls.length = 0;
  const handled = await handleRequirementRoutes(
    { method } as never,
    {} as never,
    new URL(`http://localhost${path}`),
    t.ctx,
  );
  assert.equal(handled, true, `${method} ${path} should be handled`);
  assert.equal(t.calls.length, 1);
  return t.calls[0]!;
}

async function createReq(t: ReturnType<typeof makeCtx>, id: string) {
  const r = await call(t, 'POST', '/api/requirements', {
    id,
    businessGoal: 'ship the thing',
    acceptanceCriteria: AC,
  });
  assert.equal(r.status, 201);
}

async function refine(
  t: ReturnType<typeof makeCtx>,
  id: string,
  note: string,
) {
  return call(t, 'POST', `/api/requirements/${id}/ac-refinement`, {
    acId: 'AC-001',
    patch: { description: `clarified: ${note}` },
    by: 'agent:pm-1',
  });
}

describe("§81 'requirement-ambiguity' on AC-refinement churn (Batch 42)", () => {
  it('emits at the threshold with an honest record shape', async () => {
    assert.equal(REQUIREMENT_REFINEMENT_ESCALATION_THRESHOLD, 3);
    const t = makeCtx();
    const id = 'REQ-42-AMB-EMIT';
    await createReq(t, id);
    assert.equal((await refine(t, id, 'one')).status, 201);
    assert.equal((await refine(t, id, 'two')).status, 201);
    assert.deepEqual(t.needsHuman.list('open'), []);
    const third = await refine(t, id, 'three');
    assert.equal(third.status, 201);

    const open = t.needsHuman.list('open');
    assert.equal(open.length, 1);
    const rec = open[0]!;
    assert.equal(rec.reason, 'requirement-ambiguity');
    assert.equal(rec.reasonZh, '需求歧义');
    assert.equal(rec.severity, 'medium');
    assert.equal(rec.recipient, null);
    assert.equal(rec.requiredDeciderLevel, 'manager');
    assert.equal(
      rec.source,
      requirementRefinementUpgradeSource(id),
    );
    const detail = JSON.parse(rec.detailJson) as {
      requirementId: string;
      refinementCount: number;
    };
    assert.equal(detail.requirementId, id);
    assert.equal(detail.refinementCount, 3);
    const raised = t.audits.find((a) => a.action === 'NEEDS_HUMAN_RAISED');
    assert.ok(raised, 'NEEDS_HUMAN_RAISED audited');
  });

  it('a non-refinement version breaks the streak — no emission', async () => {
    const t = makeCtx();
    const id = 'REQ-42-AMB-STREAK';
    await createReq(t, id);
    assert.equal((await refine(t, id, 'one')).status, 201);
    assert.equal((await refine(t, id, 'two')).status, 201);
    // SCOPE_CHANGE is not a clarification — streak resets.
    const v = await call(t, 'POST', `/api/requirements/${id}/versions`, {
      changeKind: 'SCOPE_CHANGE',
      changeNote: 'scope grew',
      patch: { businessGoal: 'ship the bigger thing' },
    });
    assert.equal(v.status, 201);
    assert.equal((await refine(t, id, 'three')).status, 201);
    assert.equal((await refine(t, id, 'four')).status, 201);
    assert.deepEqual(t.needsHuman.list('open'), []);
  });

  it('pauses further refinements with 409 while OPEN; new episode after resolve', async () => {
    const t = makeCtx();
    const id = 'REQ-42-AMB-PAUSE';
    await createReq(t, id);
    await refine(t, id, 'one');
    await refine(t, id, 'two');
    await refine(t, id, 'three');
    assert.equal(t.needsHuman.list('open').length, 1);
    assert.equal(isRefinementPaused(t.ctx, id), true);

    const paused = await refine(t, id, 'four');
    assert.equal(paused.status, 409);
    assert.equal(
      (paused.body as { code: string }).code,
      'REQUIREMENT_REFINEMENT_PAUSED',
    );
    // No second record while OPEN.
    assert.equal(t.needsHuman.list('open').length, 1);

    // Human resolves → refinement resumes; streak (now 4) re-emits.
    const first = t.needsHuman.list('open')[0]!;
    assert.equal(
      t.needsHuman.resolve(first.id, 'resolved', 'human:po', 'ACs clear now', Date.now()),
      true,
    );
    assert.equal(isRefinementPaused(t.ctx, id), false);
    const resumed = await refine(t, id, 'five');
    assert.equal(resumed.status, 201);
    const open = t.needsHuman.list('open');
    assert.equal(open.length, 1);
    assert.notEqual(open[0]!.id, first.id);
  });

  it('write-through failure is audited and never breaks the 201', async () => {
    const t = makeCtx();
    const id = 'REQ-42-AMB-PERSIST';
    await createReq(t, id);
    await refine(t, id, 'one');
    await refine(t, id, 'two');
    // Break the store's submit; list() still works for the pause check.
    const store = t.needsHuman;
    const broken = Object.create(Object.getPrototypeOf(store));
    Object.assign(broken, store);
    broken.submit = () => {
      throw new Error('db down');
    };
    (t.ctx as unknown as { fdb: { needsHuman: unknown } }).fdb.needsHuman =
      broken;
    const third = await refine(t, id, 'three');
    assert.equal(third.status, 201);
    const failed = t.audits.find(
      (a) => a.action === 'NEEDS_HUMAN_PERSIST_FAILED',
    );
    assert.ok(failed, 'NEEDS_HUMAN_PERSIST_FAILED audited');
  });

  it('pure builder + helpers behave without HTTP', () => {
    const rec = buildRequirementAmbiguityUpgradeRecord({
      requirementId: 'REQ-X',
      refinementCount: 5,
      latestVersion: 6,
    });
    assert.equal(rec.reason, 'requirement-ambiguity');
    assert.equal(rec.source, 'requirement-refinement:REQ-X');
    assert.equal(rec.status, 'open');
    assert.equal(
      requirementRefinementUpgradeSource('REQ-X'),
      'requirement-refinement:REQ-X',
    );
    const t = makeCtx();
    assert.equal(isRefinementPaused(t.ctx, 'REQ-X'), false);
  });
});

/**
 * Router route: fallback compatibility on the DEFAULT path — §27.2
 * (Batch 5, G-57 residual).
 *
 * POST /api/router/route used to call route() bare, so the fallback was
 * the next-best model with NO compatibility check. The handler now
 * injects buildQuotaFallbackChecker() — an adapter over
 * @ai-factory/quota's checkFallbackCompatibility — so the default path
 * really checks. These tests pin:
 *  - the endpoint's decision reason shows the check RAN (never the
 *    router's 'not checked' note);
 *  - the adapter maps ModelRef/RouteRequest onto quota's inputs
 *    faithfully (privacy tier → data classes, capability booleans →
 *    capability strings, ordinal context).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRef, RouteDecision, RouteRequest } from '@ai-factory/model-router';
import {
  buildQuotaFallbackChecker,
  handleModelRouterRoutes,
} from '../src/routes/model-router.ts';

function makeCtx(body: Record<string, unknown>) {
  const calls: Array<{ status: number; body: unknown }> = [];
  return {
    ctx: {
      readBody: async () => body,
      json: (_res: unknown, status: number, b: unknown) => {
        calls.push({ status, body: b });
        return undefined;
      },
    } as never,
    calls,
  };
}

async function postRoute(body: Record<string, unknown>) {
  const { ctx, calls } = makeCtx(body);
  const handled = await handleModelRouterRoutes(
    { method: 'POST' } as never,
    {} as never,
    new URL('http://localhost/api/router/route'),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.status, 200);
  return calls[0]!.body as RouteDecision;
}

const A_MODEL: ModelRef = {
  provider: 'shared',
  model: 'some-model',
  capabilities: { reasoning: true, vision: false, tools: true, maxContext: 'large' },
  costTier: 'high',
  latencyTier: 'low',
  availability: 'online',
};

function aRequest(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    taskType: 'coding',
    complexity: 3,
    requiredTools: [],
    latencyPref: 'low',
    costPref: 'low',
    privacy: 'public',
    needsReasoning: false,
    contextNeeded: 'small',
    needsVision: false,
    currentUsage: { usedPct: 0 },
    ...over,
  };
}

describe('POST /api/router/route fallback compatibility (§27.2)', () => {
  it('default path injects the quota checker — decision reason shows the check ran', async () => {
    const d = await postRoute({ taskType: 'coding', complexity: 1 });
    assert.equal(d.primary!.model, 'code-coder');
    assert.equal(d.fallback!.model, 'fast-classifier');
    assert.match(d.reason, /fallback compatibility: checked, compatible/);
    assert.doesNotMatch(d.reason, /not checked/);
  });

  it('adapter rejects a non-local candidate for sensitive data (privacy dimension is real)', () => {
    const checker = buildQuotaFallbackChecker();
    const v = checker(A_MODEL, { ...A_MODEL, provider: 'shared' }, aRequest({ privacy: 'sensitive' }));
    assert.equal(v.compatible, false);
    assert.ok(v.reasons.some((r) => r.includes('would expose data classes: sensitive')));
    // …while a local candidate IS cleared for the same task.
    const local = checker(A_MODEL, { ...A_MODEL, provider: 'local' }, aRequest({ privacy: 'sensitive' }));
    assert.equal(local.compatible, true);
  });

  it('adapter rejects a candidate missing a required capability (capability dimension is real)', () => {
    const checker = buildQuotaFallbackChecker();
    const noVision: ModelRef = {
      ...A_MODEL,
      capabilities: { reasoning: true, vision: false, tools: true, maxContext: 'large' },
    };
    const v = checker(A_MODEL, noVision, aRequest({ needsVision: true }));
    assert.equal(v.compatible, false);
    assert.ok(v.reasons.some((r) => r.includes('missing capabilities: vision')));
    // Ordinal context: a large-context candidate covers a medium requirement.
    const ctxOk = checker(A_MODEL, A_MODEL, aRequest({ contextNeeded: 'medium' }));
    assert.equal(ctxOk.compatible, true);
  });
});

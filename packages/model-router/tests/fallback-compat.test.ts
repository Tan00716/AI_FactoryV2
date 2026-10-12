/**
 * §27.2 — fallback compatibility gate in route() (Batch 5, G-57 residual).
 *
 * The router owns no quota state, so the compatibility check is INJECTED
 * via RouteRequest.fallbackChecker (a one-line adapter over
 * @ai-factory/quota's checkFallbackCompatibility satisfies the type; the
 * server route wires exactly that). These tests pin the router-side
 * contract:
 *  - an incompatible next-best candidate is SKIPPED for the next one;
 *  - when every candidate is incompatible, fallback is null and the
 *    reason carries the checked/rejected counts — never a silent pick;
 *  - with no checker injected, selection is exactly the pre-gate
 *    behavior, and the reason honestly says the check did not run;
 *  - primary/emergency selection is untouched by the gate.
 *
 * Run: node --test dist/tests/fallback-compat.test.js  (after tsc)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  route,
  type FallbackCompatibilityChecker,
  type ModelRef,
  type RouteRequest,
} from '../src/index';

/** Deterministic scores for the request below: code-coder 140, fast-classifier 20, local-private 0. */
const CATALOG: ModelRef[] = [
  {
    provider: 'shared',
    model: 'code-coder',
    capabilities: { reasoning: true, vision: false, tools: true, maxContext: 'large' },
    costTier: 'high',
    latencyTier: 'low',
    availability: 'online',
  },
  {
    provider: 'shared',
    model: 'fast-classifier',
    capabilities: { reasoning: false, vision: false, tools: true, maxContext: 'small' },
    costTier: 'low',
    latencyTier: 'low',
    availability: 'online',
  },
  {
    provider: 'local',
    model: 'local-private',
    capabilities: { reasoning: false, vision: false, tools: true, maxContext: 'medium' },
    costTier: 'low',
    latencyTier: 'high',
    availability: 'online',
  },
];

function baseRequest(): RouteRequest {
  return {
    taskType: 'coding',
    complexity: 1,
    requiredTools: [],
    latencyPref: 'low',
    costPref: 'high',
    privacy: 'public',
    needsReasoning: false,
    contextNeeded: 'small',
    needsVision: false,
    currentUsage: { usedPct: 10 },
  };
}

const rejectFastClassifier: FallbackCompatibilityChecker = (_primary, candidate) =>
  candidate.model === 'fast-classifier'
    ? { compatible: false, reasons: ['would expose data classes: sensitive'] }
    : { compatible: true, reasons: [] };

const rejectAll: FallbackCompatibilityChecker = (_primary, candidate) => ({
  compatible: false,
  reasons: [`${candidate.model} is not cleared for this task`],
});

const acceptAll: FallbackCompatibilityChecker = () => ({ compatible: true, reasons: [] });

describe('route() fallback compatibility gate (§27.2)', () => {
  it('skips an incompatible next-best candidate and picks the next compatible one', () => {
    const d = route({ ...baseRequest(), fallbackChecker: rejectFastClassifier }, CATALOG);
    assert.equal(d.primary!.model, 'code-coder');
    assert.equal(d.fallback!.model, 'local-private');
    assert.match(d.reason, /skipped 1 incompatible candidate\(s\)/);
    assert.match(d.reason, /fast-classifier: would expose data classes: sensitive/);
  });

  it('returns fallback=null with checked/rejected counts when every candidate is incompatible', () => {
    const d = route({ ...baseRequest(), fallbackChecker: rejectAll }, CATALOG);
    assert.equal(d.fallback, null);
    assert.match(d.reason, /fallback: none compatible \(checked 2, rejected 2\)/);
    assert.match(d.reason, /fallback=none/);
    // Primary and emergency are not the gate's business.
    assert.equal(d.primary!.model, 'code-coder');
    assert.equal(d.emergency!.model, 'local-private');
    assert.equal(d.unavailable, false);
  });

  it('without a checker, selection is unchanged and the reason says the check did not run', () => {
    const d = route(baseRequest(), CATALOG);
    assert.equal(d.primary!.model, 'code-coder');
    assert.equal(d.fallback!.model, 'fast-classifier');
    assert.match(d.reason, /fallback compatibility not checked \(no checker injected\)/);
  });

  it('with a checker that accepts the next-best candidate, fallback is unchanged and noted as checked', () => {
    const d = route({ ...baseRequest(), fallbackChecker: acceptAll }, CATALOG);
    assert.equal(d.fallback!.model, 'fast-classifier');
    assert.match(d.reason, /fallback compatibility: checked, compatible/);
  });

  it('checker receives the primary, the candidate and the original request', () => {
    const seen: Array<{ primary: string; candidate: string; taskType: string }> = [];
    const spy: FallbackCompatibilityChecker = (primary, candidate, request) => {
      seen.push({ primary: primary.model, candidate: candidate.model, taskType: request.taskType });
      return { compatible: true, reasons: [] };
    };
    route({ ...baseRequest(), fallbackChecker: spy }, CATALOG);
    assert.deepEqual(seen, [
      { primary: 'code-coder', candidate: 'fast-classifier', taskType: 'coding' },
    ]);
  });
});

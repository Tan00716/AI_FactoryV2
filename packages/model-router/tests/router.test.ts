/**
 * Tests for the deterministic model router (spec §30, §29).
 * Run: node --test dist/tests/router.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAccountStatus,
  MODEL_CATALOG,
  route,
  type RouteRequest,
} from '../src/index';

function baseRequest(): RouteRequest {
  return {
    taskType: 'classification',
    complexity: 1,
    requiredTools: [],
    latencyPref: 'low',
    costPref: 'low',
    privacy: 'public',
    needsReasoning: false,
    contextNeeded: 'small',
    needsVision: false,
    currentUsage: { usedPct: 10 },
  };
}

describe('route', () => {
  it('routes privacy=sensitive tasks to the local model (§30)', () => {
    const d = route({ ...baseRequest(), privacy: 'sensitive', taskType: 'coding', complexity: 5 });
    assert.equal(d.primary!.model, 'local-private');
    assert.equal(d.primary!.provider, 'local');
    assert.match(d.reason, /privacy=sensitive/);
  });

  it('routes vision tasks to the vision-capable model', () => {
    const d = route({ ...baseRequest(), taskType: 'vision', needsVision: true });
    assert.equal(d.primary!.model, 'vision-capable');
    assert.ok(d.primary!.capabilities.vision);
  });

  it('routes simple classification to the fast model (§30)', () => {
    const d = route(baseRequest());
    assert.equal(d.primary!.model, 'fast-classifier');
    assert.match(d.reason, /simple classification/);
  });

  it('prefers local/fallback when the shared pool is exhausted (§29)', () => {
    const d = route({ ...baseRequest(), currentUsage: { usedPct: 100 } });
    assert.equal(d.primary!.model, 'local-private');
    assert.match(d.reason, /pool exhausted/);
    assert.match(d.reason, /shared across agents/);
  });

  it('does not treat 99% usage as exhausted', () => {
    const d = route({ ...baseRequest(), currentUsage: { usedPct: 99 } });
    assert.equal(d.primary!.model, 'fast-classifier');
  });

  it('routes complex coding to the code-coder primary (§30)', () => {
    const d = route({
      ...baseRequest(),
      taskType: 'coding',
      complexity: 5,
      needsReasoning: true,
      contextNeeded: 'large',
      requiredTools: ['shell'],
    });
    assert.equal(d.primary!.model, 'code-coder');
    assert.match(d.reason, /complexity=5/);
  });

  it('routes deep architecture to the reasoning model (§30)', () => {
    const d = route({
      ...baseRequest(),
      taskType: 'architecture',
      complexity: 5,
      needsReasoning: true,
      contextNeeded: 'large',
    });
    assert.equal(d.primary!.model, 'reasoning-architect');
  });

  it('filters out models that cannot meet the context requirement', () => {
    const d = route({ ...baseRequest(), contextNeeded: 'large' });
    assert.notEqual(d.primary!.model, 'fast-classifier');
    assert.notEqual(d.primary!.model, 'local-private');
  });

  it('always returns distinct primary/fallback and a local-or-fast emergency', () => {
    for (const taskType of ['coding', 'research', 'testing', 'review'] as const) {
      const d = route({ ...baseRequest(), taskType, complexity: 3 });
      assert.notEqual(d.fallback!.model, d.primary!.model);
      assert.ok(
        d.emergency!.model === 'local-private' || d.emergency!.model === 'fast-classifier',
        `unexpected emergency ${d.emergency!.model}`,
      );
    }
  });

  it('is deterministic: same request → same decision', () => {
    const req = { ...baseRequest(), taskType: 'research' as const, complexity: 4 as const };
    const a = route(req);
    const b = route(req);
    assert.deepEqual(a, b);
  });

  it('seeds the documented generic catalog', () => {
    const models = MODEL_CATALOG.map((m) => m.model).sort();
    assert.deepEqual(models, [
      'code-coder',
      'fast-classifier',
      'local-private',
      'reasoning-architect',
      'vision-capable',
    ]);
  });
});

describe('getAccountStatus', () => {
  it('returns the §29 account-status shape as a stub', () => {
    const s = getAccountStatus({ usedPct: 42 });
    assert.equal(s.profile.kind, 'chatgpt-oauth');
    assert.equal(s.usage.usedPct, 42);
    assert.equal(s.usage.authenticated, false);
    assert.ok(s.profile.plan?.includes('shared 5h pool'));
  });
});

describe('INV-29 availability (no silent degradation)', () => {
  it('never selects an offline model as primary', () => {
    const catalog = MODEL_CATALOG.map((m) =>
      m.model === 'fast-classifier' ? { ...m } : { ...m, availability: 'offline' as const },
    );
    const d = route(baseRequest(), catalog);
    assert.equal(d.unavailable, false);
    assert.equal(d.primary!.model, 'fast-classifier');
    assert.notEqual(d.primary!.availability, 'offline');
  });

  it('reports unavailability explicitly when every model is offline', () => {
    const catalog = MODEL_CATALOG.map((m) => ({ ...m, availability: 'offline' as const }));
    const d = route(baseRequest(), catalog);
    assert.equal(d.unavailable, true);
    assert.equal(d.primary, null);
    assert.equal(d.fallback, null);
    assert.equal(d.emergency, null);
    assert.match(d.reason, /INV-29/);
    assert.match(d.reason, /all .* offline/);
  });

  it('reports unavailability when hard constraints eliminate everything', () => {
    const d = route({ ...baseRequest(), needsVision: true, privacy: 'sensitive' }, [
      {
        provider: 'cloud',
        model: 'vision-only-cloud',
        capabilities: { vision: true, tools: false, reasoning: false, maxContext: 'small' },
        costTier: 'low',
        latencyTier: 'low',
        availability: 'online',
      },
    ]);
    assert.equal(d.unavailable, true);
    assert.equal(d.primary, null);
    assert.match(d.reason, /no model satisfied all hard constraints/);
  });
});

/**
 * §26.1 Model Capability Metadata completion (Batch 8).
 *
 * Pins:
 *  - every seed-catalog entry declares the FULL §26.1 field set
 *    (structured output, streaming, cancellation, resume/session,
 *    allowed data classes, quota bucket, supported hosts) — the values
 *    are declared seed values (see catalog.ts honesty note), but none
 *    may be missing;
 *  - RouteRequest's optional needs* capability requirements hard-filter
 *    candidates and the decision reason NAMES the capability and how
 *    many models it excluded;
 *  - data-class clearance follows a model's declared dataClasses, with
 *    the legacy provider rule applying only when undeclared;
 *  - pre-§26.1 request shapes (no needs* flags) route exactly as before.
 *
 * Run: node --test dist/tests/capabilities.test.js  (after tsc)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityGaps,
  clearedForDataClass,
  MODEL_CATALOG,
  registryRows,
  route,
  type ModelRef,
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

describe('§26.1 catalog completeness', () => {
  it('every seed entry declares all §26.1 capability fields', () => {
    for (const m of MODEL_CATALOG) {
      const c = m.capabilities;
      assert.equal(typeof c.reasoning, 'boolean', `${m.model}.reasoning`);
      assert.equal(typeof c.vision, 'boolean', `${m.model}.vision`);
      assert.equal(typeof c.tools, 'boolean', `${m.model}.tools`);
      assert.ok(['small', 'medium', 'large'].includes(c.maxContext), `${m.model}.maxContext`);
      assert.equal(typeof c.structuredOutput, 'boolean', `${m.model}.structuredOutput`);
      assert.equal(typeof c.streaming, 'boolean', `${m.model}.streaming`);
      assert.equal(typeof c.cancellation, 'boolean', `${m.model}.cancellation`);
      assert.equal(typeof c.resume, 'boolean', `${m.model}.resume`);
      assert.ok(
        Array.isArray(c.dataClasses) && c.dataClasses.length > 0,
        `${m.model}.dataClasses must be a non-empty declared list`,
      );
      for (const dc of c.dataClasses!) {
        assert.ok(['public', 'internal', 'sensitive'].includes(dc), `${m.model} dataClass ${dc}`);
      }
      assert.ok(
        typeof c.quotaBucket === 'string' && c.quotaBucket.length > 0,
        `${m.model}.quotaBucket`,
      );
      assert.ok(
        Array.isArray(c.supportedHosts) && c.supportedHosts.length > 0,
        `${m.model}.supportedHosts must be a non-empty declared list`,
      );
    }
  });

  it('registry rows expose the §26.1 fields for every catalog model', () => {
    for (const row of registryRows()) {
      assert.ok(Array.isArray(row.dataClasses) && row.dataClasses.length > 0, row.model);
      assert.ok(typeof row.quotaBucket === 'string' && row.quotaBucket.length > 0, row.model);
      assert.ok(row.supportedHosts.length > 0, row.model);
    }
    const local = registryRows().find((r) => r.model === 'local-private')!;
    assert.deepEqual(local.dataClasses, ['public', 'internal', 'sensitive']);
    assert.equal(local.quotaBucket, 'local');
    assert.deepEqual(local.supportedHosts, ['local']);
  });

  it('registry row reports undeclared §26.1 fields honestly (null / empty, never invented)', () => {
    const row = registryRows([
      {
        provider: 'x',
        model: 'bare',
        capabilities: { reasoning: false, vision: false, tools: false, maxContext: 'small' },
        costTier: 'low',
        latencyTier: 'low',
      },
    ])[0];
    assert.equal(row.dataClasses, null);
    assert.equal(row.quotaBucket, null);
    assert.deepEqual(row.supportedHosts, []);
  });
});

describe('§26.1 capability requirements in route()', () => {
  it('needsStructuredOutput excludes models lacking it and names the capability in the reason', () => {
    // vision task: only vision-capable has vision, and it declares
    // structuredOutput=false → nothing survives; the reason must say why.
    const d = route({ ...baseRequest(), taskType: 'vision', needsVision: true, needsStructuredOutput: true });
    assert.equal(d.unavailable, true);
    assert.equal(d.primary, null);
    assert.match(d.reason, /structured output/);
    assert.match(d.reason, /§26\.1/);
  });

  it('needsStreaming changes the pick when the natural fit cannot stream', () => {
    // fast-classifier is the classification fit but declares streaming=false;
    // code-coder and vision-capable tie on score, catalog order breaks the tie.
    const d = route({ ...baseRequest(), needsStreaming: true });
    assert.equal(d.unavailable, false);
    assert.equal(d.primary!.model, 'code-coder');
    assert.equal(d.primary!.capabilities.streaming, true);
    assert.match(d.reason, /capability requirement streaming \(§26\.1\): 2 of 5/);
  });

  it('needsResume + needsCancellation are honored together', () => {
    const d = route({ ...baseRequest(), taskType: 'coding', needsResume: true, needsCancellation: true });
    assert.equal(d.primary!.capabilities.resume, true);
    assert.equal(d.primary!.capabilities.cancellation, true);
    assert.match(d.reason, /resume\/session/);
  });

  it('an undeclared §26.1 field counts as NOT capable (conservative)', () => {
    const bare: ModelRef = {
      provider: 'shared',
      model: 'bare-model',
      capabilities: { reasoning: true, vision: false, tools: true, maxContext: 'large' },
      costTier: 'low',
      latencyTier: 'low',
      availability: 'online',
    };
    assert.deepEqual(capabilityGaps(bare, { ...baseRequest(), needsStructuredOutput: true }), [
      'structured output',
    ]);
    const d = route({ ...baseRequest(), needsStructuredOutput: true }, [bare]);
    assert.equal(d.unavailable, true);
    assert.match(d.reason, /structured output/);
  });

  it('requests without needs* flags route exactly as before (old shapes unchanged)', () => {
    const d = route(baseRequest());
    assert.equal(d.primary!.model, 'fast-classifier');
    assert.equal(d.fallback!.model, 'local-private');
    assert.equal(d.emergency!.model, 'local-private');
    assert.doesNotMatch(d.reason, /capability requirement/);
  });
});

describe('§26.1 data-class clearance', () => {
  const sharedClearedForSensitive: ModelRef = {
    provider: 'shared',
    model: 'cleared-cloud',
    capabilities: {
      reasoning: true,
      vision: false,
      tools: true,
      maxContext: 'large',
      dataClasses: ['public', 'internal', 'sensitive'],
    },
    costTier: 'low',
    latencyTier: 'low',
    availability: 'online',
  };

  it('a declared dataClasses list governs, even across the provider boundary', () => {
    assert.equal(clearedForDataClass(sharedClearedForSensitive, 'sensitive'), true);
    const d = route(
      { ...baseRequest(), privacy: 'sensitive', taskType: 'coding', complexity: 5 },
      [sharedClearedForSensitive],
    );
    assert.equal(d.unavailable, false);
    assert.equal(d.primary!.model, 'cleared-cloud');
  });

  it('a declared list that omits the class excludes the model', () => {
    const publicOnly: ModelRef = {
      ...sharedClearedForSensitive,
      model: 'public-only',
      capabilities: { ...sharedClearedForSensitive.capabilities, dataClasses: ['public'] },
    };
    assert.equal(clearedForDataClass(publicOnly, 'internal'), false);
    const d = route({ ...baseRequest(), privacy: 'internal' }, [publicOnly]);
    assert.equal(d.unavailable, true);
  });

  it('undeclared dataClasses fall back to the legacy provider rule', () => {
    const legacyShared: ModelRef = {
      provider: 'shared',
      model: 'legacy-shared',
      capabilities: { reasoning: false, vision: false, tools: true, maxContext: 'small' },
      costTier: 'low',
      latencyTier: 'low',
    };
    const legacyLocal: ModelRef = { ...legacyShared, provider: 'local', model: 'legacy-local' };
    assert.equal(clearedForDataClass(legacyShared, 'sensitive'), false);
    assert.equal(clearedForDataClass(legacyShared, 'internal'), true);
    assert.equal(clearedForDataClass(legacyLocal, 'sensitive'), true);
  });
});

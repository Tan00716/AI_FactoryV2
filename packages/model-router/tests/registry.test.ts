/** §90 Model Registry view tests. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CATALOG, registryRows, toRegistryRow } from '../src/index.js';

describe('registryRows', () => {
  it('exposes all §90 columns for every catalog model', () => {
    const rows = registryRows();
    assert.equal(rows.length, MODEL_CATALOG.length);
    for (const r of rows) {
      assert.ok(typeof r.provider === 'string' && r.provider.length > 0);
      assert.ok(typeof r.model === 'string' && r.model.length > 0);
      assert.ok(Array.isArray(r.capability));
      assert.ok(['small', 'medium', 'large'].includes(r.context));
      assert.equal(typeof r.reasoning, 'boolean');
      assert.ok(['low', 'high'].includes(r.cost));
      assert.ok(['low', 'high'].includes(r.latency));
      assert.ok(['online', 'degraded', 'offline', 'unknown'].includes(r.availability));
      assert.ok(r.fallback === null || typeof r.fallback === 'string');
    }
  });

  it('derives capability tags from capability flags', () => {
    const row = toRegistryRow(MODEL_CATALOG[1]); // code-coder
    assert.deepEqual(row.capability, ['reasoning', 'tools']);
    assert.equal(row.reasoning, true);
    assert.equal(row.context, 'large');
    const vision = toRegistryRow(MODEL_CATALOG[3]); // vision-capable
    assert.deepEqual(vision.capability, ['reasoning', 'vision', 'tools']);
  });

  it('keeps routing-relevant metadata intact (router uses it, not names)', () => {
    for (const r of registryRows()) {
      const src = MODEL_CATALOG.find((m) => m.model === r.model);
      assert.ok(src, `catalog entry for ${r.model}`);
      assert.equal(r.cost, src.costTier);
      assert.equal(r.latency, src.latencyTier);
    }
  });

  it('defaults missing availability/fallback honestly', () => {
    const row = toRegistryRow({
      provider: 'x',
      model: 'y',
      capabilities: { reasoning: false, vision: false, tools: false, maxContext: 'small' },
      costTier: 'low',
      latencyTier: 'low',
    });
    assert.equal(row.availability, 'unknown');
    assert.equal(row.fallback, null);
    assert.deepEqual(row.capability, []);
  });
});

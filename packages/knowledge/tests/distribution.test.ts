/** @ai-factory/knowledge — distribution license gate (spec §44). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDistributable,
  canDistribute,
  DistributionError,
  EXTERNAL_SCRIPT_TAG,
  isExternalScript,
  type KnowledgeItem,
  type KnowledgeScope,
} from '../src/index';

function item(over: Partial<KnowledgeItem> = {}): KnowledgeItem {
  const scope: KnowledgeScope = { level: 'GLOBAL' };
  return {
    id: 'know_test',
    title: 'T',
    content: 'C',
    tags: [],
    scope,
    source: { type: 'official_docs', name: 'docs', retrievedAt: 0 },
    state: 'ACTIVE',
    createdAt: 0,
    updatedAt: 0,
    version: 1,
    ...over,
  };
}

test('isExternalScript detects the external_script tag (case-insensitive)', () => {
  assert.equal(isExternalScript(item({ tags: [EXTERNAL_SCRIPT_TAG] })), true);
  assert.equal(isExternalScript(item({ tags: ['External_Script'] })), true);
  assert.equal(isExternalScript(item({ tags: ['notes'] })), false);
});

test('external script WITHOUT a license is refused from distribution', () => {
  const i = item({
    tags: ['external_script'],
    source: { type: 'primary_article', name: 'blog', retrievedAt: 0 },
  });
  assert.throws(() => assertDistributable(i), (err: unknown) => {
    assert.ok(err instanceof DistributionError);
    assert.equal(err.code, 'MISSING_LICENSE');
    assert.equal(err.itemId, i.id);
    return true;
  });
  assert.equal(canDistribute(i), false);
});

test('external script WITH a license may be distributed', () => {
  const i = item({
    tags: ['external_script'],
    source: {
      type: 'primary_article',
      name: 'blog',
      url: 'https://example.com/s',
      publisher: 'example',
      retrievedAt: 1,
      publishedAt: 2,
      applicableVersion: '>=1.0',
      contentHash: 'abc123',
      citationScope: 'full',
      license: 'MIT',
    },
  });
  assert.doesNotThrow(() => assertDistributable(i));
  assert.equal(canDistribute(i), true);
});

test('non-script items are not license-gated', () => {
  const i = item({ tags: ['notes'] });
  assert.equal(canDistribute(i), true);
  assert.doesNotThrow(() => assertDistributable(i));
});

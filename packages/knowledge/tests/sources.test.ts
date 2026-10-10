import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareSources,
  outranks,
  rankSource,
  sourceRank,
  verificationThreshold,
  SOURCE_CREDIBILITY,
  SOURCE_PRIORITY,
  SOURCE_SCORES,
} from '../src/index';

describe('sources — priority order [§44]', () => {
  it('lists all six source types in priority order', () => {
    assert.deepEqual([...SOURCE_PRIORITY], [
      'official_spec',
      'official_docs',
      'official_release',
      'primary_article',
      'research',
      'community',
    ]);
  });

  it('official_spec outranks official_docs outranks ... community', () => {
    assert.ok(outranks('official_spec', 'official_docs'));
    assert.ok(outranks('official_docs', 'official_release'));
    assert.ok(outranks('official_release', 'primary_article'));
    assert.ok(outranks('primary_article', 'research'));
    assert.ok(outranks('research', 'community'));
    assert.ok(!outranks('community', 'official_spec'));
    assert.equal(compareSources('research', 'research'), 0);
  });

  it('rankSource scores the §44 priority order: official first, community last', () => {
    assert.equal(rankSource('official_spec'), 100);
    assert.equal(rankSource('official_docs'), 90);
    assert.equal(rankSource('official_release'), 80);
    assert.equal(rankSource('primary_article'), 60);
    assert.equal(rankSource('research'), 50);
    assert.equal(rankSource('community'), 20);
    const scores = SOURCE_PRIORITY.map(rankSource);
    for (let i = 1; i < scores.length; i++) assert.ok(scores[i] < scores[i - 1]);
    assert.deepEqual(SOURCE_SCORES, {
      official_spec: 100,
      official_docs: 90,
      official_release: 80,
      primary_article: 60,
      research: 50,
      community: 20,
    });
  });

  it('sourceRank increases as priority decreases', () => {
    const ranks = SOURCE_PRIORITY.map(sourceRank);
    assert.deepEqual(ranks, [0, 1, 2, 3, 4, 5]);
  });

  it('credibility decreases along the priority order', () => {
    const creds = SOURCE_PRIORITY.map((t) => SOURCE_CREDIBILITY[t]);
    for (let i = 1; i < creds.length; i++) assert.ok(creds[i] < creds[i - 1]);
  });

  it('lower-credibility sources face a higher verification threshold', () => {
    const spec = verificationThreshold('official_spec');
    const docs = verificationThreshold('official_docs');
    assert.equal(spec, 1);
    assert.equal(docs, 1);
    assert.ok(verificationThreshold('research') > verificationThreshold('official_release'));
  });

  it('community sources need DOUBLED verification (§44: 社区资料需更强验证)', () => {
    // Base community threshold would be 4; the §44 doubling makes it 8.
    assert.equal(verificationThreshold('community'), 8);
    assert.ok(verificationThreshold('community') > verificationThreshold('research'));
  });
});

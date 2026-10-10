import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareSources,
  outranks,
  sourceRank,
  verificationThreshold,
  SOURCE_CREDIBILITY,
  SOURCE_PRIORITY,
} from '../src/index';

describe('sources — priority order [§51]', () => {
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
    const community = verificationThreshold('community');
    assert.equal(spec, 1);
    assert.equal(docs, 1);
    assert.equal(community, 4);
    assert.ok(community > spec);
    assert.ok(verificationThreshold('research') > verificationThreshold('official_release'));
  });
});

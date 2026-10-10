/** @ai-factory/knowledge — update feed cards (spec §89). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleFeedCards, FEED_CATEGORIES } from '../src/feed';

test('sample feed returns 5 cards with required fields', () => {
  const cards = sampleFeedCards();
  assert.equal(cards.length, 5);
  for (const c of cards) {
    assert.ok(c.id);
    assert.ok(FEED_CATEGORIES.includes(c.category));
    assert.ok(['NEW', 'UPDATED', 'VERIFIED', 'DEPRECATED'].includes(c.kind));
    assert.ok(c.title);
    assert.ok(c.whyRelevant);
    assert.ok(Array.isArray(c.evidence) && c.evidence.length > 0);
    assert.ok(Array.isArray(c.affectedAgents) && c.affectedAgents.length > 0);
    assert.ok(c.risk);
    assert.ok(c.recommendedAction);
    assert.ok(c.publishedAt);
  }
});

test('cards are unique and categories match the spec list', () => {
  const cards = sampleFeedCards();
  const ids = new Set(cards.map((c) => c.id));
  assert.equal(ids.size, cards.length);
  assert.deepEqual(FEED_CATEGORIES, [
    'Models', 'Agents', 'Skills', 'MCP', 'Harness Engineering', 'Loop Engineering',
    'Coding', 'Testing', 'Security', 'DevOps', 'Research',
  ]);
});

test('debug skill card carries the skill-version recommendation', () => {
  const cards = sampleFeedCards();
  const debug = cards.find((c) => c.id === 'feed-debug-skill');
  assert.ok(debug);
  assert.match(debug.recommendedAction, /v1\.2 → v1\.3/);
});

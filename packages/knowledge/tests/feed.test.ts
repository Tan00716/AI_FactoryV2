/** @ai-factory/knowledge — update feed cards (spec §44). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleFeedCards,
  recordFeedDecision,
  markSourceUnavailable,
  refreshSource,
  FEED_CATEGORIES,
  type FeedCard,
} from '../src/feed';

function card(over: Partial<FeedCard> = {}): FeedCard {
  return {
    id: 'feed-test',
    category: 'Skills',
    kind: 'NEW',
    title: 'Test change',
    changeContent: 'Something changed in the spec.',
    whyRelevant: 'We implement that spec.',
    officialSource: 'Official changelog 2026-10',
    evidence: ['changelog link'],
    affectedEmployees: ['Backend Engineer'],
    affectedProjects: ['ai-factory'],
    risk: 'LOW',
    recommendedAction: 'Read the changelog.',
    evaluation: 'Evaluated OK.',
    sourceAvailable: true,
    lastVerifiedAt: 1_000_000,
    publishedAt: '2026-10-01T00:00:00Z',
    ...over,
  };
}

test('sample feed cards carry every §44 required field', () => {
  const cards = sampleFeedCards();
  assert.ok(cards.length >= 3);
  for (const c of cards) {
    assert.ok(c.id);
    assert.ok(FEED_CATEGORIES.includes(c.category));
    assert.ok(['NEW', 'UPDATED', 'VERIFIED', 'DEPRECATED'].includes(c.kind));
    assert.ok(c.title);
    assert.ok(c.changeContent, '变更内容');
    assert.ok(c.whyRelevant, '为何相关');
    assert.ok(c.officialSource, '官方来源');
    assert.ok(Array.isArray(c.evidence) && c.evidence.length > 0);
    assert.ok(Array.isArray(c.affectedEmployees) && c.affectedEmployees.length > 0, '影响员工');
    assert.ok(Array.isArray(c.affectedProjects) && c.affectedProjects.length > 0, '影响项目');
    assert.ok(c.risk, '风险');
    assert.ok(c.recommendedAction, '建议');
    assert.ok(typeof c.sourceAvailable === 'boolean');
    assert.ok(Number.isFinite(c.lastVerifiedAt), '已核对日期');
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

test('recordFeedDecision supports Activate/Defer/Reject without mutating the card', () => {
  const c = card();
  const decided = recordFeedDecision(c, 'Activate', { by: 'human:cto', now: () => 5_000 });
  assert.equal(decided.action, 'Activate');
  assert.equal(decided.actionBy, 'human:cto');
  assert.equal(decided.actionAt, 5_000);
  // pure: the original is untouched
  assert.equal(c.action, undefined);

  const deferred = recordFeedDecision(c, 'Defer', { by: 'agent-1' });
  assert.equal(deferred.action, 'Defer');
  const rejected = recordFeedDecision(c, 'Reject', { by: 'human:cto' });
  assert.equal(rejected.action, 'Reject');
});

test('source unavailable is marked but the verified date is kept', () => {
  const c = card({ sourceAvailable: true, lastVerifiedAt: 1_000_000 });
  const marked = markSourceUnavailable(c);
  assert.equal(marked.sourceAvailable, false);
  assert.equal(marked.lastVerifiedAt, 1_000_000, '已核对日期 retained');
  assert.equal(c.sourceAvailable, true, 'original not mutated');

  const sample = sampleFeedCards().find((x) => x.id === 'feed-agent-pattern')!;
  assert.equal(sample.sourceAvailable, false);
  assert.ok(Number.isFinite(sample.lastVerifiedAt), 'sample keeps its verified date');
});

test('refreshSource restores availability and updates the verified date', () => {
  const c = card({ sourceAvailable: false, lastVerifiedAt: 1_000_000 });
  const refreshed = refreshSource(c, { now: () => 2_000_000 });
  assert.equal(refreshed.sourceAvailable, true);
  assert.equal(refreshed.lastVerifiedAt, 2_000_000);
});

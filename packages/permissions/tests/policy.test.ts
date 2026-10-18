/**
 * @ai-factory/permissions unit tests (node:test, W-C).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateTierPolicy,
  matchesPattern,
  validateTierPolicy,
  defaultTierPolicy,
  DEFAULT_TIER_POLICIES,
} from '../src/index.js';

describe('matchesPattern', () => {
  it('exact, prefix.*, and *', () => {
    assert.equal(matchesPattern('git.push', 'git.push'), true);
    assert.equal(matchesPattern('git.push', 'git.pull'), false);
    assert.equal(matchesPattern('filesystem.*', 'filesystem.write'), true);
    assert.equal(matchesPattern('filesystem.*', 'filesystem'), true);
    assert.equal(matchesPattern('filesystem.*', 'git.push'), false);
    assert.equal(matchesPattern('*', 'anything.at.all'), true);
    assert.equal(matchesPattern('*.read', 'secret.read'), true);
    assert.equal(matchesPattern('*.read', 'secret.write'), false);
  });
});

describe('evaluateTierPolicy precedence', () => {
  it('deny > ask > auto', () => {
    const p = { tier: 'exec' as const, auto: ['*'], ask: ['git.push'], deny: ['git.push'] };
    assert.equal(evaluateTierPolicy(p, 'git.push').verdict, 'deny');
    const p2 = { tier: 'exec' as const, auto: ['*'], ask: ['git.push'], deny: [] };
    assert.equal(evaluateTierPolicy(p2, 'git.push').verdict, 'ask');
    assert.equal(evaluateTierPolicy(p2, 'git.status').verdict, 'auto');
  });
  it('no match defaults to ask (fail-closed)', () => {
    const p = { tier: 'read' as const, auto: [], ask: [], deny: [] };
    assert.equal(evaluateTierPolicy(p, 'something.new').verdict, 'ask');
  });
});

describe('default tier policies', () => {
  it('read tier: reads auto, writes ask (human may still approve)', () => {
    const p = defaultTierPolicy('read');
    assert.equal(evaluateTierPolicy(p, 'knowledge.search').verdict, 'auto');
    assert.equal(evaluateTierPolicy(p, 'filesystem.write').verdict, 'ask');
  });
  it('exec tier: exec auto, secrets denied, unknown asks', () => {
    const p = defaultTierPolicy('exec');
    assert.equal(evaluateTierPolicy(p, 'exec.run').verdict, 'auto');
    assert.equal(evaluateTierPolicy(p, 'secret.read').verdict, 'deny');
    assert.equal(evaluateTierPolicy(p, 'deploy.prod').verdict, 'deny');
    assert.equal(evaluateTierPolicy(p, 'brand.new.action').verdict, 'ask');
  });
  it('admin tier: auto everything (approvals-BLOCKED still composed out server-side)', () => {
    const p = defaultTierPolicy('admin');
    assert.equal(evaluateTierPolicy(p, 'deploy.prod').verdict, 'auto');
  });
  it('defaults are deep copies', () => {
    const p = defaultTierPolicy('read');
    p.auto.push('zzz');
    assert.ok(!DEFAULT_TIER_POLICIES.read.auto.includes('zzz'));
  });
});

describe('validateTierPolicy', () => {
  it('accepts partial input', () => {
    const r = validateTierPolicy({ ask: ['git.push'] });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.policy.ask, ['git.push']);
  });
  it('rejects non-string entries', () => {
    const r = validateTierPolicy({ auto: ['ok', 42] });
    assert.equal(r.ok, false);
  });
  it('rejects non-objects', () => {
    assert.equal(validateTierPolicy(null).ok, false);
    assert.equal(validateTierPolicy('x').ok, false);
  });
});

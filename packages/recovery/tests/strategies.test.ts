import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectStrategy, escalationChain, ALL_FAILURE_TYPES } from '../src/index';

describe('selectStrategy', () => {
  it('TEST_ERROR: retry ×2, then create-specialist', () => {
    assert.equal(selectStrategy('TEST_ERROR', 0).strategy, 'retry');
    assert.equal(selectStrategy('TEST_ERROR', 1).strategy, 'retry');
    assert.equal(selectStrategy('TEST_ERROR', 2).strategy, 'create-specialist');
    assert.equal(selectStrategy('TEST_ERROR', 3).strategy, 'ask-human');
  });

  it('PERMISSION_ERROR: ask-human immediately', () => {
    const r = selectStrategy('PERMISSION_ERROR', 0);
    assert.equal(r.strategy, 'ask-human');
    assert.equal(r.escalateAfter, 0);
  });

  it('LOOP_STAGNATION: change-agent immediately, then ask-human', () => {
    assert.equal(selectStrategy('LOOP_STAGNATION', 0).strategy, 'change-agent');
    assert.equal(selectStrategy('LOOP_STAGNATION', 1).strategy, 'ask-human');
  });

  it('RESOURCE_LIMIT: retry once, then abort with an upgrade hint', () => {
    const first = selectStrategy('RESOURCE_LIMIT', 0);
    assert.equal(first.strategy, 'retry');
    const second = selectStrategy('RESOURCE_LIMIT', 1);
    assert.equal(second.strategy, 'abort');
    assert.ok(second.upgradeHint && /ceiling|quota/i.test(second.upgradeHint));
    assert.equal(second.escalateAfter, 1);
  });

  it('MODEL_ERROR escalates to change-model before asking a human', () => {
    const chain = escalationChain('MODEL_ERROR');
    assert.deepEqual(chain, ['retry', 'retry', 'change-model', 'ask-human']);
    assert.equal(selectStrategy('MODEL_ERROR', 2).strategy, 'change-model');
  });

  it('NETWORK_ERROR retries more before restarting the environment', () => {
    assert.deepEqual(escalationChain('NETWORK_ERROR'), [
      'retry',
      'retry',
      'retry',
      'env-restart',
      'ask-human',
    ]);
  });

  it('backoff grows exponentially with the attempt number and is capped', () => {
    assert.equal(selectStrategy('TEST_ERROR', 0).backoffMs, 0);
    assert.equal(selectStrategy('TEST_ERROR', 1).backoffMs, 1000);
    assert.equal(selectStrategy('TEST_ERROR', 2).backoffMs, 2000);
    assert.equal(selectStrategy('TEST_ERROR', 3).backoffMs, 4000);
    assert.ok(selectStrategy('TEST_ERROR', 99).backoffMs <= 30_000);
  });

  it('every failure type has a chain ending in ask-human or abort', () => {
    for (const t of ALL_FAILURE_TYPES) {
      const chain = escalationChain(t);
      const last = chain[chain.length - 1];
      assert.ok(
        last === 'ask-human' || last === 'abort',
        `${t} chain must end in escalation`,
      );
    }
  });

  it('reason mentions the strategy and the failure type', () => {
    const r = selectStrategy('CODE_ERROR', 2);
    assert.equal(r.strategy, 'change-agent');
    assert.ok(r.reason.includes('change-agent'));
    assert.ok(r.reason.includes('CODE_ERROR'));
  });
});

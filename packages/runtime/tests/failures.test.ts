import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoPermissionBypass,
  classifyFailure,
  isAutoRetryAllowed,
  PermissionBypassAttempt,
  BudgetExceeded,
  PermissionDenied,
  StepTimeout,
} from '../src/index';

describe('failure classification (§25)', () => {
  it('classifies permission denial', () => {
    assert.equal(classifyFailure(new PermissionDenied('shell', 'nope')), 'PERMISSION_DENIED');
  });

  it('classifies quota exhaustion', () => {
    assert.equal(classifyFailure(new BudgetExceeded('too much')), 'QUOTA_EXHAUSTED');
    assert.equal(classifyFailure(new Error('429 rate limited')), 'QUOTA_EXHAUSTED');
  });

  it('classifies transient network', () => {
    assert.equal(classifyFailure(new StepTimeout('tool:x', 100)), 'TRANSIENT_NETWORK');
    assert.equal(classifyFailure(new Error('ECONNRESET by peer')), 'TRANSIENT_NETWORK');
  });

  it('classifies auth failures', () => {
    assert.equal(classifyFailure(new Error('401 UNAUTHORIZED credential expired')), 'AUTH_FAILURE');
  });

  it('unknown errors stay UNKNOWN', () => {
    assert.equal(classifyFailure(new Error('weird')), 'UNKNOWN');
  });

  it('permission denial must not be bypassed by switching tools/models', () => {
    assert.throws(
      () => assertNoPermissionBypass('PERMISSION_DENIED', 'other-tool'),
      PermissionBypassAttempt,
    );
    assert.throws(
      () => assertNoPermissionBypass('PERMISSION_DENIED', 'other-model'),
      PermissionBypassAttempt,
    );
    // Other classes are fine to handle normally.
    assert.doesNotThrow(() => assertNoPermissionBypass('TRANSIENT_NETWORK', 'retry'));
  });

  it('deterministic failures are not auto-retried', () => {
    assert.equal(isAutoRetryAllowed('TEST_FAILURE'), false);
    assert.equal(isAutoRetryAllowed('PERMISSION_DENIED'), false);
    assert.equal(isAutoRetryAllowed('PRODUCT_FAILURE'), false);
    assert.equal(isAutoRetryAllowed('TRANSIENT_NETWORK'), true);
    assert.equal(isAutoRetryAllowed('INFRA_FAILURE'), true);
  });
});

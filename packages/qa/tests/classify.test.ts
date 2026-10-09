/**
 * Tests for the Failure Analyzer heuristics (spec §38).
 * Run: node --test dist/tests/classify.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../src/index';

describe('classifyFailure', () => {
  it('classifies an assertion diff as PRODUCT_FAILURE', () => {
    const c = classifyFailure({
      message: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n3 !== 5',
    });
    assert.equal(c, 'PRODUCT_FAILURE');
  });

  it('classifies expect() matcher failures as PRODUCT_FAILURE', () => {
    assert.equal(
      classifyFailure({ message: 'expect(received).toBe(expected)\nExpected: 5\nReceived: 6' }),
      'PRODUCT_FAILURE',
    );
  });

  it('classifies harness problems as TEST_FAILURE (beforeEach)', () => {
    assert.equal(
      classifyFailure({
        message: 'AssertionError in test runner beforeEach hook: setup failed',
      }),
      'TEST_FAILURE',
    );
  });

  it('classifies a broken setup hook as TEST_FAILURE', () => {
    assert.equal(
      classifyFailure({
        message: 'beforeEach hook failed: AssertionError: expected db connection to be defined in test setup',
      }),
      'TEST_FAILURE',
    );
  });

  it('classifies connection refused as ENVIRONMENT_FAILURE', () => {
    assert.equal(
      classifyFailure({ message: 'FetchError: request to http://api:3000 failed, reason: connect ECONNREFUSED 127.0.0.1:3000' }),
      'ENVIRONMENT_FAILURE',
    );
  });

  it('classifies DNS failures as ENVIRONMENT_FAILURE', () => {
    assert.equal(
      classifyFailure({ message: 'getaddrinfo ENOTFOUND db.internal', exitCode: 1 }),
      'ENVIRONMENT_FAILURE',
    );
  });

  it('classifies timeouts as ENVIRONMENT_FAILURE', () => {
    assert.equal(
      classifyFailure({ message: 'test timed out after 5000ms waiting for response' }),
      'ENVIRONMENT_FAILURE',
    );
  });

  it('classifies OOM as INFRA_FAILURE', () => {
    assert.equal(
      classifyFailure({ message: '', stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' }),
      'INFRA_FAILURE',
    );
  });

  it('classifies missing binaries / permissions as INFRA_FAILURE', () => {
    assert.equal(classifyFailure({ message: 'spawn ENOENT: chromium not found' }), 'INFRA_FAILURE');
    assert.equal(classifyFailure({ message: 'EACCES: permission denied, open /var/log/out' }), 'INFRA_FAILURE');
  });

  it('classifies agent tool errors as AI_FAILURE', () => {
    assert.equal(
      classifyFailure({ message: 'tool call timeout after 60000ms: shell_exec' }),
      'AI_FAILURE',
    );
    assert.equal(
      classifyFailure({ message: 'tool error: filesystem.write rejected by policy' }),
      'AI_FAILURE',
    );
  });

  it('returns UNKNOWN when nothing matches', () => {
    assert.equal(classifyFailure({ message: 'something weird happened' }), 'UNKNOWN');
    assert.equal(classifyFailure({ message: '' }), 'UNKNOWN');
  });
});

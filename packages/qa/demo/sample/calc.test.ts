/**
 * Demo sample tests — these FAIL against the buggy calc.ts above.
 * Run standalone:  node --test --test-reporter=tap calc.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mul, sum } from './calc.ts';

describe('calc', () => {
  it('sums two numbers', () => {
    assert.equal(sum(2, 3), 5);
  });

  it('multiplies two numbers', () => {
    assert.equal(mul(2, 3), 6);
  });
});

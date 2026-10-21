/**
 * Fixture tests for the calc mutation target.
 * NOTE: isPositive is intentionally only tested with positive inputs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, alwaysEnabled, both, clamp, isEqual, isPositive, label, sub } from './calc.ts';

test('add', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});

test('sub', () => {
  assert.equal(sub(5, 3), 2);
});

test('isPositive (weak: positive inputs only)', () => {
  assert.equal(isPositive(3), true);
  assert.equal(isPositive(100), true);
});

test('clamp', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(10, 0, 10), 10);
});

test('both', () => {
  assert.equal(both(true, true), true);
  assert.equal(both(true, false), false);
  assert.equal(both(false, true), false);
});

test('label', () => {
  assert.equal(label(true), 'yes');
  assert.equal(label(false), 'no');
});

test('alwaysEnabled', () => {
  assert.equal(alwaysEnabled(), true);
});

test('isEqual', () => {
  assert.equal(isEqual(1, 1), true);
  assert.equal(isEqual(1, 2), false);
});

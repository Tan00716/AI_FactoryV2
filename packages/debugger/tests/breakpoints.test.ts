import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBreakpoint,
  summarizeBreakpoints,
  validateBreakpoint,
  validateConditionSyntax,
} from '../src/index';

test('classification: logpoint wins over condition', () => {
  assert.equal(classifyBreakpoint({}), 'plain');
  assert.equal(classifyBreakpoint({ condition: 'x > 1' }), 'conditional');
  assert.equal(classifyBreakpoint({ logMessage: 'hit {x}' }), 'logpoint');
  assert.equal(classifyBreakpoint({ condition: 'x > 1', logMessage: 'hit' }), 'logpoint');
});

test('condition syntax is parse-checked, never executed', () => {
  assert.equal(validateConditionSyntax('x > 1'), null);
  assert.equal(validateConditionSyntax('a && (b || c)'), null);
  // Would throw ReferenceError if executed; parse-only must accept it.
  assert.equal(validateConditionSyntax('nonexistentVar === 1'), null);
  assert.notEqual(validateConditionSyntax('x >'), null);
  assert.notEqual(validateConditionSyntax(''), null);
  assert.notEqual(validateConditionSyntax('x\0> 1'), null);
});

test('validateBreakpoint catches file/line/column/length problems', () => {
  assert.deepEqual(validateBreakpoint({ file: 'a.js', line: 3 }), []);
  assert.ok(validateBreakpoint({ file: '', line: 3 }).length > 0);
  assert.ok(validateBreakpoint({ file: 'a.js', line: 0 }).length > 0);
  assert.ok(validateBreakpoint({ file: 'a.js', line: 1.5 }).length === 0, 'fractional line floors in the route; validator accepts finite >= 1');
  assert.ok(validateBreakpoint({ file: 'a.js', line: 3, column: 0 }).length > 0);
  assert.ok(validateBreakpoint({ file: 'a.js', line: 3, condition: 'x'.repeat(2001) }).length > 0);
  assert.ok(validateBreakpoint({ file: 'a.js', line: 3, condition: 'x >' }).length > 0);
  assert.ok(validateBreakpoint({ file: 'a.js', line: 3, logMessage: 'ok {x}' }).length === 0);
});

test('summarizeBreakpoints counts kinds', () => {
  assert.deepEqual(
    summarizeBreakpoints([
      {},
      { condition: 'x' },
      { logMessage: 'hit' },
      { condition: 'x', logMessage: 'hit' },
    ]),
    { total: 4, plain: 1, conditional: 1, logpoint: 2 },
  );
});

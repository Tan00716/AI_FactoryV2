import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addRule, emptyStore, parseStore, patchRule, reorderRules } from '../src/store.js';
import type { ManagedRule } from '../src/types.js';

let seq = 0;
const makeId = () => `r${++seq}`;
const now = () => 1000;

function mk(name: string, order: number, scope: 'global' | 'project' = 'global'): ManagedRule {
  return { id: makeId(), name, scope, content: 'x', enabled: true, order, createdAt: 1, updatedAt: 1 };
}

test('addRule: appends with next order, rejects duplicate name case-insensitively', () => {
  const { rule, issues } = addRule([mk('Foo', 0)], { name: 'Bar', content: 'c', scope: 'global' }, makeId, now);
  assert.deepEqual(issues, []);
  assert.equal(rule?.order, 1);
  assert.equal(rule?.scope, 'global');
  const dup = addRule([mk('Foo', 0)], { name: 'foo', content: 'c', scope: 'global' }, makeId, now);
  assert.equal(dup.rule, null);
  assert.match(dup.issues.join(' '), /already exists/);
});

test('addRule: rejects bad names and oversize content', () => {
  const bad = addRule([], { name: '../escape', content: 'c', scope: 'global' }, makeId, now);
  assert.equal(bad.rule, null);
  assert.ok(bad.issues.length > 0);
  const big = addRule([], { name: 'ok', content: 'x'.repeat(70 * 1024), scope: 'global' }, makeId, now);
  assert.equal(big.rule, null);
});

test('patchRule: rename conflict rejected, enable toggle works', () => {
  const a = mk('a', 0);
  const b = mk('b', 1);
  const conflict = patchRule([a, b], b.id, { name: 'A' }, now);
  assert.equal(conflict.rule, null);
  const ok = patchRule([a, b], b.id, { enabled: false, content: 'new' }, now);
  assert.equal(ok.rule?.enabled, false);
  assert.equal(ok.rule?.content, 'new');
  assert.equal(patchRule([a, b], 'nope', { enabled: false }, now).rule, null);
});

test('reorderRules: exact permutation only', () => {
  const rules = [mk('a', 0), mk('b', 1), mk('c', 2)];
  const ok = reorderRules(rules, [rules[2].id, rules[0].id, rules[1].id], now);
  assert.deepEqual(ok.rules?.map((r) => r.name), ['c', 'a', 'b']);
  assert.deepEqual(ok.rules?.map((r) => r.order), [0, 1, 2]);
  assert.equal(reorderRules(rules, [rules[0].id, rules[0].id], now).rules, null);
  assert.equal(reorderRules(rules, [rules[0].id, 'ghost', rules[2].id], now).rules, null);
});

test('parseStore: corrupt and wrong-version fall back to empty', () => {
  assert.deepEqual(parseStore('not json'), emptyStore());
  assert.deepEqual(parseStore(JSON.stringify({ version: 2, rules: [] })), emptyStore());
  const good = parseStore(JSON.stringify({ version: 1, rules: [mk('z', 5), mk('a', 1)] }));
  assert.deepEqual(good.rules.map((r) => r.name), ['a', 'z']);
});

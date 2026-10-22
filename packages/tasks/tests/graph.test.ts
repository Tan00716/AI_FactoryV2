import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenPlan, planRun, quoteArg, shellCommandLine } from '../src/index.js';
import type { TaskDef } from '../src/index.js';

function def(label: string, dependsOn: string[] = [], dependsOrder: 'sequence' | 'parallel' = 'sequence'): TaskDef {
  return {
    label, type: 'shell', command: 'echo', args: [label], group: 'none',
    dependsOn, dependsOrder, problemMatcher: [], options: {},
  };
}

test('linear chain plans in dependency order', () => {
  const tasks = [def('c', ['b']), def('a'), def('b', ['a'])];
  const r = planRun(tasks, ['c']);
  assert.deepEqual(r.errors, []);
  assert.equal(r.plan.length, 1);
  assert.deepEqual(flattenPlan(r.plan).map((t) => t.label), ['a', 'b', 'c']);
});

test('diamond shares the common dependency once', () => {
  const tasks = [def('d', ['b', 'c']), def('b', ['a']), def('c', ['a']), def('a')];
  const r = planRun(tasks, ['d']);
  assert.deepEqual(r.errors, []);
  const flat = flattenPlan(r.plan).map((t) => t.label);
  assert.deepEqual(flat, ['a', 'b', 'c', 'd']);
});

test('multiple requested labels each get a plan', () => {
  const tasks = [def('b', ['a']), def('a'), def('c')];
  const r = planRun(tasks, ['b', 'c']);
  assert.deepEqual(r.errors, []);
  assert.equal(r.plan.length, 2);
});

test('cycle is a fatal error with the path', () => {
  const tasks = [def('a', ['b']), def('b', ['c']), def('c', ['a'])];
  const r = planRun(tasks, ['a']);
  assert.ok(r.errors.some((e) => e.includes('cycle')));
  assert.ok(r.errors.some((e) => e.includes('a → b → c → a')));
  assert.deepEqual(r.plan, []);
});

test('self-dependency is a cycle', () => {
  const r = planRun([def('a', ['a'])], ['a']);
  assert.ok(r.errors.some((e) => e.includes('cycle')));
});

test('missing dependency is a fatal error', () => {
  const r = planRun([def('a', ['ghost'])], ['a']);
  assert.ok(r.errors.some((e) => e.includes('ghost')));
});

test('unknown requested label is a fatal error', () => {
  const r = planRun([def('a')], ['nope']);
  assert.ok(r.errors.some((e) => e.includes('nope')));
});

test('parallel flag follows dependsOrder', () => {
  const tasks = [def('all', ['a', 'b'], 'parallel'), def('a'), def('b')];
  const r = planRun(tasks, ['all']);
  assert.deepEqual(r.errors, []);
  assert.equal(r.plan[0].parallel, true);
  assert.equal(r.plan[0].dependsOn.length, 2);
});

test('quoteArg quotes only when needed', () => {
  assert.equal(quoteArg('simple-1_x'), 'simple-1_x');
  assert.equal(quoteArg('with space'), "'with space'");
  assert.equal(quoteArg("o'clock"), "'o'\\''clock'");
  assert.equal(shellCommandLine(def('x')), "echo x");
});

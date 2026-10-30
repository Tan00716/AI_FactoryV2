import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dagLevels, detectCycle, flattenPlan, planRun, quoteArg, shellCommandLine } from '../src/index.js';
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

// R7-#4: save-time cycle detection (pure, no plan needed).

test('detectCycle returns null for acyclic graphs', () => {
  const tasks = [def('d', ['b', 'c']), def('b', ['a']), def('c', ['a']), def('a')];
  assert.equal(detectCycle(tasks), null);
});

test('detectCycle returns null when a dependency is unknown (planRun still rejects it)', () => {
  assert.equal(detectCycle([def('a', ['ghost'])]), null);
});

test('detectCycle reports a self-loop with the repeated label', () => {
  assert.deepEqual(detectCycle([def('a', ['a'])]), ['a', 'a']);
});

test('detectCycle reports the cycle path for a multi-node cycle', () => {
  const tasks = [def('a', ['b']), def('b', ['c']), def('c', ['b']), def('ok')];
  const cycle = detectCycle(tasks);
  assert.ok(cycle !== null);
  assert.equal(cycle[0], cycle[cycle.length - 1]);
  assert.deepEqual([...cycle].sort(), ['b', 'b', 'c'].sort());
});

test('detectCycle ignores tasks outside the cycle', () => {
  const tasks = [def('x'), def('a', ['b']), def('b', ['a'])];
  assert.deepEqual(detectCycle(tasks), ['a', 'b', 'a']);
});

// R7-#4: DAG graph levels + edges for visualization.

test('dagLevels assigns longest-path levels for a diamond', () => {
  const tasks = [def('d', ['b', 'c']), def('b', ['a']), def('c', ['a']), def('a')];
  const r = planRun(tasks, ['d']);
  assert.deepEqual(r.errors, []);
  const g = dagLevels(r.plan);
  const level = new Map(g.nodes.map((n) => [n.label, n.level]));
  assert.equal(level.get('a'), 0);
  assert.equal(level.get('b'), 1);
  assert.equal(level.get('c'), 1);
  assert.equal(level.get('d'), 2);
  assert.deepEqual(
    g.edges.map((e) => `${e.from}->${e.to}`).sort(),
    ['a->b', 'a->c', 'b->d', 'c->d'].sort(),
  );
});

test('dagLevels marks parallel nodes and keeps sequence levels', () => {
  const tasks = [def('all', ['a', 'b'], 'parallel'), def('a'), def('b')];
  const r = planRun(tasks, ['all']);
  assert.deepEqual(r.errors, []);
  const g = dagLevels(r.plan);
  const all = g.nodes.find((n) => n.label === 'all');
  assert.equal(all?.parallel, true);
  assert.equal(all?.level, 1);
  assert.equal(g.edges.length, 2);
});

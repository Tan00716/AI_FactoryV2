import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasksJson } from '../src/index.js';

test('parses a minimal valid tasks.json', () => {
  const r = parseTasksJson(JSON.stringify({
    version: '2.0.0',
    tasks: [{ label: 'build', command: 'npm run build' }],
  }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.tasks.length, 1);
  const t = r.tasks[0];
  assert.equal(t.label, 'build');
  assert.equal(t.type, 'shell');
  assert.deepEqual(t.args, []);
  assert.equal(t.group, 'none');
  assert.deepEqual(t.dependsOn, []);
  assert.equal(t.dependsOrder, 'sequence');
  assert.deepEqual(t.problemMatcher, []);
});

test('invalid JSON is a fatal error', () => {
  const r = parseTasksJson('{nope');
  assert.ok(r.errors.length > 0);
  assert.deepEqual(r.tasks, []);
});

test('missing label / command are fatal', () => {
  const r = parseTasksJson(JSON.stringify({ tasks: [{ command: 'x' }] }));
  assert.ok(r.errors.some((e) => e.includes('label')));
  const r2 = parseTasksJson(JSON.stringify({ tasks: [{ label: 'x' }] }));
  assert.ok(r2.errors.some((e) => e.includes('command')));
});

test('duplicate labels are fatal', () => {
  const r = parseTasksJson(JSON.stringify({
    tasks: [
      { label: 'a', command: 'echo a' },
      { label: 'a', command: 'echo b' },
    ],
  }));
  assert.ok(r.errors.some((e) => e.includes('duplicate')));
  assert.deepEqual(r.tasks, []);
});

test('dependsOn string is normalized to array; problemMatcher too', () => {
  const r = parseTasksJson(JSON.stringify({
    tasks: [{ label: 'a', command: 'x', dependsOn: 'b', problemMatcher: '$tsc' }],
  }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.tasks[0].dependsOn, ['b']);
  assert.deepEqual(r.tasks[0].problemMatcher, ['$tsc']);
});

test('bad type / dependsOrder / group are fatal', () => {
  const bad = { label: 'a', command: 'x', type: 'nope' };
  assert.ok(parseTasksJson(JSON.stringify({ tasks: [bad] })).errors.length > 0);
  const bad2 = { label: 'a', command: 'x', dependsOrder: 'nope' };
  assert.ok(parseTasksJson(JSON.stringify({ tasks: [bad2] })).errors.length > 0);
});

test('options.env rejects bad names, denylist, non-strings', () => {
  const t = (env: unknown) =>
    parseTasksJson(JSON.stringify({ tasks: [{ label: 'a', command: 'x', options: { env } }] }));
  assert.ok(t({ 'not valid': '1' }).errors.length > 0);
  assert.ok(t({ PATH: '/x' }).errors.length > 0);
  assert.ok(t({ LD_PRELOAD: 'x' }).errors.length > 0);
  assert.ok(t({ FOO: 42 }).errors.length > 0);
  const ok = t({ MY_VAR: 'hello', FOO2: '' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.tasks[0].options.env, { MY_VAR: 'hello', FOO2: '' });
});

test('timeoutMs is clamped to [1000, 300000]', () => {
  const t = (ms: unknown) =>
    parseTasksJson(JSON.stringify({ tasks: [{ label: 'a', command: 'x', options: { timeoutMs: ms } }] }));
  assert.equal(t(5).tasks[0].options.timeoutMs, 1000);
  assert.equal(t(999_999_999).tasks[0].options.timeoutMs, 300_000);
  assert.equal(t(45_000).tasks[0].options.timeoutMs, 45_000);
  assert.ok(t('soon').errors.length > 0);
});

test('unknown fields warn, do not fail', () => {
  const r = parseTasksJson(JSON.stringify({
    tasks: [{ label: 'a', command: 'x', presentation: { reveal: 'always' }, isBackground: true }],
  }));
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('presentation')));
  assert.ok(r.warnings.some((w) => w.includes('isBackground')));
});

test('too many tasks is fatal', () => {
  const tasks = Array.from({ length: 201 }, (_, i) => ({ label: `t${i}`, command: 'x' }));
  const r = parseTasksJson(JSON.stringify({ tasks }));
  assert.ok(r.errors.some((e) => e.includes('too many')));
});

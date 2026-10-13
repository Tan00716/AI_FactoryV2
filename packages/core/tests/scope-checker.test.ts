/**
 * §17.4 (G-11, Batch 18) — the Scope Checker: structured verdicts on
 * whether proposed work stays inside the ROOT task's authorization
 * scope. checkSubtaskScope judges a proposal before creation;
 * checkTaskScope judges executing an action on an existing task,
 * where the root's CURRENT authorization governs (a child filed
 * while the root was authorized is out of scope once the root is
 * revoked).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryTaskStore,
  TaskManager,
  checkSubtaskScope,
  checkTaskScope,
} from '../src/index';

function seeded() {
  const store = new InMemoryTaskStore();
  const tasks = new TaskManager(store);
  const root = tasks.create({
    title: 'root',
    projectId: 'p1',
    requirementRef: 'REQ-001@2',
    acceptanceCriteria: ['AC-1', 'AC-2'],
    policyCeiling: ['fs.read', 'git.commit'],
    budgetEnvelope: { tokens: 1000 },
  });
  const get = (id: string) => store.get(id);
  return { store, tasks, root, get };
}

test('checkSubtaskScope: a fully in-scope proposal passes', () => {
  const { root, get } = seeded();
  const r = checkSubtaskScope(get, root.id, {
    relation: 'builds the parser the root goal needs',
    scopeTokens: ['fs.read'],
    policyCeiling: ['fs.read'],
    budgetEnvelope: { tokens: 100 },
    acceptanceCriteria: ['AC-1'],
    requirementRef: 'REQ-001@2',
  });
  assert.equal(r.ok, true);
  assert.equal(r.rootTaskId, root.id);
  assert.deepEqual(r.violations, []);
});

test('checkSubtaskScope: every out-of-scope dimension is named at once', () => {
  const { root, get } = seeded();
  const r = checkSubtaskScope(get, root.id, {
    // no relation stated
    scopeTokens: ['shell.execute'],
    budgetEnvelope: { tokens: 2000, cpuMs: 1 },
    acceptanceCriteria: ['AC-9'],
    requirementRef: 'REQ-999@1',
  });
  assert.equal(r.ok, false);
  const kinds = r.violations.map((v) => v.kind);
  assert.ok(kinds.includes('RELATION'));
  assert.ok(kinds.includes('POLICY_CEILING'));
  assert.ok(kinds.includes('ACCEPTANCE_CRITERIA'));
  assert.ok(kinds.includes('REQUIREMENT'));
  assert.equal(r.violations.filter((v) => v.kind === 'BUDGET').length, 2);
  const ceiling = r.violations.find((v) => v.kind === 'POLICY_CEILING')!;
  assert.equal(ceiling.item, 'shell.execute');
});

test('checkSubtaskScope: asking wider authorization than the root is a violation', () => {
  const store = new InMemoryTaskStore();
  const tasks = new TaskManager(store);
  const waiting = tasks.create({
    title: 'waiting',
    projectId: 'p1',
    authorizationStatus: 'WAITING_HUMAN_DISPATCH',
  });
  const r = checkSubtaskScope((id) => store.get(id), waiting.id, {
    relation: 'part of the waiting goal',
    authorizationStatus: 'AUTHORIZED',
  });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.kind === 'AUTHORIZATION'));
});

test('checkSubtaskScope: a missing parent cannot be in scope', () => {
  const { get } = seeded();
  const r = checkSubtaskScope(get, 'no-such-task', { relation: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.rootTaskId, 'no-such-task');
});

test('checkSubtaskScope: dimensions the root never recorded constrain nothing', () => {
  const store = new InMemoryTaskStore();
  const tasks = new TaskManager(store);
  const bare = tasks.create({ title: 'bare', projectId: 'p1' });
  const r = checkSubtaskScope((id) => store.get(id), bare.id, {
    relation: 'part of the bare goal',
    scopeTokens: ['anything'],
    budgetEnvelope: { tokens: 10 },
    requirementRef: 'REQ-X@1',
  });
  assert.equal(r.ok, true);
});

test('checkTaskScope: an AUTHORIZED task under an AUTHORIZED root is in scope', () => {
  const { tasks, root, get } = seeded();
  const sub = tasks.createSubtask(root.id, {
    title: 'child',
    parentRelation: 'part of the root goal',
  });
  const r = checkTaskScope(get, sub.id, { action: 'execute' });
  assert.equal(r.ok, true);
  assert.equal(r.rootTaskId, root.id);
  const rootCheck = checkTaskScope(get, root.id, { action: 'execute' });
  assert.equal(rootCheck.ok, true);
});

test('checkTaskScope: revoking the root takes its live children out of scope', () => {
  const { tasks, get } = seeded();
  const store2root = tasks.create({
    title: 'doomed root',
    projectId: 'p1',
    authorizationStatus: 'DRAFT',
  });
  tasks.requestDispatch(store2root.id);
  tasks.dispatch(store2root.id);
  const sub = tasks.createSubtask(store2root.id, {
    title: 'child',
    parentRelation: 'part of the doomed goal',
  });
  assert.equal(checkTaskScope(get, sub.id, { action: 'execute' }).ok, true);
  tasks.revokeAuthorization(store2root.id);
  const r = checkTaskScope(get, sub.id, { action: 'execute' });
  assert.equal(r.ok, false);
  assert.ok(
    r.violations.some(
      (v) => v.kind === 'AUTHORIZATION' && v.detail.includes('root task'),
    ),
  );
});

test('checkTaskScope: a not-yet-authorized task is out of scope for execution', () => {
  const store = new InMemoryTaskStore();
  const tasks = new TaskManager(store);
  const waiting = tasks.create({
    title: 'waiting',
    projectId: 'p1',
    authorizationStatus: 'WAITING_HUMAN_DISPATCH',
  });
  const r = checkTaskScope((id) => store.get(id), waiting.id, {
    action: 'execute',
  });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.kind === 'AUTHORIZATION'));
  const missing = checkTaskScope((id) => store.get(id), 'nope', {
    action: 'execute',
  });
  assert.equal(missing.ok, false);
});

test('checkTaskScope: a subtask with no stated relation is flagged', () => {
  const { tasks, root, get } = seeded();
  const sub = tasks.createSubtask(root.id, { title: 'silent child' });
  const r = checkTaskScope(get, sub.id, { action: 'execute' });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.kind === 'RELATION'));
});

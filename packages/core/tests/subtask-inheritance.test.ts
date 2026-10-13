/**
 * §17.4 (G-11, Batch 18) — createSubtask inherits from the ROOT task:
 * authorization (never wider than the root), requirement version,
 * 相关 AC, policy ceiling (subset-only) and budget envelope
 * (narrow-only) — and refuses, with ScopeViolationError, any explicit
 * request that would make the subtask wider than its root.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryTaskStore,
  ScopeViolationError,
  TaskManager,
} from '../src/index';

function seeded() {
  const store = new InMemoryTaskStore();
  const tasks = new TaskManager(store);
  const root = tasks.create({
    title: 'root',
    projectId: 'p1',
    authorizationStatus: 'AUTHORIZED',
    requirementRef: 'REQ-001@2',
    acceptanceCriteria: ['AC-1', 'AC-2'],
    policyCeiling: ['fs.read', 'git.commit', 'test.run'],
    budgetEnvelope: { tokens: 10000, moneyMinor: 500 },
  });
  return { store, tasks, root };
}

test('a plain subtask inherits every §17.4 item from the root', () => {
  const { tasks, root } = seeded();
  const sub = tasks.createSubtask(root.id, { title: 'child' });
  assert.equal(sub.authorizationStatus, 'AUTHORIZED');
  assert.equal(sub.requirementRef, 'REQ-001@2');
  assert.deepEqual(sub.acceptanceCriteria, ['AC-1', 'AC-2']);
  assert.deepEqual(sub.policyCeiling, ['fs.read', 'git.commit', 'test.run']);
  assert.deepEqual(sub.budgetEnvelope, { tokens: 10000, moneyMinor: 500 });
  assert.equal(sub.parentTaskId, root.id);
  assert.equal(sub.projectId, 'p1');
  // The inherited containers are copies, not aliases of the root's.
  sub.policyCeiling!.push('shell.execute');
  assert.deepEqual(tasks.get(root.id).policyCeiling, [
    'fs.read',
    'git.commit',
    'test.run',
  ]);
});

test('inheritance resolves through the chain to the ROOT, not the nearest parent', () => {
  const { tasks, root } = seeded();
  const mid = tasks.createSubtask(root.id, {
    title: 'mid',
    policyCeiling: ['fs.read'],
    budgetEnvelope: { tokens: 4000 },
  });
  const leaf = tasks.createSubtask(mid.id, { title: 'leaf' });
  // The leaf inherits the root's ceiling/envelope/pin — the mid's
  // narrowing was the mid's own recorded scope, not a new root.
  assert.deepEqual(leaf.policyCeiling, ['fs.read', 'git.commit', 'test.run']);
  assert.deepEqual(leaf.budgetEnvelope, { tokens: 10000, moneyMinor: 500 });
  assert.equal(leaf.requirementRef, 'REQ-001@2');
  assert.equal(tasks.rootOf(leaf.id).id, root.id);
});

test('authorization: unspecified inherits the root status verbatim', () => {
  const store = new InMemoryTaskStore();
  const tasks = new TaskManager(store);
  const waiting = tasks.create({
    title: 'waiting root',
    projectId: 'p1',
    authorizationStatus: 'WAITING_HUMAN_DISPATCH',
  });
  const sub = tasks.createSubtask(waiting.id, { title: 'child' });
  assert.equal(sub.authorizationStatus, 'WAITING_HUMAN_DISPATCH');

  const draft = tasks.create({
    title: 'draft root',
    projectId: 'p1',
    authorizationStatus: 'DRAFT',
  });
  assert.equal(
    tasks.createSubtask(draft.id, { title: 'child' }).authorizationStatus,
    'DRAFT',
  );
});

test('authorization: an explicit request broader than the root is refused', () => {
  const store = new InMemoryTaskStore();
  const tasks = new TaskManager(store);
  const waiting = tasks.create({
    title: 'waiting root',
    projectId: 'p1',
    authorizationStatus: 'WAITING_HUMAN_DISPATCH',
  });
  assert.throws(
    () =>
      tasks.createSubtask(waiting.id, {
        title: 'sneaky',
        authorizationStatus: 'AUTHORIZED',
      }),
    (e: unknown) =>
      e instanceof ScopeViolationError &&
      e.violations.some((v) => v.kind === 'AUTHORIZATION'),
  );
  // Nothing was created by the refused call.
  assert.equal(tasks.get(waiting.id).subtaskIds.length, 0);
  // A narrower-or-equal explicit request is fine.
  const ok = tasks.createSubtask(waiting.id, {
    title: 'modest',
    authorizationStatus: 'DRAFT',
  });
  assert.equal(ok.authorizationStatus, 'DRAFT');
});

test('authorization: a REVOKED root passes its dead state down — never resurrected', () => {
  const store = new InMemoryTaskStore();
  const tasks = new TaskManager(store);
  const root = tasks.create({
    title: 'root',
    projectId: 'p1',
    authorizationStatus: 'DRAFT',
  });
  tasks.requestDispatch(root.id);
  tasks.dispatch(root.id);
  tasks.revokeAuthorization(root.id);
  assert.equal(tasks.get(root.id).authorizationStatus, 'REVOKED');
  const sub = tasks.createSubtask(root.id, { title: 'filed under a dead root' });
  assert.equal(sub.authorizationStatus, 'REVOKED');
  // And no live state may be requested under the dead root at all.
  assert.throws(
    () =>
      tasks.createSubtask(root.id, {
        title: 'zombie',
        authorizationStatus: 'AUTHORIZED',
      }),
    ScopeViolationError,
  );
});

test('ceiling: a supplied ceiling must be a subset of the root ceiling', () => {
  const { tasks, root } = seeded();
  const narrowed = tasks.createSubtask(root.id, {
    title: 'narrow',
    policyCeiling: ['fs.read'],
  });
  assert.deepEqual(narrowed.policyCeiling, ['fs.read']);
  assert.throws(
    () =>
      tasks.createSubtask(root.id, {
        title: 'wide',
        policyCeiling: ['fs.read', 'shell.execute'],
      }),
    (e: unknown) =>
      e instanceof ScopeViolationError &&
      e.violations.some(
        (v) => v.kind === 'POLICY_CEILING' && v.item === 'shell.execute',
      ),
  );
});

test('budget: a supplied envelope must narrow the root envelope per dimension', () => {
  const { tasks, root } = seeded();
  const narrowed = tasks.createSubtask(root.id, {
    title: 'narrow',
    budgetEnvelope: { tokens: 100 },
  });
  assert.deepEqual(narrowed.budgetEnvelope, { tokens: 100 });
  // Over the cap on an existing dimension.
  assert.throws(
    () =>
      tasks.createSubtask(root.id, {
        title: 'over',
        budgetEnvelope: { tokens: 10001 },
      }),
    (e: unknown) =>
      e instanceof ScopeViolationError &&
      e.violations.some((v) => v.kind === 'BUDGET' && v.item === 'tokens'),
  );
  // A dimension the root never budgeted is a cap of 0.
  assert.throws(
    () =>
      tasks.createSubtask(root.id, {
        title: 'new-dimension',
        budgetEnvelope: { cpuMs: 5 },
      }),
    (e: unknown) =>
      e instanceof ScopeViolationError &&
      e.violations.some((v) => v.kind === 'BUDGET' && v.item === 'cpuMs'),
  );
});

test('requirement pin and ACs: supplied values replace, unspecified inherit', () => {
  const { tasks, root } = seeded();
  const own = tasks.createSubtask(root.id, {
    title: 'own scope',
    requirementRef: 'REQ-001@3',
    acceptanceCriteria: ['AC-1'],
  });
  // A divergent pin is a caller decision at creation time (the Scope
  // Checker flags it — see scope-checker tests); creation records it.
  assert.equal(own.requirementRef, 'REQ-001@3');
  assert.deepEqual(own.acceptanceCriteria, ['AC-1']);
});

test('the parent relation is recorded on the subtask', () => {
  const { tasks, root } = seeded();
  const sub = tasks.createSubtask(root.id, {
    title: 'child',
    parentRelation: 'implements the parser half of the root goal',
  });
  assert.equal(sub.parentRelation, 'implements the parser half of the root goal');
});

test('a root with nothing recorded bequeaths nothing — no invented scope', () => {
  const store = new InMemoryTaskStore();
  const tasks = new TaskManager(store);
  const bare = tasks.create({ title: 'bare root', projectId: 'p1' });
  const sub = tasks.createSubtask(bare.id, { title: 'bare child' });
  assert.equal(sub.requirementRef, undefined);
  assert.equal(sub.policyCeiling, undefined);
  assert.equal(sub.budgetEnvelope, undefined);
  assert.deepEqual(sub.acceptanceCriteria, []);
  // With no root ceiling recorded, a supplied ceiling is the
  // caller's own recording, not a widening of anything.
  const withCeiling = tasks.createSubtask(bare.id, {
    title: 'ceiled child',
    policyCeiling: ['anything.at.all'],
  });
  assert.deepEqual(withCeiling.policyCeiling, ['anything.at.all']);
});

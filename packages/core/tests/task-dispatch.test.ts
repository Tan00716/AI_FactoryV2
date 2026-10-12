/**
 * §17.2 Human Dispatch — the task authorization axis (Batch 17).
 *
 * What this pins:
 *  1. Creation is not execution authorization: a task may be created
 *     as DRAFT (unsubmitted) or WAITING_HUMAN_DISPATCH (a TODO awaiting
 *     a Human Dispatch — the AI-filed-ticket path), while the default
 *     stays AUTHORIZED (the human create-and-dispatch case §17.2
 *     allows, and the behaviour every pre-existing caller relied on).
 *  2. The flow is the spec's chain and nothing else: DRAFT →
 *     WAITING_HUMAN_DISPATCH → AUTHORIZED, dispatch rejection back to
 *     DRAFT, AUTHORIZED → REVOKED, AUTHORIZED/WAITING → EXPIRED.
 *     Illegal moves throw TaskAuthorizationError carrying the observed
 *     state; REVOKED / EXPIRED have no outgoing transitions (the spec
 *     defines none).
 *  3. The authorization axis is independent of the workflow `status`:
 *     dispatching never moves TODO, and setStatus never moves the
 *     authorization.
 *  4. A task object with no authorizationStatus value (persisted
 *     before the field existed) reads as AUTHORIZED.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TaskAuthorizationError,
  TaskManager,
  effectiveAuthorizationStatus,
  type Task,
} from '../src/index';

describe('task authorization (§17.2 Human Dispatch)', () => {
  it('creates AUTHORIZED by default; DRAFT and WAITING are explicit choices', () => {
    const m = new TaskManager();
    const plain = m.create({ projectId: 'p1', title: 'Plain' });
    assert.equal(plain.authorizationStatus, 'AUTHORIZED');
    assert.equal(plain.status, 'TODO');

    const draft = m.create({ projectId: 'p1', title: 'Draft', authorizationStatus: 'DRAFT' });
    assert.equal(draft.authorizationStatus, 'DRAFT');

    const waiting = m.create({
      projectId: 'p1',
      title: 'AI found this',
      creator: 'agent-1',
      authorizationStatus: 'WAITING_HUMAN_DISPATCH',
    });
    assert.equal(waiting.authorizationStatus, 'WAITING_HUMAN_DISPATCH');
    assert.equal(waiting.status, 'TODO');
  });

  it('walks the full chain: DRAFT → WAITING_HUMAN_DISPATCH → AUTHORIZED', () => {
    const m = new TaskManager();
    const t = m.create({ projectId: 'p1', title: 'Chain', authorizationStatus: 'DRAFT' });
    assert.equal(m.requestDispatch(t.id).authorizationStatus, 'WAITING_HUMAN_DISPATCH');
    assert.equal(m.dispatch(t.id).authorizationStatus, 'AUTHORIZED');
    // The stored record carries the final state, not just the return value.
    assert.equal(m.get(t.id).authorizationStatus, 'AUTHORIZED');
  });

  it('dispatch can assign the executor in the same action', () => {
    const m = new TaskManager();
    const t = m.create({
      projectId: 'p1',
      title: 'Assign on dispatch',
      authorizationStatus: 'WAITING_HUMAN_DISPATCH',
    });
    const done = m.dispatch(t.id, { assigneeAgentId: 'agent-7' });
    assert.equal(done.authorizationStatus, 'AUTHORIZED');
    assert.deepEqual(done.assignedAgentIds, ['agent-7']);
    assert.equal(done.currentAgentId, 'agent-7');
  });

  it('rejection returns the task to DRAFT, and it can be resubmitted and dispatched', () => {
    const m = new TaskManager();
    const t = m.create({
      projectId: 'p1',
      title: 'Bounce',
      authorizationStatus: 'WAITING_HUMAN_DISPATCH',
    });
    assert.equal(m.rejectDispatch(t.id).authorizationStatus, 'DRAFT');
    assert.equal(m.requestDispatch(t.id).authorizationStatus, 'WAITING_HUMAN_DISPATCH');
    assert.equal(m.dispatch(t.id).authorizationStatus, 'AUTHORIZED');
  });

  it('revoke and expire land on the spec values', () => {
    const m = new TaskManager();
    const a = m.create({ projectId: 'p1', title: 'Revoke me' });
    assert.equal(m.revokeAuthorization(a.id).authorizationStatus, 'REVOKED');

    const b = m.create({ projectId: 'p1', title: 'Expire me' });
    assert.equal(m.expireAuthorization(b.id).authorizationStatus, 'EXPIRED');

    const c = m.create({
      projectId: 'p1',
      title: 'Expire while waiting',
      authorizationStatus: 'WAITING_HUMAN_DISPATCH',
    });
    assert.equal(m.expireAuthorization(c.id).authorizationStatus, 'EXPIRED');
  });

  it('illegal moves throw TaskAuthorizationError carrying the observed state', () => {
    const m = new TaskManager();
    const draft = m.create({ projectId: 'p1', title: 'D', authorizationStatus: 'DRAFT' });
    // A DRAFT must be submitted before it can be dispatched — the
    // waiting state is never skipped silently.
    assert.throws(
      () => m.dispatch(draft.id),
      (e: unknown) =>
        e instanceof TaskAuthorizationError && e.from === 'DRAFT' && e.taskId === draft.id,
    );
    assert.throws(() => m.rejectDispatch(draft.id), TaskAuthorizationError);
    assert.throws(() => m.revokeAuthorization(draft.id), TaskAuthorizationError);

    const authorized = m.create({ projectId: 'p1', title: 'A' });
    assert.throws(() => m.requestDispatch(authorized.id), TaskAuthorizationError);
    assert.throws(() => m.dispatch(authorized.id), TaskAuthorizationError);

    // REVOKED / EXPIRED are terminal in the spec's flow: no way back in.
    m.revokeAuthorization(authorized.id);
    assert.throws(() => m.dispatch(authorized.id), TaskAuthorizationError);
    assert.throws(() => m.requestDispatch(authorized.id), TaskAuthorizationError);
    assert.throws(() => m.expireAuthorization(authorized.id), TaskAuthorizationError);
    assert.equal(m.get(authorized.id).authorizationStatus, 'REVOKED');
  });

  it('the authorization axis is independent of the workflow status', () => {
    const m = new TaskManager();
    const t = m.create({
      projectId: 'p1',
      title: 'Two axes',
      authorizationStatus: 'WAITING_HUMAN_DISPATCH',
    });
    m.dispatch(t.id);
    const after = m.get(t.id);
    assert.equal(after.authorizationStatus, 'AUTHORIZED');
    assert.equal(after.status, 'TODO'); // dispatch does not start the work

    m.setStatus(t.id, 'IN_PROGRESS');
    assert.equal(m.get(t.id).authorizationStatus, 'AUTHORIZED'); // nor does status move it
  });

  it('a task with no recorded authorization reads as AUTHORIZED (pre-field compat)', () => {
    const m = new TaskManager();
    const t = m.create({ projectId: 'p1', title: 'Legacy shape' });
    const bare: Task = { ...t };
    delete bare.authorizationStatus;
    assert.equal(bare.authorizationStatus, undefined);
    assert.equal(effectiveAuthorizationStatus(bare), 'AUTHORIZED');
    assert.equal(effectiveAuthorizationStatus(t), 'AUTHORIZED');
  });
});

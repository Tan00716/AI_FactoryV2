/**
 * Tests for task squads (spec §20).
 * Run: node --test dist/tests/squad.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SquadManager, SquadError } from '../src/index';

const clock = { now: () => 1_789_000_000_000 };
const laterClock = { now: () => 1_789_000_360_000 };

describe('SquadManager lifecycle', () => {
  it('assembles a squad for a task with the candidate members', () => {
    const mgr = new SquadManager();
    const squad = mgr.assemble('TASK-1042', ['lead', 'backend', 'qa'], { clock });
    assert.equal(squad.taskId, 'TASK-1042');
    assert.deepEqual(squad.memberIds, ['lead', 'backend', 'qa']);
    assert.equal(squad.status, 'active');
    assert.equal(squad.archivedAt, null);
    assert.equal(squad.createdAt, new Date(1_789_000_000_000).toISOString());
    assert.ok(squad.id.length > 0);
  });

  it('dedupes members and respects maxMembers', () => {
    const mgr = new SquadManager();
    const squad = mgr.assemble('T1', ['a', 'a', 'b', 'c'], { maxMembers: 2 });
    assert.deepEqual(squad.memberIds, ['a', 'b']);
  });

  it('rejects a second active squad for the same task', () => {
    const mgr = new SquadManager();
    mgr.assemble('T1', ['a']);
    assert.throws(() => mgr.assemble('T1', ['b']), (e: unknown) => e instanceof SquadError);
  });

  it('rejects empty candidate lists and empty task ids', () => {
    const mgr = new SquadManager();
    assert.throws(() => mgr.assemble('T1', []), SquadError);
    assert.throws(() => mgr.assemble('', ['a']), SquadError);
  });

  it('adds and removes members on an active squad', () => {
    const mgr = new SquadManager();
    mgr.assemble('T1', ['a']);
    mgr.addMember('T1', 'b');
    assert.deepEqual(mgr.listActive()[0].memberIds, ['a', 'b']);
    // Adding twice is idempotent.
    mgr.addMember('T1', 'b');
    assert.deepEqual(mgr.listActive()[0].memberIds, ['a', 'b']);
    mgr.removeMember('T1', 'a');
    assert.deepEqual(mgr.listActive()[0].memberIds, ['b']);
    // Removing a non-member is a no-op.
    mgr.removeMember('T1', 'zzz');
    assert.deepEqual(mgr.listActive()[0].memberIds, ['b']);
  });

  it('archive() marks the squad archived and returns members to the pool', () => {
    const mgr = new SquadManager();
    mgr.assemble('T1', ['a', 'b'], { clock });
    const done = mgr.archive('T1', { clock: laterClock });
    assert.equal(done.status, 'archived');
    assert.equal(done.archivedAt, new Date(1_789_000_360_000).toISOString());
    // No longer active: members are free for other tasks.
    assert.deepEqual(mgr.listActive(), []);
    assert.deepEqual(mgr.claimedMembers(), []);
    assert.equal(mgr.listArchived().length, 1);
    // Members can be reassembled into a new squad — pool semantics.
    const next = mgr.assemble('T2', ['a', 'b']);
    assert.equal(next.status, 'active');
  });

  it('refuses to mutate archived squads', () => {
    const mgr = new SquadManager();
    mgr.assemble('T1', ['a']);
    mgr.archive('T1');
    assert.throws(() => mgr.addMember('T1', 'b'), SquadError);
    assert.throws(() => mgr.removeMember('T1', 'a'), SquadError);
    assert.throws(() => mgr.archive('T1'), SquadError);
  });
});

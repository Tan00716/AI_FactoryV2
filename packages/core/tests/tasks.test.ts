/**
 * Unit tests for the task system (spec §8) and dependency graph (spec §60).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskDependencyError, TaskManager } from '../src/index';

describe('task system', () => {
  it('creates tasks in TODO with defaults', () => {
    const m = new TaskManager();
    const t = m.create({ projectId: 'p1', title: 'Do a thing' });
    assert.equal(t.status, 'TODO');
    assert.equal(t.priority, 'P2');
    assert.equal(t.creator, 'human');
    assert.deepEqual(t.subtaskIds, []);
  });

  it('creates subtasks linked to their parent', () => {
    const m = new TaskManager();
    const parent = m.create({ projectId: 'p1', title: 'Epic' });
    const sub = m.createSubtask(parent.id, { title: 'Sub 1' });
    assert.equal(sub.parentTaskId, parent.id);
    assert.equal(sub.projectId, parent.projectId);
    assert.ok(m.get(parent.id).subtaskIds.includes(sub.id));
  });

  it('adds dependencies and rejects self-dependency', () => {
    const m = new TaskManager();
    const a = m.create({ projectId: 'p1', title: 'A' });
    const b = m.create({ projectId: 'p1', title: 'B' });
    m.addDependency(b.id, 'depends_on', a.id);
    assert.deepEqual(m.get(b.id).dependencies, [{ kind: 'depends_on', taskId: a.id }]);
    assert.throws(() => m.addDependency(a.id, 'depends_on', a.id), TaskDependencyError);
  });

  it('rejects dependency cycles', () => {
    const m = new TaskManager();
    const a = m.create({ projectId: 'p1', title: 'A' });
    const b = m.create({ projectId: 'p1', title: 'B' });
    const c = m.create({ projectId: 'p1', title: 'C' });
    m.addDependency(b.id, 'depends_on', a.id);
    m.addDependency(c.id, 'blocked_by', b.id);
    assert.throws(
      () => m.addDependency(a.id, 'depends_on', c.id),
      /cycle/,
    );
  });

  it('assigns agents and tracks the current agent', () => {
    const m = new TaskManager();
    const t = m.create({ projectId: 'p1', title: 'T' });
    m.assignAgent(t.id, 'agent-1');
    m.assignAgent(t.id, 'agent-2');
    const got = m.get(t.id);
    assert.equal(got.currentAgentId, 'agent-2');
    assert.deepEqual(got.assignedAgentIds, ['agent-1', 'agent-2']);
  });
});

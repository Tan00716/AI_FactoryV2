import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidRunStateTransition,
  RUN_STATES,
  RUN_STATE_TRANSITIONS,
  RunStateMachine,
} from '../src/index';

describe('run states (§25)', () => {
  it('exposes all 12 states', () => {
    assert.equal(RUN_STATES.length, 12);
    for (const s of [
      'QUEUED', 'STARTING', 'RUNNING', 'WAITING_TOOL', 'WAITING_APPROVAL',
      'PAUSED', 'BLOCKED', 'QUOTA_LIMITED', 'RECOVERING',
      'SUCCEEDED', 'FAILED', 'CANCELLED',
    ] as const) {
      assert.ok((RUN_STATES as readonly string[]).includes(s), s);
    }
  });

  it('walks a happy path and records history', () => {
    const m = new RunStateMachine('run-1', 'task-1');
    assert.equal(m.state, 'QUEUED');
    m.transition('STARTING');
    m.transition('RUNNING');
    m.transition('WAITING_TOOL');
    m.transition('RUNNING');
    m.succeed('tests 12/12 passed on candidate abc123');
    assert.equal(m.state, 'SUCCEEDED');
    assert.ok(m.isTerminal);
    assert.equal(m.snapshot.history.length, 5);
    assert.equal(m.snapshot.outputContract, 'tests 12/12 passed on candidate abc123');
  });

  it('rejects illegal jumps', () => {
    const m = new RunStateMachine('run-2', 'task-2');
    assert.throws(() => m.transition('SUCCEEDED'), InvalidRunStateTransition);
    assert.equal(m.state, 'QUEUED'); // unchanged
  });

  it('terminal states have no outgoing edges', () => {
    for (const s of ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
      assert.deepEqual(RUN_STATE_TRANSITIONS[s], []);
    }
  });

  it('supports pause/recover and quota-limited flows', () => {
    const m = new RunStateMachine('run-3', 'task-3');
    m.transition('STARTING');
    m.transition('RUNNING');
    m.transition('QUOTA_LIMITED', 'provider quota hit');
    m.transition('PAUSED');
    m.transition('RECOVERING');
    m.transition('RUNNING');
    m.transition('FAILED', 'tool hung');
    assert.equal(m.state, 'FAILED');
    assert.equal(m.snapshot.history[2].reason, 'provider quota hit');
  });
});

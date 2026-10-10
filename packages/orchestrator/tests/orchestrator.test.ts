/**
 * Tests for the orchestrator (spec §92): next-action mapping across the
 * §11 workflow, retry/escalate policy, handoff records, and the pattern
 * chooser (spec §21).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideNextAction,
  createHandoff,
  Orchestrator,
  choosePattern,
  NextAction,
} from '../src/index';

describe('decideNextAction — happy path (§11)', () => {
  const cases: Array<[string, NextAction]> = [
    ['TODO', 'decompose'],
    ['PLANNING', 'assign'],
    ['IN_PROGRESS', 'run'],
    ['CODE_REVIEW', 'request-review'],
    ['PENDING_QA', 'request-qa'],
    ['QA', 'request-qa'],
    ['PENDING_UAT_MERGE', 'merge'],
    ['UAT', 'verify'],
    ['PENDING_PROD', 'deploy'],
    ['PROD_DEPLOYING', 'deploy'],
    ['PROD_VERIFICATION', 'verify'],
    ['DONE', 'complete'],
  ];
  for (const [status, expected] of cases) {
    it(`${status} → ${expected}`, () => {
      assert.equal(
        decideNextAction({ status: status as never, evidence: [], failures: 0 }),
        expected,
      );
    });
  }
});

describe('decideNextAction — exception path', () => {
  it('BLOCKED → escalate', () => {
    assert.equal(decideNextAction({ status: 'BLOCKED', evidence: [], failures: 0 }), 'escalate');
  });

  it('QA_FAILED retries while retries remain, then escalates', () => {
    assert.equal(decideNextAction({ status: 'QA_FAILED', evidence: [], failures: 0 }), 'retry');
    assert.equal(decideNextAction({ status: 'QA_FAILED', evidence: [], failures: 2 }), 'retry');
    assert.equal(decideNextAction({ status: 'QA_FAILED', evidence: [], failures: 3 }), 'escalate');
  });

  it('honours a custom maxRetries', () => {
    assert.equal(
      decideNextAction({ status: 'UAT_FAILED', evidence: [], failures: 1 }, { maxRetries: 1 }),
      'escalate',
    );
  });

  it('ROLLBACK → escalate; CANCELLED/REJECTED/ESCALATED → noop', () => {
    assert.equal(decideNextAction({ status: 'ROLLBACK', evidence: [], failures: 0 }), 'escalate');
    assert.equal(decideNextAction({ status: 'CANCELLED', evidence: [], failures: 0 }), 'noop');
    assert.equal(decideNextAction({ status: 'REJECTED', evidence: [], failures: 0 }), 'noop');
    assert.equal(decideNextAction({ status: 'ESCALATED', evidence: [], failures: 0 }), 'noop');
  });
});

describe('handoff', () => {
  it('creates an immutable record with a deterministic timestamp', () => {
    const clock = { now: () => 1728450000000 };
    const h = createHandoff(
      {
        from: 'tech-lead',
        to: 'postgres-specialist',
        taskId: 'task-1042',
        reason: 'locking root cause needs deep Postgres expertise',
        contextSummary: 'investigation evidence sealed; reproduction pending',
      },
      clock,
    );
    assert.equal(h.at, '2024-10-09T05:00:00.000Z');
    assert.equal(h.from, 'tech-lead');
    assert.equal(h.to, 'postgres-specialist');
  });
});

describe('Orchestrator class', () => {
  it('decides and audits with an injected clock', () => {
    const clock = { now: () => 1000 };
    const orch = new Orchestrator({ clock, maxRetries: 2 });
    const action = orch.decideAndAudit('t1', { status: 'TODO', evidence: [], failures: 0 }, 'new task');
    assert.equal(action, 'decompose');
    const trail = orch.auditTrail();
    assert.equal(trail.length, 1);
    assert.equal(trail[0]!.at, '1970-01-01T00:00:01.000Z');
    assert.equal(trail[0]!.action, 'decompose');
  });

  it('createHandoff uses the orchestrator clock', () => {
    const orch = new Orchestrator({ clock: { now: () => 2000 } });
    const h = orch.createHandoff({ from: 'a', to: 'b', taskId: 't', reason: 'r', contextSummary: 'c' });
    assert.equal(h.at, '1970-01-01T00:00:02.000Z');
  });
});

describe('choosePattern (§21)', () => {
  it('fan-out with multiple subtasks → manager', () => {
    assert.equal(
      choosePattern({ subtaskCount: 4, fanOut: true, sequentialPipeline: false }),
      'manager',
    );
  });

  it('sequential pipeline → handoff', () => {
    assert.equal(
      choosePattern({ subtaskCount: 4, fanOut: false, sequentialPipeline: true }),
      'handoff',
    );
  });

  it('single subtask → manager (degenerate: owner executes directly)', () => {
    assert.equal(
      choosePattern({ subtaskCount: 1, fanOut: false, sequentialPipeline: false }),
      'manager',
    );
  });

  it('pipeline flag with fan-out → manager (coordination wins)', () => {
    assert.equal(
      choosePattern({ subtaskCount: 3, fanOut: true, sequentialPipeline: true }),
      'manager',
    );
  });
});

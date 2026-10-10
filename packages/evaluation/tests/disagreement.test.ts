/**
 * Tests for the §96–§97 AI disagreement independent adjudication module:
 * disagreement detection, evidence collection with weak-side flagging,
 * the independent adjudication flow (adjudicate / escalate), the §97
 * independent-verification gate, and the DisputeCoordinator.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjudicate,
  AgentDisputeVerdict,
  collectEvidence,
  DEFAULT_CONFIDENCE_THRESHOLD,
  defaultHeuristicEvaluator,
  detectDisagreement,
  Dispute,
  DisputeAuditEvent,
  DisputeCoordinator,
  DisputeTransitionError,
  EvidenceIndex,
  shouldUseIndependentVerification,
  verdictsConflict,
} from '../src/index';

const NOW = 1_000_000;
const clock = { now: () => NOW };

function verdict(
  agent: string,
  v: 'PASS' | 'FAIL' | 'WARN',
  evidenceIds: string[] = ['ev-1'],
  reason = 'stated reason',
): AgentDisputeVerdict {
  return { agent, verdict: v, evidenceIds, reason };
}

function openDispute(
  a: AgentDisputeVerdict = verdict('coder', 'PASS'),
  b: AgentDisputeVerdict = verdict('reviewer', 'FAIL'),
): Dispute {
  const d = detectDisagreement(a, b, clock);
  assert.ok(d, 'expected a dispute to be detected');
  return d;
}

function auditSink() {
  const events: DisputeAuditEvent[] = [];
  return { events, hook: (e: DisputeAuditEvent) => events.push(e) };
}

describe('verdictsConflict', () => {
  it('treats PASS vs FAIL as a conflict', () => {
    assert.equal(verdictsConflict('PASS', 'FAIL'), true);
    assert.equal(verdictsConflict('FAIL', 'PASS'), true);
  });

  it('treats WARN vs FAIL as a conflict', () => {
    assert.equal(verdictsConflict('WARN', 'FAIL'), true);
  });

  it('treats identical verdicts as no conflict', () => {
    assert.equal(verdictsConflict('PASS', 'PASS'), false);
    assert.equal(verdictsConflict('FAIL', 'FAIL'), false);
    assert.equal(verdictsConflict('WARN', 'WARN'), false);
  });

  it('treats PASS vs WARN as partial agreement, not a disagreement', () => {
    assert.equal(verdictsConflict('PASS', 'WARN'), false);
    assert.equal(verdictsConflict('WARN', 'PASS'), false);
  });
});

describe('detectDisagreement', () => {
  it('opens a dispute when Coder says PASS and Reviewer says FAIL (§96 example)', () => {
    const d = detectDisagreement(
      verdict('coder', 'PASS', ['ev-tests', 'ev-review']),
      verdict('reviewer', 'FAIL', ['ev-bug-report']),
      clock,
    );
    assert.ok(d);
    assert.ok(d.disputeId.startsWith('dsp_'));
    assert.equal(d.status, 'OPEN');
    assert.equal(d.openedAt, NOW);
    assert.equal(d.evidenceReady, true);
    assert.equal(d.history.length, 1);
    assert.equal(d.history[0].from, 'NONE');
    assert.equal(d.history[0].to, 'OPEN');
  });

  it('returns null when both agents agree', () => {
    assert.equal(
      detectDisagreement(verdict('a', 'PASS'), verdict('b', 'PASS'), clock),
      null,
    );
  });

  it('returns null for PASS vs WARN partial agreement', () => {
    assert.equal(
      detectDisagreement(verdict('a', 'PASS'), verdict('b', 'WARN'), clock),
      null,
    );
  });

  it('opens the dispute even when one side cites no evidence, flagged not ready', () => {
    const d = detectDisagreement(
      verdict('coder', 'PASS', []),
      verdict('reviewer', 'FAIL', ['ev-bug']),
      clock,
    );
    assert.ok(d);
    assert.equal(d.evidenceReady, false);
  });
});

describe('collectEvidence', () => {
  it('flags the side with no evidence as weak first', () => {
    const d = openDispute(verdict('coder', 'PASS', []), verdict('reviewer', 'FAIL', ['ev-1']));
    const c = collectEvidence(d, undefined, clock);
    assert.equal(c.weakSide, 'A');
    assert.deepEqual(c.sideA.weaknesses, ['no-evidence-cited']);
    assert.equal(c.collectedAt, NOW);
  });

  it('reports weakSide null when both sides cite equal evidence', () => {
    const d = openDispute(
      verdict('coder', 'PASS', ['ev-1', 'ev-2']),
      verdict('reviewer', 'FAIL', ['ev-3', 'ev-4']),
    );
    const c = collectEvidence(d);
    assert.equal(c.weakSide, null);
    assert.equal(c.sideA.items.length, 2);
    assert.equal(c.sideB.items.length, 2);
  });

  it('flags the side with fewer evidence items as weaker', () => {
    const d = openDispute(
      verdict('coder', 'PASS', ['ev-1']),
      verdict('reviewer', 'FAIL', ['ev-2', 'ev-3', 'ev-4']),
    );
    const c = collectEvidence(d);
    assert.equal(c.weakSide, 'A');
    assert.ok(c.sideA.weaknesses.includes('fewer-evidence-items'));
  });

  it('resolves evidence items from an index and degrades unknown ids', () => {
    const index: EvidenceIndex = {
      'ev-tests': {
        id: 'ev-tests',
        kind: 'test-report',
        testCoverage: 0.9,
        summary: '120 tests green',
      },
    };
    const d = openDispute(
      verdict('coder', 'PASS', ['ev-tests', 'ev-mystery']),
      verdict('reviewer', 'FAIL', ['ev-note']),
    );
    const c = collectEvidence(d, index);
    assert.equal(c.sideA.items[0].kind, 'test-report');
    assert.equal(c.sideA.items[1].kind, 'other');
    assert.equal(c.weakSide, 'B');
  });

  it('flags low test coverage as a weakness', () => {
    const index: EvidenceIndex = {
      'ev-1': { id: 'ev-1', kind: 'test-report', testCoverage: 0.1 },
    };
    const d = openDispute();
    const c = collectEvidence(d, index);
    assert.ok(c.sideA.weaknesses.includes('low-test-coverage'));
  });
});

describe('defaultHeuristicEvaluator', () => {
  it('lets the side with complete evidence and high coverage win decisively', () => {
    const index: EvidenceIndex = {
      'ev-a1': { id: 'ev-a1', kind: 'test-report', testCoverage: 1 },
      'ev-a2': { id: 'ev-a2', kind: 'test-report', testCoverage: 1 },
      'ev-a3': { id: 'ev-a3', kind: 'review-note', testCoverage: 1 },
      'ev-b1': { id: 'ev-b1', kind: 'other', testCoverage: 0 },
    };
    const d = openDispute(
      verdict('coder', 'PASS', ['ev-a1', 'ev-a2', 'ev-a3']),
      verdict('reviewer', 'FAIL', ['ev-b1']),
    );
    const ruling = defaultHeuristicEvaluator({
      dispute: d,
      evidence: collectEvidence(d, index),
    });
    assert.ok(ruling);
    assert.equal(ruling.winner, 'A');
    assert.ok(ruling.confidence >= DEFAULT_CONFIDENCE_THRESHOLD);
    assert.ok(ruling.rationale.includes('coder'));
  });

  it('abstains (null) when neither side has evidence', () => {
    const d = openDispute(verdict('coder', 'PASS', []), verdict('reviewer', 'FAIL', []));
    const ruling = defaultHeuristicEvaluator({
      dispute: d,
      evidence: collectEvidence(d),
    });
    assert.equal(ruling, null);
  });

  it('abstains when the margin is a near tie', () => {
    const index: EvidenceIndex = {
      'ev-a': { id: 'ev-a', kind: 'log', testCoverage: 0.5 },
      'ev-b': { id: 'ev-b', kind: 'log', testCoverage: 0.52 },
    };
    const d = openDispute(
      verdict('coder', 'PASS', ['ev-a']),
      verdict('reviewer', 'FAIL', ['ev-b']),
    );
    const ruling = defaultHeuristicEvaluator({
      dispute: d,
      evidence: collectEvidence(d, index),
    });
    assert.equal(ruling, null);
  });
});

describe('adjudicate', () => {
  it('runs OPEN → EVIDENCE_COLLECTED → ADJUDICATED with audit events in order', () => {
    const { events, hook } = auditSink();
    const index: EvidenceIndex = {
      'ev-a1': { id: 'ev-a1', kind: 'test-report', testCoverage: 1 },
      'ev-a2': { id: 'ev-a2', kind: 'test-report', testCoverage: 1 },
      'ev-a3': { id: 'ev-a3', kind: 'review-note', testCoverage: 1 },
      'ev-b1': { id: 'ev-b1', kind: 'other', testCoverage: 0 },
    };
    const d = openDispute(
      verdict('coder', 'PASS', ['ev-a1', 'ev-a2', 'ev-a3']),
      verdict('reviewer', 'FAIL', ['ev-b1']),
    );
    const outcome = adjudicate(d, {
      evidenceIndex: index,
      now: () => NOW,
      audit: hook,
    });
    assert.equal(outcome.status, 'ADJUDICATED');
    assert.equal(outcome.dispute.status, 'ADJUDICATED');
    if (outcome.status === 'ADJUDICATED') {
      assert.equal(outcome.ruling.winner, 'A');
    }
    assert.deepEqual(
      d.history.map((h) => h.to),
      ['OPEN', 'EVIDENCE_COLLECTED', 'ADJUDICATED'],
    );
    assert.deepEqual(
      events.map((e) => e.type),
      ['evidence_collected', 'adjudicated'],
    );
    assert.equal(events[1].details['winner'], 'A');
    assert.equal(events[0].details['weakSide'], 'B');
  });

  it('escalates when evaluator confidence is below the threshold', () => {
    const { events, hook } = auditSink();
    const d = openDispute();
    const outcome = adjudicate(d, {
      evaluator: () => ({ winner: 'A', rationale: 'gut feeling', confidence: 0.2 }),
      now: () => NOW,
      audit: hook,
    });
    assert.equal(outcome.status, 'ESCALATED');
    assert.equal(outcome.dispute.status, 'ESCALATED');
    if (outcome.status === 'ESCALATED') {
      const esc = outcome.escalation;
      assert.ok(esc.escalationId.startsWith('esc_'));
      assert.equal(esc.disputeId, d.disputeId);
      assert.ok(
        esc.reasons.some((r) => r.includes('below threshold')),
        `reasons: ${esc.reasons.join('|')}`,
      );
      assert.ok(esc.pendingHumanActions.length > 0);
      assert.ok(
        esc.pendingHumanActions[0].includes('coder') &&
          esc.pendingHumanActions[0].includes('reviewer'),
      );
      assert.equal(esc.evidenceBySide.length, 2);
      assert.ok(esc.evidenceBySide.every((s) => s.weaknesses.length >= 0));
    }
    assert.deepEqual(
      events.map((e) => e.type),
      ['evidence_collected', 'escalated'],
    );
  });

  it('escalates when the evaluator cannot decide (returns null)', () => {
    const d = openDispute(verdict('coder', 'PASS', []), verdict('reviewer', 'FAIL', []));
    const outcome = adjudicate(d, {
      evaluator: () => null,
      now: () => NOW,
    });
    assert.equal(outcome.status, 'ESCALATED');
    if (outcome.status === 'ESCALATED') {
      assert.ok(
        outcome.escalation.reasons.some((r) => r.includes('abstained')),
      );
      assert.ok(
        outcome.escalation.reasons.some((r) => r.includes('neither side cited evidence')),
      );
    }
  });

  it('refuses to adjudicate a dispute that is already closed', () => {
    const index: EvidenceIndex = {
      'ev-a': { id: 'ev-a', kind: 'test-report', testCoverage: 1 },
    };
    const d = openDispute(verdict('coder', 'PASS', ['ev-a']), verdict('reviewer', 'FAIL', []));
    const first = adjudicate(d, { evidenceIndex: index, now: () => NOW });
    assert.equal(first.status, 'ADJUDICATED');
    assert.throws(() => adjudicate(d, { now: () => NOW }), DisputeTransitionError);
  });

  it('refuses to re-adjudicate an escalated dispute', () => {
    const d = openDispute();
    const outcome = adjudicate(d, { evaluator: () => null, now: () => NOW });
    assert.equal(outcome.status, 'ESCALATED');
    assert.throws(
      () => adjudicate(d, { evaluator: () => null, now: () => NOW }),
      DisputeTransitionError,
    );
  });
});

describe('shouldUseIndependentVerification (§97)', () => {
  it('enables independent verification for the four high-stakes scenarios', () => {
    for (const category of [
      'security',
      'architecture',
      'high-risk-deployment',
      'complex-bug',
    ]) {
      const decision = shouldUseIndependentVerification({
        taskId: 't-1',
        category,
      });
      assert.equal(decision.use, true, category);
      assert.equal(decision.scenario, category);
      assert.ok(decision.reason.includes('§97'));
    }
  });

  it('normalizes category spelling (spaces / underscores / case)', () => {
    const decision = shouldUseIndependentVerification({
      taskId: 't-1',
      category: 'High_Risk Deployment',
    });
    assert.equal(decision.use, true);
    assert.equal(decision.scenario, 'high-risk-deployment');
  });

  it('skips routine tasks with a token-saving reason', () => {
    for (const category of ['docs', 'refactor', 'ui-tweak', 'routine']) {
      const decision = shouldUseIndependentVerification({
        taskId: 't-2',
        category,
      });
      assert.equal(decision.use, false, category);
      assert.ok(
        decision.reason.includes('token'),
        `reason: ${decision.reason}`,
      );
      assert.equal(decision.scenario, undefined);
    }
  });
});

describe('DisputeCoordinator', () => {
  it('runs open → adjudicate end to end and tracks dispute state', () => {
    const { events, hook } = auditSink();
    const index: EvidenceIndex = {
      'ev-a1': { id: 'ev-a1', kind: 'test-report', testCoverage: 1 },
      'ev-a2': { id: 'ev-a2', kind: 'test-report', testCoverage: 1 },
      'ev-a3': { id: 'ev-a3', kind: 'review-note', testCoverage: 1 },
    };
    const coord = new DisputeCoordinator({
      now: () => NOW,
      evidenceIndex: index,
      audit: hook,
    });
    const d = coord.open(
      verdict('coder', 'PASS', ['ev-a1', 'ev-a2', 'ev-a3']),
      verdict('reviewer', 'FAIL', []),
    );
    assert.ok(d);
    assert.equal(d.status, 'OPEN');
    const outcome = coord.adjudicate(d.disputeId);
    assert.equal(outcome.status, 'ADJUDICATED');
    assert.equal(coord.get(d.disputeId)?.status, 'ADJUDICATED');
    assert.deepEqual(coord.list('ADJUDICATED').map((x) => x.disputeId), [
      d.disputeId,
    ]);
    assert.deepEqual(coord.list('ESCALATED'), []);
    assert.deepEqual(
      events.map((e) => e.type),
      ['dispute_opened', 'evidence_collected', 'adjudicated'],
    );
  });

  it('records escalations and lets an injected evaluator side with the reviewer', () => {
    const coord = new DisputeCoordinator({
      now: () => NOW,
      evaluator: ({ evidence }) => ({
        winner: evidence.weakSide === 'A' ? 'B' : 'A',
        rationale: 'side with the weaker evidence loses',
        confidence: 0.9,
      }),
    });
    // Reviewer cites solid evidence; coder cites nothing → reviewer wins.
    const d = coord.open(
      verdict('coder', 'PASS', []),
      verdict('reviewer', 'FAIL', ['ev-bug', 'ev-test']),
    );
    assert.ok(d);
    const outcome = coord.adjudicate(d.disputeId);
    assert.equal(outcome.status, 'ADJUDICATED');
    if (outcome.status === 'ADJUDICATED') {
      assert.equal(outcome.ruling.winner, 'B');
    }
    assert.equal(coord.escalations().length, 0);
  });

  it('tracks escalated disputes separately', () => {
    const coord = new DisputeCoordinator({
      now: () => NOW,
      evaluator: () => null,
    });
    const d = coord.open(verdict('a', 'PASS', []), verdict('b', 'FAIL', []));
    assert.ok(d);
    const outcome = coord.adjudicate(d.disputeId);
    assert.equal(outcome.status, 'ESCALATED');
    assert.equal(coord.escalations().length, 1);
    assert.equal(coord.list('ESCALATED').length, 1);
    if (outcome.status === 'ESCALATED') {
      assert.equal(coord.escalations()[0].escalationId, outcome.escalation.escalationId);
    }
  });

  it('throws for unknown dispute ids', () => {
    const coord = new DisputeCoordinator();
    assert.throws(() => coord.adjudicate('dsp_nope'), DisputeTransitionError);
  });

  it('returns null from open() when there is no disagreement', () => {
    const coord = new DisputeCoordinator();
    assert.equal(
      coord.open(verdict('a', 'PASS'), verdict('b', 'PASS')),
      null,
    );
    assert.deepEqual(coord.list(), []);
  });
});

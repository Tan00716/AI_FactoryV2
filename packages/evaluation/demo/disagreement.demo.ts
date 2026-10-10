/**
 * AI disagreement independent adjudication demo — spec §96–§97.
 *
 *  1. Coder says PASS, Reviewer says FAIL → dispute opened (§96).
 *  2. §97 gate: independent verification is enabled for a security task,
 *     skipped (with a recorded reason) for a routine docs task.
 *  3. Clear-cut dispute → independent adjudication resolves it
 *     (OPEN → EVIDENCE_COLLECTED → ADJUDICATED).
 *  4. Evidence-free dispute → evaluator abstains → ESCALATED with a
 *     human-action record.
 *
 * Run after building:
 *   npm run build -w @ai-factory/evaluation
 *   node packages/evaluation/dist/demo/disagreement.demo.js
 */
import {
  DisputeAuditEvent,
  DisputeCoordinator,
  shouldUseIndependentVerification,
} from '../src/index';

let now = Date.now();
const clock = { now: () => now };
const advance = (ms: number): void => {
  now += ms;
};

const auditTrail: DisputeAuditEvent[] = [];
const coord = new DisputeCoordinator({
  now: () => now,
  audit: (e) => auditTrail.push(e),
  evidenceIndex: {
    'ev-tests-881': {
      id: 'ev-tests-881',
      kind: 'test-report',
      testCoverage: 1,
      summary: '214/214 tests green, incl. new auth tests',
    },
    'ev-review-77': {
      id: 'ev-review-77',
      kind: 'review-note',
      testCoverage: 0.9,
      summary: 'senior review: logic sound, edge cases covered',
    },
    'ev-lint': {
      id: 'ev-lint',
      kind: 'metric',
      testCoverage: 0.4,
      summary: 'lint clean',
    },
  },
});

console.log('== §97 gate: where is independent verification useful? ==');
for (const category of ['security', 'docs']) {
  const d = shouldUseIndependentVerification({ taskId: 'task-42', category });
  console.log(`  [${category}] use=${d.use} — ${d.reason}`);
}

console.log('\n== §96 dispute 1: Coder PASS vs Reviewer FAIL ==');
advance(1000);
const d1 = coord.open(
  {
    agent: 'coder',
    verdict: 'PASS',
    evidenceIds: ['ev-tests-881', 'ev-review-77', 'ev-lint'],
    reason: 'all tests green and reviewed',
  },
  {
    agent: 'reviewer',
    verdict: 'FAIL',
    evidenceIds: [],
    reason: 'saw a flaky-looking test, no proof attached',
  },
);
if (!d1) throw new Error('expected a dispute');
console.log(
  `  opened ${d1.disputeId} (${d1.verdictA.agent} ${d1.verdictA.verdict} vs ` +
    `${d1.verdictB.agent} ${d1.verdictB.verdict}), evidenceReady=${d1.evidenceReady}`,
);

advance(1000);
const out1 = coord.adjudicate(d1.disputeId);
console.log(`  status → ${out1.status}`);
if (out1.status === 'ADJUDICATED') {
  console.log(
    `  winner: side ${out1.ruling.winner} ` +
      `(confidence ${out1.ruling.confidence.toFixed(2)})`,
  );
  console.log(`  rationale: ${out1.ruling.rationale}`);
}

console.log('\n== §96 dispute 2: no evidence on either side → ESCALATED ==');
advance(1000);
const d2 = coord.open(
  { agent: 'coder', verdict: 'PASS', evidenceIds: [], reason: 'works on my machine' },
  { agent: 'reviewer', verdict: 'FAIL', evidenceIds: [], reason: 'feels wrong' },
);
if (!d2) throw new Error('expected a dispute');
advance(1000);
const out2 = coord.adjudicate(d2.disputeId);
console.log(`  status → ${out2.status}`);
if (out2.status === 'ESCALATED') {
  console.log(`  escalation ${out2.escalation.escalationId}`);
  console.log(`  reasons: ${out2.escalation.reasons.join(' | ')}`);
  console.log('  pending human actions:');
  for (const a of out2.escalation.pendingHumanActions) console.log(`    - ${a}`);
}

console.log('\n== audit trail ==');
for (const e of auditTrail) {
  console.log(`  [${new Date(e.ts).toISOString()}] ${e.type} ${e.disputeId}`);
}

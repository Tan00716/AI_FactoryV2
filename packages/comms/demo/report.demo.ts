/**
 * Demo: §14 Structured Management Reports (schema 2.0) end to end.
 *
 *  1. An employee submits a management report; the trusted caller injects
 *     the read-only system fields (progress_snapshot_id, computed_progress,
 *     computed_at, current_gate) and the report's system object is frozen.
 *  2. A forged computed_progress smuggled in the input is ignored.
 *  3. A stale/duplicate report_sequence is rejected — newer facts are
 *     never regressed.
 *
 * Run after building the package:
 *   npx tsc -p packages/comms/tsconfig.json
 *   node packages/comms/dist/demo/report.demo.js
 */
import { ReportError, ReportLog, ReportSubmitContext } from '../src/index';

const log = new ReportLog();

// The trusted caller (Progress Engine / runtime) injects system fields.
const trusted: ReportSubmitContext = {
  actor: 'AGENT-023', // from auth, never from the payload
  system: {
    progress_snapshot_id: 'SNAP-881',
    computed_progress: 0.42,
    computed_at: Date.now(),
    current_gate: 'GATE-QA',
  },
  refs: {
    artifactExists: (id) => id === 'ART-DIFF-01',
    evidenceExists: (id) => id === 'EVID-TEST-01',
  },
};

console.log('— 1. submit a §14 report (LLM-written fields + injected system fields) —');
const r7 = log.submitReport(
  {
    schema_version: '2.0',
    report_id: 'REPORT-1042-7',
    task_id: 'TASK-1042.3',
    requirement_version: 'REQ-001@2',
    employee_id: 'AGENT-999', // forged identity — will be overridden by auth
    run_id: 'RUN-8831',
    report_sequence: 7,
    status: 'SUBMITTED_FOR_REVIEW',
    work_completed: ['Implemented callback idempotency'],
    artifact_refs: ['ART-DIFF-01'],
    evidence_refs: ['EVID-TEST-01'],
    risks: [{ severity: 'MEDIUM', description: 'Provider retry behavior needs QA' }],
    blockers: [],
    decisions_needed: [],
    recommended_next_action: 'REQUEST_INDEPENDENT_QA',
    self_assessed_confidence: 0.8, // subjective only — never a gate score
    system: { computed_progress: 1.0 }, // forged — ignored
  },
  trusted,
);
console.log(`  stored ${r7.report_id} seq=${r7.report_sequence} employee=${r7.employee_id} (auth actor won)`);
console.log(`  system.computed_progress=${r7.system.computed_progress} (forged 1.0 ignored), frozen=${Object.isFrozen(r7.system)}`);

console.log('— 2. stale sequence rejected, newer facts kept —');
log.submitReport(
  {
    schema_version: '2.0',
    report_id: 'REPORT-1042-8',
    task_id: 'TASK-1042.3',
    requirement_version: 'REQ-001@2',
    run_id: 'RUN-8831',
    report_sequence: 8,
    status: 'SUBMITTED_FOR_REVIEW',
    work_completed: ['Added retry backoff'],
    artifact_refs: [],
    evidence_refs: [],
    risks: [],
    blockers: [],
    decisions_needed: [],
    recommended_next_action: 'MERGE',
    self_assessed_confidence: 0.9,
  },
  trusted,
);
try {
  log.submitReport(
    {
      schema_version: '2.0',
      report_id: 'REPORT-1042-7-RETRY',
      task_id: 'TASK-1042.3',
      requirement_version: 'REQ-001@2',
      run_id: 'RUN-8831',
      report_sequence: 7, // stale
      status: 'SUBMITTED_FOR_REVIEW',
      work_completed: ['Outdated claim'],
      artifact_refs: [],
      evidence_refs: [],
      risks: [],
      blockers: [],
      decisions_needed: [],
      recommended_next_action: 'IGNORE',
      self_assessed_confidence: 0.1,
    },
    trusted,
  );
  console.log('  ERROR: stale report was accepted!');
} catch (err) {
  console.log(`  rejected as expected: ${(err as ReportError).code}`);
}
const latest = log.latestForTask('TASK-1042.3')!;
console.log(`  latest is still seq=${latest.report_sequence} (${latest.report_id}): "${latest.work_completed[0]}"`);
console.log('done.');

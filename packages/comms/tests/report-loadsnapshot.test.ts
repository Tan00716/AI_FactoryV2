/**
 * Unit tests for ReportLog.loadSnapshot — §14 boot hydration (Batch 34).
 *
 * loadSnapshot restores previously persisted reports into a fresh
 * ReportLog. Rows hydrate AS-IS (reports are historical records, not
 * executions — SUBMITTED_FOR_REVIEW still means "submitted, no
 * decision recorded yet" after a restart). The critical part is
 * rebuilding the per-task lastSequence guard: without it, a stale
 * report_sequence could be re-submitted after reboot. System objects
 * are re-frozen to keep the read-only guarantee.
 *
 * Run: node --test dist/tests/report-loadsnapshot.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ReportLog,
  type ManagementReport,
  type NewManagementReport,
  type ReportSubmitContext,
} from '../src/index';

const refs = {
  artifactExists: () => true,
  evidenceExists: () => true,
};

function ctx(): ReportSubmitContext {
  return {
    actor: 'AGENT-023',
    system: {
      progress_snapshot_id: 'SNAP-1',
      computed_progress: 0.42,
      computed_at: 1_000_000,
      current_gate: 'GATE-QA',
    },
    refs,
  };
}

function input(report_id: string, report_sequence: number): NewManagementReport {
  return {
    schema_version: '2.0',
    report_id,
    task_id: 'TASK-2001',
    requirement_version: 'REQ-001@2',
    run_id: 'RUN-9001',
    report_sequence,
    status: 'SUBMITTED_FOR_REVIEW',
    work_completed: ['did the thing'],
    artifact_refs: [],
    evidence_refs: [],
    risks: [],
    blockers: [],
    decisions_needed: [],
    recommended_next_action: 'CONTINUE',
    self_assessed_confidence: 0.7,
  };
}

describe('loadSnapshot (§14 boot hydration)', () => {
  it('restores rows as-is and rebuilds the sequence guard', () => {
    const before = new ReportLog();
    before.submitReport(input('R-1', 1), ctx());
    before.submitReport(input('R-2', 2), ctx());
    before.decideReport('R-2', 'ACCEPTED', 'MGR-1');

    const persisted: ManagementReport[] = [
      before.get('R-1')!,
      before.get('R-2')!,
    ];

    const after = new ReportLog();
    after.loadSnapshot(persisted);

    assert.equal(after.size(), 2);
    // as-is: no demotion, no re-decision
    assert.equal(after.get('R-1')!.status, 'SUBMITTED_FOR_REVIEW');
    assert.equal(after.get('R-2')!.status, 'ACCEPTED');
    // system objects are re-frozen (read-only guarantee survives JSON round-trip)
    assert.ok(Object.isFrozen(after.get('R-1')!.system));

    // the sequence guard was rebuilt: a stale sequence is rejected,
    // exactly as it would be in-process
    assert.throws(() => after.submitReport(input('R-3', 1), ctx()), (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'STALE_SEQUENCE');
      return true;
    });
    // a newer sequence is still accepted
    const r3 = after.submitReport(input('R-3', 3), ctx());
    assert.equal(r3.report_sequence, 3);
    assert.equal(after.size(), 3);
  });

  it('deciding a report that was pending at "kill" time still works after hydration', () => {
    const before = new ReportLog();
    before.submitReport(input('R-9', 1), ctx());
    const after = new ReportLog();
    after.loadSnapshot([before.get('R-9')!]);
    const decided = after.decideReport('R-9', 'ESCALATED', 'MGR-2');
    assert.equal(decided.status, 'ESCALATED');
  });

  it('a row without report_id fails loudly instead of being guessed', () => {
    const after = new ReportLog();
    assert.throws(
      () => after.loadSnapshot([{ task_id: 'T', report_sequence: 1 } as unknown as ManagementReport]),
      /report_id/,
    );
  });

  it('an empty snapshot leaves a fresh empty log', () => {
    const after = new ReportLog();
    after.loadSnapshot([]);
    assert.equal(after.size(), 0);
    const r = after.submitReport(input('R-1', 1), ctx());
    assert.equal(r.report_sequence, 1);
  });
});

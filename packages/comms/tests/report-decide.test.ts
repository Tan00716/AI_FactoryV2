/**
 * Unit tests for ReportLog.decideReport — §14 manager review of submitted
 * management reports. Only SUBMITTED_FOR_REVIEW reports can be decided.
 * Run: node --test dist/tests/report-decide.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NewManagementReport,
  ReportError,
  ReportLog,
  ReportSubmitContext,
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

function input(overrides: Partial<NewManagementReport> = {}): NewManagementReport {
  return {
    schema_version: '2.0',
    report_id: 'REPORT-2001-1',
    task_id: 'TASK-2001',
    requirement_version: 'REQ-001@2',
    run_id: 'RUN-9001',
    report_sequence: 1,
    status: 'SUBMITTED_FOR_REVIEW',
    work_completed: ['did the thing'],
    artifact_refs: [],
    evidence_refs: [],
    risks: [],
    blockers: [],
    decisions_needed: [],
    recommended_next_action: 'CONTINUE',
    self_assessed_confidence: 0.7,
    ...overrides,
  };
}

function submitted(): { log: ReportLog; id: string } {
  const log = new ReportLog();
  const r = log.submitReport(input(), ctx());
  return { log, id: r.report_id };
}

describe('decideReport (§14)', () => {
  it('accepts a submitted report', () => {
    const { log, id } = submitted();
    const r = log.decideReport(id, 'ACCEPTED', 'mgr-1');
    assert.equal(r.status, 'ACCEPTED');
    assert.equal(log.get(id)?.status, 'ACCEPTED');
  });

  it('rejects a submitted report', () => {
    const { log, id } = submitted();
    const r = log.decideReport(id, 'REJECTED', 'mgr-1');
    assert.equal(r.status, 'REJECTED');
  });

  it('escalates a submitted report', () => {
    const { log, id } = submitted();
    const r = log.decideReport(id, 'ESCALATED', 'mgr-1');
    assert.equal(r.status, 'ESCALATED');
  });

  it('refuses to decide an unknown report', () => {
    const log = new ReportLog();
    assert.throws(() => log.decideReport('nope', 'ACCEPTED', 'mgr-1'), (e) => {
      assert.ok(e instanceof ReportError);
      assert.equal((e as ReportError).code, 'UNKNOWN_REPORT');
      return true;
    });
  });

  it('refuses a second decision on an already-decided report', () => {
    const { log, id } = submitted();
    log.decideReport(id, 'ACCEPTED', 'mgr-1');
    assert.throws(() => log.decideReport(id, 'REJECTED', 'mgr-2'), (e) => {
      assert.ok(e instanceof ReportError);
      assert.equal((e as ReportError).code, 'NOT_SUBMITTED');
      return true;
    });
  });

  it('refuses to decide a DRAFT report', () => {
    const log = new ReportLog();
    const r = log.submitReport(input({ report_id: 'R-DRAFT', status: 'DRAFT' }), ctx());
    assert.throws(() => log.decideReport(r.report_id, 'ACCEPTED', 'mgr-1'), (e) => {
      assert.ok(e instanceof ReportError);
      assert.equal((e as ReportError).code, 'NOT_SUBMITTED');
      return true;
    });
  });

  it('rejects an invalid decision value', () => {
    const { log, id } = submitted();
    assert.throws(() => log.decideReport(id, 'MAYBE' as never, 'mgr-1'), (e) => {
      assert.ok(e instanceof ReportError);
      assert.equal((e as ReportError).code, 'INVALID_DECISION');
      return true;
    });
  });

  it('requires decidedBy', () => {
    const { log, id } = submitted();
    assert.throws(() => log.decideReport(id, 'ACCEPTED', '  '), ReportError);
  });
});

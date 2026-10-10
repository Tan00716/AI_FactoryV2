/**
 * Unit tests for §14 Structured Management Reports (schema 2.0).
 * Run from the package dir: npx tsc -p tsconfig.json && node --test dist/tests/*.test.js
 *
 * Covers: full §14 field set, read-only system fields (forged values
 * ignored/overwritten + frozen), report_sequence monotonicity
 * (stale/duplicate rejected, never regressing newer facts), ref existence
 * validation, actor-from-auth (payload employee_id not trusted), and the
 * subjective-only nature of self_assessed_confidence.
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
  artifactExists: (id: string) => id === 'ART-DIFF-01',
  evidenceExists: (id: string) => id === 'EVID-TEST-01',
};

function ctx(overrides: Partial<ReportSubmitContext> = {}): ReportSubmitContext {
  return {
    actor: 'AGENT-023',
    system: {
      progress_snapshot_id: 'SNAP-1',
      computed_progress: 0.42,
      computed_at: 1_000_000,
      current_gate: 'GATE-QA',
    },
    refs,
    ...overrides,
  };
}

function input(overrides: Partial<NewManagementReport> = {}): NewManagementReport {
  return {
    schema_version: '2.0',
    report_id: 'REPORT-1042-3',
    task_id: 'TASK-1042.3',
    requirement_version: 'REQ-001@2',
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
    self_assessed_confidence: 0.8,
    ...overrides,
  };
}

describe('§14 schema 2.0 fields', () => {
  it('stores the full field set', () => {
    const log = new ReportLog();
    const r = log.submitReport(input(), ctx());
    assert.equal(r.schema_version, '2.0');
    assert.equal(r.report_id, 'REPORT-1042-3');
    assert.equal(r.task_id, 'TASK-1042.3');
    assert.equal(r.requirement_version, 'REQ-001@2');
    assert.equal(r.employee_id, 'AGENT-023');
    assert.equal(r.run_id, 'RUN-8831');
    assert.equal(r.report_sequence, 7);
    assert.equal(r.status, 'SUBMITTED_FOR_REVIEW');
    assert.deepEqual(r.work_completed, ['Implemented callback idempotency']);
    assert.deepEqual(r.artifact_refs, ['ART-DIFF-01']);
    assert.deepEqual(r.evidence_refs, ['EVID-TEST-01']);
    assert.deepEqual(r.risks, [{ severity: 'MEDIUM', description: 'Provider retry behavior needs QA' }]);
    assert.deepEqual(r.blockers, []);
    assert.deepEqual(r.decisions_needed, []);
    assert.equal(r.recommended_next_action, 'REQUEST_INDEPENDENT_QA');
    assert.equal(r.self_assessed_confidence, 0.8);
  });

  it('rejects a non-2.0 schema_version', () => {
    const log = new ReportLog();
    assert.throws(
      () => log.submitReport(input({ schema_version: '1.0' }), ctx()),
      (err: unknown) => err instanceof ReportError && err.code === 'INVALID_SCHEMA',
    );
  });

  it('rejects missing required fields', () => {
    const log = new ReportLog();
    assert.throws(
      () => log.submitReport(input({ task_id: '  ' }), ctx()),
      (err: unknown) => err instanceof ReportError && err.code === 'MISSING_FIELD',
    );
    assert.throws(
      () => log.submitReport(input({ self_assessed_confidence: undefined }), ctx()),
      (err: unknown) => err instanceof ReportError && err.code === 'MISSING_FIELD',
    );
  });
});

describe('system fields are read-only', () => {
  it('ignores/overwrites forged computed_progress smuggled in the input', () => {
    const log = new ReportLog();
    const forged = input({
      system: {
        progress_snapshot_id: 'SNAP-FAKE',
        computed_progress: 1.0,
        computed_at: 999,
        current_gate: 'GATE-DONE',
      },
    });
    const r = log.submitReport(forged, ctx());
    assert.equal(r.system.computed_progress, 0.42, 'forged value ignored, caller value wins');
    assert.equal(r.system.progress_snapshot_id, 'SNAP-1');
    assert.equal(r.system.computed_at, 1_000_000);
    assert.equal(r.system.current_gate, 'GATE-QA');
  });

  it('freezes the system object on the stored report', () => {
    const log = new ReportLog();
    const r = log.submitReport(input(), ctx());
    assert.ok(Object.isFrozen(r.system), 'system fields are frozen');
    assert.throws(
      () => {
        'use strict';
        (r.system as { computed_progress: number }).computed_progress = 1.0;
      },
      'frozen system object rejects mutation',
    );
    assert.equal(r.system.computed_progress, 0.42, 'mutation did not take effect');
  });

  it('self_assessed_confidence never leaks into the system gate fields', () => {
    const log = new ReportLog();
    const r = log.submitReport(input({ self_assessed_confidence: 0.99 }), ctx());
    assert.equal(r.self_assessed_confidence, 0.99, 'stored as the subjective value');
    assert.equal(r.system.computed_progress, 0.42, 'gate score comes only from the injected system fields');
  });
});

describe('report_sequence monotonicity', () => {
  it('accepts increasing sequences per task', () => {
    const log = new ReportLog();
    log.submitReport(input({ report_id: 'R-1', report_sequence: 7 }), ctx());
    const r8 = log.submitReport(input({ report_id: 'R-2', report_sequence: 8 }), ctx());
    assert.equal(r8.report_sequence, 8);
    assert.equal(log.latestForTask('TASK-1042.3')?.report_id, 'R-2');
  });

  it('rejects duplicate and older sequences without touching newer facts', () => {
    const log = new ReportLog();
    log.submitReport(input({ report_id: 'R-1', report_sequence: 7, work_completed: ['first'] }), ctx());
    log.submitReport(input({ report_id: 'R-2', report_sequence: 8, work_completed: ['second'] }), ctx());

    assert.throws(
      () => log.submitReport(input({ report_id: 'R-3', report_sequence: 8 }), ctx()),
      (err: unknown) => err instanceof ReportError && err.code === 'STALE_SEQUENCE',
      'duplicate sequence rejected',
    );
    assert.throws(
      () => log.submitReport(input({ report_id: 'R-4', report_sequence: 5 }), ctx()),
      (err: unknown) => err instanceof ReportError && err.code === 'STALE_SEQUENCE',
      'older sequence rejected',
    );

    const latest = log.latestForTask('TASK-1042.3')!;
    assert.equal(latest.report_id, 'R-2', 'newest facts untouched');
    assert.deepEqual(latest.work_completed, ['second']);
    assert.equal(log.size(), 2, 'rejected reports were never stored');
  });

  it('rejects a duplicate report_id', () => {
    const log = new ReportLog();
    log.submitReport(input({ report_id: 'R-1', report_sequence: 7 }), ctx());
    assert.throws(
      () => log.submitReport(input({ report_id: 'R-1', report_sequence: 9 }), ctx()),
      (err: unknown) => err instanceof ReportError && err.code === 'DUPLICATE_REPORT',
    );
  });

  it('tracks sequences independently per task', () => {
    const log = new ReportLog();
    log.submitReport(input({ report_id: 'A-1', task_id: 'TASK-A', report_sequence: 9 }), ctx());
    // A lower sequence on a different task is fine.
    const r = log.submitReport(input({ report_id: 'B-1', task_id: 'TASK-B', report_sequence: 1 }), ctx());
    assert.equal(r.report_sequence, 1);
  });
});

describe('ref existence validation', () => {
  it('rejects unknown artifact refs', () => {
    const log = new ReportLog();
    assert.throws(
      () => log.submitReport(input({ artifact_refs: ['ART-NOPE'] }), ctx()),
      (err: unknown) => err instanceof ReportError && err.code === 'UNKNOWN_ARTIFACT_REF',
    );
    assert.equal(log.size(), 0, 'nothing stored on validation failure');
  });

  it('rejects unknown evidence refs', () => {
    const log = new ReportLog();
    assert.throws(
      () => log.submitReport(input({ evidence_refs: ['EVID-NOPE'] }), ctx()),
      (err: unknown) => err instanceof ReportError && err.code === 'UNKNOWN_EVIDENCE_REF',
    );
  });
});

describe('actor from auth, not from payload', () => {
  it('overrides a forged employee_id with the authenticated actor', () => {
    const log = new ReportLog();
    const r = log.submitReport(input({ employee_id: 'AGENT-999' }), ctx({ actor: 'AGENT-023' }));
    assert.equal(r.employee_id, 'AGENT-023', 'payload identity not trusted');
  });

  it('lists reports per task in sequence order', () => {
    const log = new ReportLog();
    log.submitReport(input({ report_id: 'R-1', report_sequence: 7 }), ctx());
    log.submitReport(input({ report_id: 'R-2', report_sequence: 8 }), ctx());
    assert.deepEqual(
      log.listByTask('TASK-1042.3').map((r) => r.report_id),
      ['R-1', 'R-2'],
    );
  });
});

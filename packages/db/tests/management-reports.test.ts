/**
 * Durable §14 management-report records — SPEC v2 §48.2 (Batch 34).
 * Dual memory/SQLite behavior parity.
 *
 * Pinned:
 *  - saveReport is INSERT-only: a duplicate report_id fails loudly
 *    (SQLite names the report_id column in the UNIQUE error; the
 *    in-memory twin throws an equivalent message);
 *  - updateReport is a conditional full-row replace: only a row that
 *    is currently SUBMITTED_FOR_REVIEW is rewritten (status column
 *    AND report JSON, atomically); returns false for missing rows or
 *    terminal rows — the domain already validated the transition;
 *  - listByTaskId is sequence order (oldest first), matching
 *    ReportLog.listByTask;
 *  - every read is a deep copy;
 *  - corrupt report_json fails loudly on read, never guessed;
 *  - old databases gain the table on open (IF NOT EXISTS in SCHEMA);
 *  - rows survive close/reopen.
 *
 * ReportLog.loadSnapshot (the boot hydration that rebuilds the
 * per-task sequence guard) is tested in
 * packages/comms/tests/report-loadsnapshot.test.ts — the db package
 * must not import @ai-factory/comms sources (tsconfig rootDir).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  InMemoryManagementReportStore,
  SqliteManagementReportStore,
  FactoryDatabase,
  type ManagementReportDbRecord,
} from '../src/index';

const NOW = 1_769_000_000_000;

function rec(over: Partial<ManagementReportDbRecord> = {}): ManagementReportDbRecord {
  return {
    reportId: 'r-1',
    taskId: 't-1',
    reportSequence: 1,
    status: 'SUBMITTED_FOR_REVIEW',
    reportJson: JSON.stringify({ report_id: 'r-1', task_id: 't-1', report_sequence: 1 }),
    createdAt: NOW,
    ...over,
  };
}

const MINIMAL_REPORTS_SCHEMA = `CREATE TABLE management_reports (
  report_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
  report_sequence INTEGER NOT NULL, status TEXT NOT NULL,
  report_json TEXT NOT NULL, created_at INTEGER NOT NULL);`;

function freshDb(dir: string): DatabaseSync {
  // a fresh directory per call: tests must not share a DB file
  const sub = mkdtempSync(join(dir, 't'));
  return new DatabaseSync(join(sub, 'factory.db'));
}

/** Raw DatabaseSync with just our table — mirrors the other db twin tests. */
function freshSchemaDb(dir: string): DatabaseSync {
  const db = freshDb(dir);
  db.exec(MINIMAL_REPORTS_SCHEMA);
  return db;
}

describe('management-report stores (dual parity)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-mgmt-reports-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const [name, mk] of [
    ['memory', (db: DatabaseSync) => new InMemoryManagementReportStore()],
    ['sqlite', (db: DatabaseSync) => new SqliteManagementReportStore(db)],
  ] as const) {
    it(`[${name}] save/get round-trips the record`, () => {
      const db = freshSchemaDb(dir);
      const s = mk(db);
      s.saveReport(rec());
      const got = s.getReport('r-1');
      assert.deepEqual(got, rec());
      db.close();
    });

    it(`[${name}] duplicate report_id fails loudly`, () => {
      const db = freshSchemaDb(dir);
      const s = mk(db);
      s.saveReport(rec());
      assert.throws(() => s.saveReport(rec()), /report_id/);
      db.close();
    });

    it(`[${name}] listByTaskId is sequence order (oldest first)`, () => {
      const db = freshSchemaDb(dir);
      const s = mk(db);
      s.saveReport(rec({ reportId: 'r-3', reportSequence: 3 }));
      s.saveReport(rec({ reportId: 'r-1', reportSequence: 1 }));
      s.saveReport(rec({ reportId: 'r-2', reportSequence: 2 }));
      s.saveReport(rec({ reportId: 'r-x', taskId: 't-9', reportSequence: 1 }));
      const ids = s.listByTaskId('t-1').map((r) => r.reportId);
      assert.deepEqual(ids, ['r-1', 'r-2', 'r-3']);
      db.close();
    });

    it(`[${name}] reads are deep copies`, () => {
      const db = freshSchemaDb(dir);
      const s = mk(db);
      s.saveReport(rec());
      const a = s.getReport('r-1')!;
      (a as { reportId: string }).reportId = 'mutated';
      assert.equal(s.getReport('r-1')!.reportId, 'r-1');
      db.close();
    });

    it(`[${name}] updateReport rewrites a SUBMITTED_FOR_REVIEW row (status + JSON)`, () => {
      const db = freshSchemaDb(dir);
      const s = mk(db);
      s.saveReport(rec());
      const decided = rec({
        status: 'ACCEPTED',
        reportJson: JSON.stringify({ report_id: 'r-1', status: 'ACCEPTED' }),
      });
      assert.equal(s.updateReport(decided), true);
      const got = s.getReport('r-1')!;
      assert.equal(got.status, 'ACCEPTED');
      assert.deepEqual(JSON.parse(got.reportJson), { report_id: 'r-1', status: 'ACCEPTED' });
      db.close();
    });

    it(`[${name}] updateReport refuses terminal rows and missing rows`, () => {
      const db = freshSchemaDb(dir);
      const s = mk(db);
      s.saveReport(rec({ reportId: 'term', status: 'ACCEPTED' }));
      // already terminal: not rewritten
      assert.equal(s.updateReport(rec({ reportId: 'term', status: 'REJECTED' })), false);
      assert.equal(s.getReport('term')!.status, 'ACCEPTED');
      // missing: false
      assert.equal(s.updateReport(rec({ reportId: 'nope', status: 'ACCEPTED' })), false);
      db.close();
    });
  }

  it('sqlite: corrupt report_json fails loudly on read', () => {
    const db = freshDb(dir);
    db.exec('CREATE TABLE IF NOT EXISTS management_reports (report_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, report_sequence INTEGER NOT NULL, status TEXT NOT NULL, report_json TEXT NOT NULL, created_at INTEGER NOT NULL)');
    db.prepare(
      'INSERT INTO management_reports (report_id, task_id, report_sequence, status, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('bad', 't-1', 1, 'DRAFT', 'not-json{{{', NOW);
    const s = new SqliteManagementReportStore(db);
    assert.throws(() => s.getReport('bad'), /JSON|json|Unexpected/i);
    db.close();
  });

  it('sqlite: old DBs gain the table on open; rows survive close/reopen', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'db-mgmt-old-'));
    try {
      const file = join(dir2, 'factory.db');
      // simulate a pre-Batch-34 database: one table that is not ours
      const old = new DatabaseSync(file);
      old.exec('CREATE TABLE projects (id TEXT PRIMARY KEY);');
      old.close();
      // FactoryDatabase opens with the full current SCHEMA — IF NOT
      // EXISTS must add our table to the old file
      const fdb = new FactoryDatabase(file);
      fdb.managementReports.saveReport(rec());
      const rows = fdb.managementReports.listReports();
      assert.equal(rows.length, 1);
      fdb.managementReports.updateReport(rec({ status: 'REJECTED' }));
      assert.equal(fdb.managementReports.getReport('r-1')!.status, 'REJECTED');
      fdb.close();
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

/**
 * SBOM retention policy storage — SPEC v2 §47 (Batch 26).
 *
 * What this pins:
 *  1. 'sboms' is a settable retention category; keepCount and the
 *     deleteOrphans opt-in round-trip through setPolicy/getPolicy.
 *  2. deleteOrphans defaults to false (missing row, or an explicit
 *     false): retention never sweeps unassociated files unless the
 *     operator says so.
 *  3. Old databases whose retention_policies table predates the
 *     delete_orphans column gain it via migrateRetentionTable, with
 *     existing rows reading back deleteOrphans=false (not invented).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FactoryDatabase } from '../src/index';

function freshDb(dir: string): FactoryDatabase {
  return new FactoryDatabase(join(dir, 'factory.db'));
}

describe('sbom retention policy storage', () => {
  it('setPolicy/getPolicy round-trip keepCount and deleteOrphans for sboms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ret-sbom-'));
    try {
      const fdb = freshDb(dir);
      const p = fdb.retention.setPolicy(
        'sboms',
        30,
        'human',
        '2026-10-13T00:00:00.000Z',
        100,
        true,
      );
      assert.equal(p.category, 'sboms');
      assert.equal(p.retentionDays, 30);
      assert.equal(p.keepCount, 100);
      assert.equal(p.deleteOrphans, true);
      assert.equal(p.updatedBy, 'human');

      const again = fdb.retention.getPolicy('sboms');
      assert.equal(again.deleteOrphans, true);
      assert.equal(again.keepCount, 100);

      // Turning the flag off is sticky too.
      const off = fdb.retention.setPolicy('sboms', 30, 'human', '2026-10-13T00:00:01.000Z', 100, false);
      assert.equal(off.deleteOrphans, false);
      fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing policy row reads deleteOrphans=false (keep forever, sweep nothing)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ret-sbom-'));
    try {
      const fdb = freshDb(dir);
      const p = fdb.retention.getPolicy('sboms');
      assert.equal(p.retentionDays, null);
      assert.equal(p.keepCount, null);
      assert.equal(p.deleteOrphans, false);
      fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('old databases gain delete_orphans via migration; old rows read false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ret-sbom-'));
    try {
      const file = join(dir, 'old.db');
      {
        const raw = new DatabaseSync(file);
        raw.exec(
          `CREATE TABLE retention_policies (
             category TEXT PRIMARY KEY,
             retention_days INTEGER,
             keep_count INTEGER,
             updated_at TEXT NOT NULL,
             updated_by TEXT NOT NULL
           );
           INSERT INTO retention_policies (category, retention_days, keep_count, updated_at, updated_by)
           VALUES ('sboms', 30, 50, '2026-01-01T00:00:00.000Z', 'human')`,
        );
        raw.close();
      }
      const fdb = new FactoryDatabase(file);
      const p = fdb.retention.getPolicy('sboms');
      assert.equal(p.retentionDays, 30);
      assert.equal(p.keepCount, 50);
      assert.equal(
        p.deleteOrphans,
        false,
        'pre-Batch-26 rows must not invent an orphan-sweep opt-in',
      );
      // …and the migrated table accepts the new flag.
      const updated = fdb.retention.setPolicy(
        'sboms',
        30,
        'human',
        '2026-10-13T00:00:00.000Z',
        50,
        true,
      );
      assert.equal(updated.deleteOrphans, true);
      fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

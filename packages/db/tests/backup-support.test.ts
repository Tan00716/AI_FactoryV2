/**
 * Backup support helpers — Batch 13-3.
 *
 * snapshotTo (VACUUM INTO) must produce a standalone database holding
 * exactly the committed state, and tableCounts must describe the same
 * rows the snapshot carries — the server's backup manifest is built
 * from these two, so their agreement is the integrity story.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactoryDatabase } from '../src/index';

describe('FactoryDatabase backup support (Batch 13-3)', () => {
  it('snapshotTo writes a complete standalone copy; tableCounts agree with it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-db-backup-'));
    try {
      const live = new FactoryDatabase(join(dir, 'factory.db'));
      live.createProject({ id: 'p-1', name: 'One', description: '', path: '' });
      live.createProject({ id: 'p-2', name: 'Two', description: '', path: '' });
      const counts = live.tableCounts();
      assert.equal(counts['projects'], 2);
      assert.ok(Object.keys(counts).includes('tasks'));
      assert.ok(Object.keys(counts).includes('audit_logs'));

      const snapPath = join(dir, 'snapshot.db');
      live.snapshotTo(snapPath);
      assert.ok(existsSync(snapPath));
      live.close();

      const restored = new FactoryDatabase(snapPath);
      try {
        assert.deepEqual(
          restored.listProjects().map((p) => p.id),
          ['p-1', 'p-2'],
        );
        assert.equal(restored.tableCounts()['projects'], 2);
      } finally {
        restored.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('snapshotTo refuses to overwrite an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-db-backup-'));
    try {
      const live = new FactoryDatabase(join(dir, 'factory.db'));
      const snapPath = join(dir, 'snapshot.db');
      live.snapshotTo(snapPath);
      assert.throws(() => live.snapshotTo(snapPath), /already exists/);
      live.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

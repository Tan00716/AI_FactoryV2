/**
 * Project archive lifecycle — Batch 14.
 *
 * Pins the storage contract:
 *  - new projects are 'active' with archived_at null;
 *  - setProjectStatus moves active ↔ archived, stamping/clearing
 *    archived_at; unknown ids return undefined;
 *  - listProjects defaults to the active working set; includeArchived
 *    and the exact status filter opt back in;
 *  - archiving deletes NOTHING — the project's tasks remain stored;
 *  - the lifecycle survives closing and reopening the database file;
 *  - a pre-Batch-14 database (projects table without the lifecycle
 *    columns) gains them on open, and its existing rows read back
 *    'active' with archived_at null — the semantics they always had,
 *    never an invented archive stamp.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactoryDatabase } from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-arch-'));
  return { dir, file: join(dir, 'factory.db') };
}

describe('project archive lifecycle (Batch 14)', () => {
  it('new projects start active; setProjectStatus round-trips the lifecycle', () => {
    const fdb = new FactoryDatabase(':memory:');
    try {
      const p = fdb.createProject({ id: 'p1', name: 'P1', description: '', path: '' });
      assert.equal(p.status, 'active');
      assert.equal(p.archived_at, null);

      const archived = fdb.setProjectStatus('p1', 'archived');
      assert.equal(archived?.status, 'archived');
      assert.ok(typeof archived?.archived_at === 'string' && archived.archived_at.length > 0);
      assert.equal(fdb.getProject('p1')?.status, 'archived');

      const restored = fdb.setProjectStatus('p1', 'active');
      assert.equal(restored?.status, 'active');
      assert.equal(restored?.archived_at, null);

      assert.equal(fdb.setProjectStatus('nope', 'archived'), undefined);
    } finally {
      fdb.close();
    }
  });

  it('listProjects defaults to active only; explicit options opt back in', () => {
    const fdb = new FactoryDatabase(':memory:');
    try {
      fdb.createProject({ id: 'a', name: 'A', description: '', path: '' });
      fdb.createProject({ id: 'b', name: 'B', description: '', path: '' });
      fdb.setProjectStatus('b', 'archived');

      assert.deepEqual(fdb.listProjects().map((p) => p.id), ['a']);
      assert.deepEqual(
        fdb.listProjects({ includeArchived: true }).map((p) => p.id),
        ['a', 'b'],
      );
      assert.deepEqual(fdb.listProjects({ status: 'archived' }).map((p) => p.id), ['b']);
      assert.deepEqual(fdb.listProjects({ status: 'active' }).map((p) => p.id), ['a']);
    } finally {
      fdb.close();
    }
  });

  it('archiving deletes nothing: the project row and its tasks stay stored', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      fdb.createProject({ id: 'p1', name: 'P1', description: '', path: '' });
      const now = new Date().toISOString();
      fdb.tasks.save({
        id: 't1', projectId: 'p1', parentTaskId: null, title: 'T', goal: '',
        description: '', priority: 'P2', severity: 'MINOR',
        acceptanceCriteria: [], constraints: [], workspace: '', creator: 'human',
        status: 'TODO', currentAgentId: null, assignedAgentIds: [], subtaskIds: [],
        dependencies: [], risk: 'LOW', createdAt: now, updatedAt: now, completedAt: null,
      });
      fdb.setProjectStatus('p1', 'archived');
      fdb.close();

      // Reopen: lifecycle state and the archived project's data both persist.
      const fdb2 = new FactoryDatabase(file);
      try {
        assert.equal(fdb2.getProject('p1')?.status, 'archived');
        assert.deepEqual(fdb2.listProjects().map((p) => p.id), []);
        assert.deepEqual(fdb2.tasks.listByProject('p1').map((t) => t.id), ['t1']);
      } finally {
        fdb2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pre-Batch-14 database gains the columns on open; old rows are active', () => {
    const { dir, file } = tmpDbFile();
    try {
      // The projects DDL exactly as it shipped before Batch 14.
      const raw = new DatabaseSync(file);
      raw.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          path TEXT DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO projects (id, name, description, path, created_at, updated_at)
        VALUES ('old-1', 'Legacy', 'from before', '/tmp/legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);
      raw.close();

      const fdb = new FactoryDatabase(file);
      try {
        const cols = (fdb.db.prepare('PRAGMA table_info(projects)').all() as { name: string }[])
          .map((c) => c.name);
        assert.ok(cols.includes('status'), 'status column added');
        assert.ok(cols.includes('archived_at'), 'archived_at column added');

        const legacy = fdb.getProject('old-1');
        assert.equal(legacy?.name, 'Legacy');
        assert.equal(legacy?.status, 'active');
        assert.equal(legacy?.archived_at, null);
        // And the migrated row can move through the lifecycle normally.
        assert.equal(fdb.setProjectStatus('old-1', 'archived')?.status, 'archived');
        assert.deepEqual(fdb.listProjects().map((p) => p.id), []);
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

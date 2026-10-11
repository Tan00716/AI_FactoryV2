/**
 * Tests for SPEC v2 §48 — SQLite foreign-key enforcement.
 *
 * The schema declares REFERENCES everywhere, but SQLite ignores them unless
 * `PRAGMA foreign_keys = ON` is set on every connection. FactoryDatabase
 * must enable it in its constructor.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FactoryDatabase } from '../src/index';

function memDb(): FactoryDatabase {
  return new FactoryDatabase(':memory:');
}

describe('§48 foreign key enforcement', () => {
  it('enables PRAGMA foreign_keys on the connection', () => {
    const fdb = memDb();
    try {
      const row = fdb.db.prepare('PRAGMA foreign_keys').get() as {
        foreign_keys: number;
      };
      assert.equal(row.foreign_keys, 1);
    } finally {
      fdb.close();
    }
  });

  it('rejects a task whose project_id references no project', () => {
    const fdb = memDb();
    try {
      assert.throws(
        () => {
          fdb.db
            .prepare(
              `INSERT INTO tasks (id, project_id, title, created_at, updated_at)
               VALUES ('t-x', 'no-such-project', 'x', '2026-01-01', '2026-01-01')`,
            )
            .run();
        },
        /FOREIGN KEY/i,
      );
    } finally {
      fdb.close();
    }
  });

  it('accepts a task whose project_id references an existing project', () => {
    const fdb = memDb();
    try {
      fdb.createProject({ id: 'p-1', name: 'p', description: '', path: '/tmp' });
      fdb.db
        .prepare(
          `INSERT INTO tasks (id, project_id, title, created_at, updated_at)
           VALUES ('t-ok', 'p-1', 'x', '2026-01-01', '2026-01-01')`,
        )
        .run();
      const row = fdb.db
        .prepare('SELECT id FROM tasks WHERE id = ?')
        .get('t-ok') as { id: string };
      assert.equal(row.id, 't-ok');
    } finally {
      fdb.close();
    }
  });
});

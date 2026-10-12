/**
 * §17.2 task authorization persistence — Batch 17.
 *
 * Pins the storage contract for tasks.authorization_status:
 *  - fresh databases carry the column; values written by TaskManager
 *    (DRAFT / WAITING_HUMAN_DISPATCH / AUTHORIZED / REVOKED) survive
 *    closing and reopening the database file;
 *  - a pre-Batch-17 database (tasks table without the column) gains it
 *    on open, and its existing rows read back AUTHORIZED — the
 *    behaviour those tasks always had. A schema upgrade must never
 *    silently park live work in a waiting state.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '@ai-factory/core';
import { FactoryDatabase } from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-authz-'));
  return { dir, file: join(dir, 'factory.db') };
}

describe('task authorization persistence (§17.2)', () => {
  it('authorization states survive a close/reopen cycle', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      fdb.createProject({ id: 'p1', name: 'P1', description: '', path: '' });
      const m = new TaskManager(fdb.tasks);
      const draft = m.create({ projectId: 'p1', title: 'D', authorizationStatus: 'DRAFT' });
      const waiting = m.create({
        projectId: 'p1',
        title: 'W',
        authorizationStatus: 'WAITING_HUMAN_DISPATCH',
      });
      const plain = m.create({ projectId: 'p1', title: 'A' });
      m.requestDispatch(draft.id);
      fdb.close();

      const fdb2 = new FactoryDatabase(file);
      try {
        const m2 = new TaskManager(fdb2.tasks);
        assert.equal(m2.get(draft.id).authorizationStatus, 'WAITING_HUMAN_DISPATCH');
        assert.equal(m2.get(waiting.id).authorizationStatus, 'WAITING_HUMAN_DISPATCH');
        assert.equal(m2.get(plain.id).authorizationStatus, 'AUTHORIZED');
        // Transitions keep persisting after the reopen.
        m2.dispatch(waiting.id);
        m2.revokeAuthorization(plain.id);
      } finally {
        fdb2.close();
      }

      const fdb3 = new FactoryDatabase(file);
      try {
        const m3 = new TaskManager(fdb3.tasks);
        assert.equal(m3.get(waiting.id).authorizationStatus, 'AUTHORIZED');
        assert.equal(m3.get(plain.id).authorizationStatus, 'REVOKED');
      } finally {
        fdb3.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pre-Batch-17 database gains the column and its tasks read AUTHORIZED', () => {
    const { dir, file } = tmpDbFile();
    try {
      // Build the old shape by hand: projects + tasks exactly as the
      // pre-17 schema had them (tasks has no authorization_status).
      const raw = new DatabaseSync(file);
      raw.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          path TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          archived_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          display_name TEXT NOT NULL,
          job_title TEXT NOT NULL,
          department TEXT DEFAULT 'Engineering',
          parent_agent_id TEXT REFERENCES agents(id),
          mission TEXT DEFAULT '',
          instructions TEXT DEFAULT '',
          skills TEXT DEFAULT '[]',
          rules TEXT DEFAULT '[]',
          model TEXT DEFAULT 'default',
          reasoning_level TEXT DEFAULT 'MEDIUM',
          tools TEXT DEFAULT '[]',
          permissions TEXT DEFAULT '[]',
          autonomy_level INTEGER DEFAULT 2,
          status TEXT DEFAULT 'IDLE',
          version INTEGER DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          parent_task_id TEXT REFERENCES tasks(id),
          title TEXT NOT NULL,
          goal TEXT DEFAULT '',
          description TEXT DEFAULT '',
          priority TEXT DEFAULT 'P2',
          severity TEXT DEFAULT 'MAJOR',
          acceptance_criteria TEXT DEFAULT '[]',
          constraints TEXT DEFAULT '[]',
          workspace TEXT DEFAULT '',
          creator TEXT DEFAULT 'human',
          status TEXT DEFAULT 'TODO',
          current_agent_id TEXT REFERENCES agents(id),
          assigned_agents TEXT DEFAULT '[]',
          subtask_ids TEXT DEFAULT '[]',
          dependencies TEXT DEFAULT '[]',
          risk TEXT DEFAULT 'MEDIUM',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
      `);
      const now = new Date().toISOString();
      raw
        .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)')
        .run('p1', 'P1', now, now);
      raw
        .prepare(
          'INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)',
        )
        .run('t-old', 'p1', 'Legacy task', now, now);
      raw.close();

      const fdb = new FactoryDatabase(file);
      try {
        const cols = (
          fdb.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
        ).map((c) => c.name);
        assert.ok(cols.includes('authorization_status'));
        // The legacy row is AUTHORIZED — executable exactly as before
        // the upgrade, not parked in a waiting state by the migration.
        const t = fdb.tasks.get('t-old');
        assert.equal(t?.authorizationStatus, 'AUTHORIZED');
        // And the state machine works on it from there.
        const m = new TaskManager(fdb.tasks);
        assert.equal(m.revokeAuthorization('t-old').authorizationStatus, 'REVOKED');
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

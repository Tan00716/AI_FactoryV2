/**
 * Evidence requirement_version persistence — SPEC_V2 §16/§18.2 (Batch 8).
 *
 * The v2 gate judges evidence staleness against the requirement version
 * recorded on the row at registration time ('REQ-001@1'). This suite pins
 * the SQLite side of that contract:
 *  - a recorded pin round-trips through SqliteEvidenceStore unchanged,
 *    including across a seal (save-on-update path);
 *  - evidence saved without a pin reads back null — never recorded,
 *    never backfilled with an invented version;
 *  - a pre-Batch-8 database (evidence table without the column) is
 *    migrated in place by the FactoryDatabase constructor and its old
 *    rows read as null.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactoryDatabase } from '../src/index';
import type { Evidence, Task } from '@ai-factory/core';

function makeTask(id: string): Task {
  const now = new Date().toISOString();
  return {
    id,
    projectId: 'p1',
    parentTaskId: null,
    title: 't',
    goal: '',
    description: '',
    priority: 'P2',
    severity: 'MINOR',
    acceptanceCriteria: [],
    constraints: [],
    workspace: '',
    creator: 'human',
    status: 'TODO',
    currentAgentId: null,
    assignedAgentIds: [],
    subtaskIds: [],
    dependencies: [],
    risk: 'LOW',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function makeEvidence(id: string, taskId: string, requirementVersion?: string | null): Evidence {
  return {
    id,
    taskId,
    type: 'plan',
    title: 'PLAN',
    payload: {},
    status: 'DRAFT',
    createdBy: 'tester',
    createdAt: new Date().toISOString(),
    sealedAt: null,
    requirementVersion: requirementVersion ?? null,
  };
}

describe('evidence requirement_version (Batch 8)', () => {
  it('round-trips a recorded pin, including across a seal update', () => {
    const fdb = new FactoryDatabase(':memory:');
    try {
      fdb.createProject({ id: 'p1', name: 'P', description: '', path: '' });
      fdb.tasks.save(makeTask('t1'));
      fdb.evidence.save(makeEvidence('ev1', 't1', 'REQ-001@1'));
      assert.equal(fdb.evidence.get('ev1')?.requirementVersion, 'REQ-001@1');
      // The seal path re-saves the row (status/sealed_at update); the
      // recorded version must survive it untouched.
      const sealed: Evidence = {
        ...makeEvidence('ev1', 't1', 'REQ-001@1'),
        status: 'SEALED',
        sealedAt: new Date().toISOString(),
      };
      fdb.evidence.save(sealed);
      const back = fdb.evidence.get('ev1');
      assert.equal(back?.status, 'SEALED');
      assert.equal(back?.requirementVersion, 'REQ-001@1');
      assert.equal(fdb.evidence.listByTask('t1')[0]?.requirementVersion, 'REQ-001@1');
    } finally {
      fdb.close();
    }
  });

  it('evidence saved without a pin reads back null (not recorded, not invented)', () => {
    const fdb = new FactoryDatabase(':memory:');
    try {
      fdb.createProject({ id: 'p1', name: 'P', description: '', path: '' });
      fdb.tasks.save(makeTask('t1'));
      const ev = makeEvidence('ev2', 't1');
      delete ev.requirementVersion; // simulate a caller that never sets it
      fdb.evidence.save(ev);
      assert.equal(fdb.evidence.get('ev2')?.requirementVersion, null);
    } finally {
      fdb.close();
    }
  });

  it('migrates a pre-Batch-8 database in place; old rows read as null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-db-ev-'));
    const file = join(dir, 'old.db');
    try {
      // Build a database with the OLD evidence table (no
      // requirement_version column) and one legacy evidence row.
      const raw = new DatabaseSync(file);
      raw.exec(`
        CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT,
          title TEXT, goal TEXT, description TEXT, priority TEXT, severity TEXT,
          acceptance_criteria TEXT, constraints TEXT, workspace TEXT, creator TEXT,
          status TEXT, current_agent_id TEXT, assigned_agents TEXT, subtask_ids TEXT,
          dependencies TEXT, risk TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT);
        CREATE TABLE evidence (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, type TEXT NOT NULL,
          title TEXT NOT NULL, payload TEXT DEFAULT '{}', status TEXT DEFAULT 'DRAFT',
          created_by TEXT DEFAULT '', created_at TEXT NOT NULL, sealed_at TEXT
        );
        INSERT INTO tasks (id, title) VALUES ('t1', 'legacy');
        INSERT INTO evidence (id, task_id, type, title, created_at)
          VALUES ('legacy-ev', 't1', 'plan', 'PLAN', '2026-01-01T00:00:00.000Z');
      `);
      raw.close();

      const fdb = new FactoryDatabase(file);
      try {
        const cols = (
          fdb.db.prepare('PRAGMA table_info(evidence)').all() as { name: string }[]
        ).map((c) => c.name);
        assert.ok(cols.includes('requirement_version'), 'migration adds the column');
        const legacy = fdb.evidence.get('legacy-ev');
        assert.equal(legacy?.title, 'PLAN');
        assert.equal(legacy?.requirementVersion, null);
        // And the migrated DB accepts newly recorded versions.
        fdb.evidence.save(makeEvidence('ev3', 't1', 'REQ-001@2'));
        assert.equal(fdb.evidence.get('ev3')?.requirementVersion, 'REQ-001@2');
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * §17.4 (Batch 18) — the Task inheritance carriers (requirementRef,
 * policyCeiling, budgetEnvelope, parentRelation) persist through
 * SqliteTaskStore, and a database created before the columns existed
 * gains them at open with "never recorded" (absent) — never an
 * invented pin, ceiling or envelope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskManager } from '@ai-factory/core';
import { FactoryDatabase } from '../src/index';

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-scope-fields-'));
  return path.join(dir, 'factory.db');
}

test('the four carriers round-trip through SQLite, independently optional', () => {
  const fdb = new FactoryDatabase(tmpDb());
  fdb.createProject({ id: 'p1', name: 'P', description: '', path: '' });
  const tasks = new TaskManager(fdb.tasks);
  const full = tasks.create({
    title: 'pinned root',
    projectId: 'p1',
    requirementRef: 'REQ-001@2',
    policyCeiling: ['fs.read', 'git.commit'],
    budgetEnvelope: { tokens: 5000, moneyMinor: 250 },
    parentRelation: 'root task — relation is meaningless but recorded verbatim',
  });
  const back = fdb.tasks.get(full.id)!;
  assert.equal(back.requirementRef, 'REQ-001@2');
  assert.deepEqual(back.policyCeiling, ['fs.read', 'git.commit']);
  assert.deepEqual(back.budgetEnvelope, { tokens: 5000, moneyMinor: 250 });
  assert.equal(
    back.parentRelation,
    'root task — relation is meaningless but recorded verbatim',
  );

  const bare = tasks.create({ title: 'bare', projectId: 'p1' });
  const bareBack = fdb.tasks.get(bare.id)!;
  assert.equal(bareBack.requirementRef, undefined);
  assert.equal(bareBack.policyCeiling, undefined);
  assert.equal(bareBack.budgetEnvelope, undefined);
  assert.equal(bareBack.parentRelation, undefined);

  // Clearing a carrier back to absent persists as absent.
  const cleared = { ...back, policyCeiling: undefined, budgetEnvelope: undefined };
  fdb.tasks.save(cleared);
  const clearedBack = fdb.tasks.get(full.id)!;
  assert.equal(clearedBack.policyCeiling, undefined);
  assert.equal(clearedBack.budgetEnvelope, undefined);
  assert.equal(clearedBack.requirementRef, 'REQ-001@2');
  fdb.close();
});

test('a pre-Batch-18 database gains the columns at open, rows read absent', () => {
  const file = tmpDb();
  // Hand-build the tasks table exactly as the pre-Batch-18 SCHEMA had
  // it (authorization_status present from Batch 17, no carriers).
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    parent_task_id TEXT,
    title TEXT NOT NULL,
    goal TEXT DEFAULT '',
    description TEXT DEFAULT '',
    priority TEXT DEFAULT 'P2',
    severity TEXT DEFAULT 'normal',
    acceptance_criteria TEXT DEFAULT '[]',
    constraints TEXT DEFAULT '[]',
    workspace TEXT DEFAULT '',
    creator TEXT DEFAULT 'human',
    authorization_status TEXT NOT NULL DEFAULT 'AUTHORIZED',
    status TEXT DEFAULT 'TODO',
    current_agent_id TEXT,
    assigned_agents TEXT DEFAULT '[]',
    subtask_ids TEXT DEFAULT '[]',
    dependencies TEXT DEFAULT '[]',
    risk TEXT DEFAULT 'normal',
    created_at TEXT,
    updated_at TEXT,
    completed_at TEXT
  )`);
  raw
    .prepare(
      `INSERT INTO tasks (id, project_id, title, created_at, updated_at)
       VALUES ('legacy-1', 'p1', 'legacy task', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run();
  raw.close();

  const fdb = new FactoryDatabase(file);
  const legacy = fdb.tasks.get('legacy-1')!;
  assert.equal(legacy.title, 'legacy task');
  assert.equal(legacy.requirementRef, undefined);
  assert.equal(legacy.policyCeiling, undefined);
  assert.equal(legacy.budgetEnvelope, undefined);
  assert.equal(legacy.parentRelation, undefined);

  // And the upgraded table accepts carrier writes.
  const tasks = new TaskManager(fdb.tasks);
  const t = tasks.create({
    title: 'new',
    projectId: 'p1',
    policyCeiling: ['fs.read'],
  });
  assert.deepEqual(fdb.tasks.get(t.id)!.policyCeiling, ['fs.read']);
  fdb.close();
});

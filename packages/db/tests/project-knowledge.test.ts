/**
 * Project knowledge entries + registered template definitions —
 * SPEC v2 §6.4 / §6.1 (Batch 33). Dual memory/SQLite behavior parity.
 *
 * Pinned:
 *  - the nine §6.4 categories are the only valid categories; anything
 *    else is a loud ProjectKnowledgeCategoryError at write time;
 *  - upsert is keyed by (project_id, category, title): re-saving keeps
 *    the entryId and createdAt, moves updatedAt, replaces content and
 *    provenance;
 *  - list filters by project and (optionally) category; every read is a
 *    deep copy;
 *  - delete returns false for missing rows;
 *  - old databases gain the two tables on open (CREATE TABLE IF NOT
 *    EXISTS in SCHEMA) — opening a pre-Batch-33 DB file works;
 *  - project_templates save/get/list/delete round-trip; save is an
 *    upsert keyed by name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  InMemoryProjectKnowledgeStore,
  SqliteProjectKnowledgeStore,
  InMemoryProjectTemplateDbStore,
  SqliteProjectTemplateDbStore,
  ProjectKnowledgeCategoryError,
  PROJECT_KNOWLEDGE_CATEGORIES,
  FactoryDatabase,
  type ProjectKnowledgeStore,
  type ProjectKnowledgeRecord,
  type ProjectKnowledgeCategory,
  type ProjectTemplateDbStore,
  type ProjectTemplateDbRecord,
} from '../src/index';

const NOW = '2026-10-13T12:00:00.000Z';
const LATER = '2026-10-13T13:00:00.000Z';

function entry(over: Partial<ProjectKnowledgeRecord> = {}): ProjectKnowledgeRecord {
  return {
    entryId: 'e-1',
    projectId: 'proj-1',
    category: 'decisions',
    title: 'Use SQLite',
    content: 'We use node:sqlite, zero external deps.',
    sourcePath: 'docs/adr-001.md',
    sourceVersion: 'v1',
    sourceHash: 'sha256:abc',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function knowledgeStores(db: DatabaseSync): ProjectKnowledgeStore[] {
  return [new InMemoryProjectKnowledgeStore(), new SqliteProjectKnowledgeStore(db)];
}

function templateStores(db: DatabaseSync): ProjectTemplateDbStore[] {
  return [new InMemoryProjectTemplateDbStore(), new SqliteProjectTemplateDbStore(db)];
}

const MINIMAL_KNOWLEDGE_SCHEMA = `CREATE TABLE project_knowledge (
  entry_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, category TEXT NOT NULL,
  title TEXT NOT NULL, content TEXT NOT NULL, source_path TEXT, source_version TEXT,
  source_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(project_id, category, title));
CREATE TABLE project_templates (
  name TEXT PRIMARY KEY, definition_json TEXT NOT NULL, registered_at TEXT NOT NULL);`;

describe('project knowledge (Batch 33)', () => {
  it('the nine spec categories are the only valid ones', () => {
    assert.equal(PROJECT_KNOWLEDGE_CATEGORIES.length, 9);
    for (const cat of [
      'product-requirements',
      'architecture',
      'tech-stack',
      'coding-test-security-standards',
      'deployment-rules',
      'known-bugs',
      'constraints',
      'decisions',
      'lessons',
    ] as const) {
      assert.ok((PROJECT_KNOWLEDGE_CATEGORIES as readonly string[]).includes(cat), cat);
    }
  });

  it('upsert/get/list/delete round-trip; deep copies', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MINIMAL_KNOWLEDGE_SCHEMA);
    for (const store of knowledgeStores(db)) {
      store.upsert(entry());
      const got = store.get('e-1')!;
      assert.equal(got.content, entry().content);
      assert.equal(got.sourceHash, 'sha256:abc');
      // deep copy: mutating the result must not corrupt the store
      got.content = 'MUTATED';
      assert.equal(store.get('e-1')!.content, entry().content);
      // category + project isolation
      store.upsert(entry({ entryId: 'e-2', category: 'lessons', title: 'T2' }));
      store.upsert(entry({ entryId: 'e-3', projectId: 'proj-2', title: 'T3' }));
      assert.equal(store.list('proj-1').length, 2);
      assert.equal(store.list('proj-1', 'lessons').length, 1);
      assert.equal(store.list('proj-2').length, 1);
      assert.equal(store.list('proj-1', 'architecture').length, 0);
      assert.ok(store.delete('e-2'));
      assert.ok(!store.delete('e-2'));
      assert.equal(store.get('e-2'), undefined);
    }
    db.close();
  });

  it('re-saving the same (project, category, title) updates in place', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MINIMAL_KNOWLEDGE_SCHEMA);
    for (const store of knowledgeStores(db)) {
      store.upsert(entry());
      const updated: ProjectKnowledgeRecord = {
        ...entry(),
        entryId: 'e-different', // must not win: key is (project, category, title)
        content: 'Revised summary.',
        sourceHash: 'sha256:def',
        createdAt: LATER, // must not win: original createdAt is kept
        updatedAt: LATER,
      };
      store.upsert(updated);
      const got = store.get('e-1')!;
      assert.equal(got.content, 'Revised summary.');
      assert.equal(got.sourceHash, 'sha256:def');
      assert.equal(got.createdAt, NOW, 'upsert keeps the original createdAt');
      assert.equal(got.updatedAt, LATER);
      assert.equal(store.list('proj-1').length, 1, 'still one row, not two');
    }
    db.close();
  });

  it('unknown categories are loud at write and filter time', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MINIMAL_KNOWLEDGE_SCHEMA);
    for (const store of knowledgeStores(db)) {
      assert.throws(
        () => store.upsert(entry({ category: 'vibes' as ProjectKnowledgeCategory })),
        (e: unknown) => e instanceof ProjectKnowledgeCategoryError,
      );
      assert.throws(
        () => store.list('proj-1', 'vibes' as ProjectKnowledgeCategory),
        (e: unknown) => e instanceof ProjectKnowledgeCategoryError,
      );
    }
    db.close();
  });

  it('sqlite store survives close/reopen; old DBs gain the tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-know-'));
    const file = join(dir, 'factory.db');
    try {
      // simulate a pre-Batch-33 database: create the file with an OLD
      // schema only (one table that is not ours)
      const old = new DatabaseSync(file);
      old.exec('CREATE TABLE projects (id TEXT PRIMARY KEY);');
      old.close();
      // FactoryDatabase opens with the full current SCHEMA — IF NOT
      // EXISTS must add our tables to the old file
      const fdb = new FactoryDatabase(file);
      fdb.projectKnowledge.upsert(entry());
      fdb.projectKnowledge.upsert(entry({ entryId: 'e-2', category: 'lessons', title: 'T2' }));
      fdb.projectTemplates.save({
        name: 'godot-2d',
        definitionJson: JSON.stringify({ name: 'godot-2d' }),
        registeredAt: NOW,
      });
      assert.equal(fdb.projectKnowledge.list('proj-1').length, 2);
      assert.equal(fdb.projectTemplates.list().length, 1);
      fdb.close();
      // reopen: everything still there
      const fdb2 = new FactoryDatabase(file);
      assert.equal(fdb2.projectKnowledge.get('e-1')!.content, entry().content);
      assert.equal(
        JSON.parse(fdb2.projectTemplates.get('godot-2d')!.definitionJson).name,
        'godot-2d',
      );
      fdb2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('project_templates save/get/list/delete', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MINIMAL_KNOWLEDGE_SCHEMA);
    const rec = (name: string): ProjectTemplateDbRecord => ({
      name,
      definitionJson: JSON.stringify({ name }),
      registeredAt: NOW,
    });
    for (const store of templateStores(db)) {
      store.save(rec('godot-2d'));
      store.save(rec('tauri-app'));
      assert.equal(store.list().length, 2);
      assert.equal(JSON.parse(store.get('godot-2d')!.definitionJson).name, 'godot-2d');
      // save is an upsert by name
      store.save(rec('godot-2d'));
      assert.equal(store.list().length, 2);
      // deep copy
      const got = store.get('godot-2d')!;
      got.definitionJson = 'MUTATED';
      assert.ok(store.get('godot-2d')!.definitionJson.includes('godot-2d'));
      assert.ok(store.delete('godot-2d'));
      assert.ok(!store.delete('godot-2d'));
      assert.equal(store.get('godot-2d'), undefined);
    }
    db.close();
  });
});

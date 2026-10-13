/**
 * Batch 33 — §6.1 project-record fields (§6.1 supports 13 record fields).
 *
 *   - schema carries all 13 fields (old columns preserved);
 *   - createProject accepts the §6.1 fields; absent ones stay null/[]
 *     (never fabricated), refs round-trip as string arrays;
 *   - migrateProjectsTable upgrades a legacy-shaped DB in place: new
 *     columns are added nullable and old rows read back with nulls;
 *   - corrupt JSON in a refs column fails loudly (same contract as
 *     the Batch-31 pipeline stage rows).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FactoryDatabase, migrateProjectsTable, rowToProject } from '../src/db';

let dir: string;
let fdb: FactoryDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'db-projectfields-'));
  fdb = new FactoryDatabase(join(dir, 'factory.db'));
});

afterEach(() => {
  fdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('§6.1 project-record fields', () => {
  it('createProject with all §6.1 fields round-trips them', () => {
    const created = fdb.createProject({
      id: 'p-full',
      name: 'Full',
      description: 'd',
      path: '/x',
      organization_id: 'org-1',
      profile_version: '3',
      repository_refs: ['https://example.com/a.git', 'https://example.com/b.git'],
      workspace_refs: ['ws-1'],
      instruction_refs: ['in-2'],
      policy_version: 'pv-9',
      default_manager_id: 'mgr-7',
      workflow_version: 'wv-2',
      environment_refs: ['env-prod'],
      data_classification: 'confidential',
      lifecycle_state: 'active',
    });
    assert.deepEqual(created.repository_refs, ['https://example.com/a.git', 'https://example.com/b.git']);
    assert.deepEqual(created.workspace_refs, ['ws-1']);
    assert.deepEqual(created.instruction_refs, ['in-2']);
    assert.deepEqual(created.environment_refs, ['env-prod']);
    assert.equal(created.organization_id, 'org-1');
    assert.equal(created.profile_version, '3');
    assert.equal(created.policy_version, 'pv-9');
    assert.equal(created.default_manager_id, 'mgr-7');
    assert.equal(created.workflow_version, 'wv-2');
    assert.equal(created.data_classification, 'confidential');
    assert.equal(created.lifecycle_state, 'active');

    const read = fdb.getProject('p-full');
    assert.ok(read);
    assert.deepEqual(read, created);
    assert.ok(fdb.listProjects().some((r) => r.id === 'p-full' && r.organization_id === 'org-1'));
  });

  it('minimal createProject keeps §6.1 fields null/[] (nothing fabricated)', () => {
    const created = fdb.createProject({ id: 'p-min', name: 'Min', description: '', path: '' });
    assert.equal(created.organization_id, null);
    assert.equal(created.profile_version, null);
    assert.equal(created.policy_version, null);
    assert.equal(created.default_manager_id, null);
    assert.equal(created.workflow_version, null);
    assert.equal(created.data_classification, null);
    assert.equal(created.lifecycle_state, null);
    assert.deepEqual(created.repository_refs, []);
    assert.deepEqual(created.workspace_refs, []);
    assert.deepEqual(created.instruction_refs, []);
    assert.deepEqual(created.environment_refs, []);
    // Old callers (seed + other suites) still compile and pass.
    assert.equal(created.status, 'active');
  });

  it('migrateProjectsTable upgrades a legacy-shaped DB in place (old rows → nulls)', () => {
    const legacyFile = join(dir, 'legacy.db');
    const legacy = new DatabaseSync(legacyFile);
    legacy.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
      path TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    legacy
      .prepare(
        `INSERT INTO projects (id, name, description, path, status, created_at, updated_at)
         VALUES ('old-1', 'Old', '', '/old', 'active', '2020-01-01', '2020-01-01')`,
      )
      .run();
    migrateProjectsTable(legacy);
    legacy.close();

    const upgraded = new FactoryDatabase(legacyFile);
    try {
      const row = upgraded.getProject('old-1');
      assert.ok(row);
      assert.equal(row.name, 'Old');
      assert.equal(row.status, 'active');
      // New §6.1 fields read back as null/[] — the upgrade did not
      // fabricate an organization, policy version or lifecycle state.
      assert.equal(row.organization_id, null);
      assert.equal(row.policy_version, null);
      assert.equal(row.lifecycle_state, null);
      assert.deepEqual(row.repository_refs, []);
      // And the upgraded DB accepts new §6.1 fields going forward.
      upgraded.createProject({ id: 'new-1', name: 'New', description: '', path: '', lifecycle_state: 'active' });
      assert.equal(upgraded.getProject('new-1')?.lifecycle_state, 'active');
    } finally {
      upgraded.close();
    }
  });

  it('corrupt JSON in a refs column fails loudly, never guessed', () => {
    const raw = {
      id: 'p-bad', name: 'Bad', description: '', path: '', status: 'active',
      archived_at: null, created_at: 'x', updated_at: 'x',
      organization_id: null, profile_version: null,
      repository_refs: 'not-json{{{', workspace_refs: null,
      instruction_refs: null, policy_version: null,
      default_manager_id: null, workflow_version: null,
      environment_refs: '["ok"]', data_classification: null,
      lifecycle_state: null,
    };
    assert.throws(() => rowToProject(raw), /corrupted projects row: column repository_refs is not valid JSON/);
    assert.throws(
      () => rowToProject({ ...raw, repository_refs: '{"not":"array"}' }),
      /is not a string array/,
    );
  });

  it('setProjectStatus leaves §6.1 fields intact', () => {
    fdb.createProject({
      id: 'p-arc', name: 'A', description: '', path: '',
      organization_id: 'org-x', repository_refs: ['u'],
    });
    const archived = fdb.setProjectStatus('p-arc', 'archived');
    assert.ok(archived);
    assert.equal(archived.organization_id, 'org-x');
    assert.deepEqual(archived.repository_refs, ['u']);
  });
});

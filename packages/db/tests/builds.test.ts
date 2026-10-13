/**
 * Build records — SPEC v2 §40 (Batch 23).
 *
 * One scripted sequence, run identically against the in-memory
 * reference and the SQLite implementation:
 *  - record() writes the honest shape: real merge fields round-trip,
 *    status is NOT_EXECUTED, digest/definition/sbomRef/attestationRef
 *    are null with the exact pinned reason notes;
 *  - get/list/listByPr/listByRevision behave the same on both;
 *  - copy contract: mutating a fetched row or the input after
 *    record() cannot corrupt stored state;
 *  - a missing revision is refused loudly (no fabricated revision);
 *  - rows written by one FactoryDatabase are visible under the next,
 *    on an old database file that predates the builds table entirely.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FactoryDatabase,
  MemoryBuildRecordStore,
  SqliteBuildRecordStore,
  NO_BUILD_DIGEST_NOTE,
  NO_BUILD_DEFINITION_NOTE,
  type BuildRecordStore,
  type RecordBuildInput,
  type StoredBuildRecord,
} from '../src/index';

const REV = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const DIFF = 'd'.repeat(64);

function makeInput(over: Partial<RecordBuildInput> = {}): RecordBuildInput {
  return {
    revision: REV,
    targetSha: TARGET,
    baseSha: BASE,
    diffHash: DIFF,
    repo: '/repo/a',
    prId: 'pr-1',
    taskId: 'task-1',
    sourceBranch: 'feat',
    targetBranch: 'main',
    builtBy: 'human',
    ...over,
  };
}

function assertHonestShape(r: StoredBuildRecord, input: RecordBuildInput): void {
  assert.ok(r.id.length > 0, 'id assigned');
  assert.equal(r.revision, input.revision);
  assert.equal(r.targetSha, input.targetSha ?? null);
  assert.equal(r.baseSha, input.baseSha ?? null);
  assert.equal(r.diffHash, input.diffHash ?? null);
  assert.equal(r.repo, input.repo);
  assert.equal(r.prId, input.prId);
  assert.equal(r.taskId, input.taskId ?? null);
  assert.equal(r.sourceBranch, input.sourceBranch);
  assert.equal(r.targetBranch, input.targetBranch);
  assert.equal(r.builtBy, input.builtBy);
  assert.match(r.builtAt, /^\d{4}-\d{2}-\d{2}T/, 'builtAt is ISO-8601');
  // The honest core: no build ran, so no digest/definition/SBOM.
  assert.equal(r.status, 'NOT_EXECUTED');
  assert.equal(r.digest, null, 'no digest without a real build — null, not invented');
  assert.equal(r.digestNote, NO_BUILD_DIGEST_NOTE, 'absence carries its reason');
  assert.equal(r.definition, null, 'no definition without a real build');
  assert.equal(r.definitionNote, NO_BUILD_DEFINITION_NOTE, 'absence carries its reason');
  assert.equal(r.sbomRef, null, 'no SBOM without a build');
  assert.equal(r.attestationRef, null, 'no attestation without a build');
}

/** The shared scripted sequence both implementations must satisfy. */
function scriptedSequence(store: BuildRecordStore, label: string): void {
  const input = makeInput();
  const rec = store.record(input);
  assertHonestShape(rec, input);

  // get() round-trips field-for-field.
  const fetched = store.get(rec.id);
  assert.ok(fetched, `${label}: get finds the record`);
  assert.deepEqual(fetched, rec);

  // Copy contract: mutating a fetched row cannot corrupt stored state.
  (fetched as StoredBuildRecord).repo = '/tampered';
  (fetched as StoredBuildRecord).digestNote = 'tampered';
  const refetched = store.get(rec.id);
  assert.equal(refetched?.repo, '/repo/a', `${label}: stored row immune to caller mutation`);
  assert.equal(refetched?.digestNote, NO_BUILD_DIGEST_NOTE);

  // record() snapshots its input.
  const input2 = makeInput({ prId: 'pr-2', revision: 'e'.repeat(40) });
  const rec2 = store.record(input2);
  input2.prId = 'tampered';
  assert.equal(store.get(rec2.id)?.prId, 'pr-2', `${label}: input mutation after record() is not reflected`);

  // list / listByPr / listByRevision.
  assert.equal(store.list().length, 2, `${label}: list sees both records`);
  assert.equal(store.listByPr('pr-1').length, 1);
  assert.equal(store.listByPr('pr-1')[0].id, rec.id);
  assert.equal(store.listByPr('pr-2')[0].id, rec2.id);
  assert.equal(store.listByPr('nope').length, 0);
  assert.equal(store.listByRevision(REV).length, 1);
  assert.equal(store.listByRevision(REV)[0].id, rec.id);
  assert.equal(store.get('missing'), undefined, `${label}: unknown id → undefined`);

  // A missing revision is refused loudly — never fabricated.
  assert.throws(
    () => store.record(makeInput({ revision: '' })),
    /revision is required/,
    `${label}: empty revision refused, not invented`,
  );
}

describe('build records (§40, Batch 23)', () => {
  it('memory and SQLite implementations satisfy the same honest contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'builds-'));
    try {
      const file = join(dir, 'b.db');
      const raw = new DatabaseSync(file);
      raw.exec(
        'CREATE TABLE builds (id TEXT PRIMARY KEY, revision TEXT NOT NULL, target_sha TEXT, base_sha TEXT, diff_hash TEXT, repo_path TEXT NOT NULL, pr_id TEXT NOT NULL, task_id TEXT, source_branch TEXT NOT NULL, target_branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'NOT_EXECUTED\', digest TEXT, digest_note TEXT NOT NULL, definition_json TEXT, definition_note TEXT NOT NULL, sbom_ref TEXT, attestation_ref TEXT, built_by TEXT NOT NULL DEFAULT \'\', built_at TEXT NOT NULL)',
      );
      const sqlite = new SqliteBuildRecordStore(raw);
      scriptedSequence(new MemoryBuildRecordStore(), 'memory');
      scriptedSequence(sqlite, 'sqlite');
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rows survive a reopen on a database that predates the builds table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'builds-old-'));
    const file = join(dir, 'old.db');
    try {
      // An "old" database: created by hand with only the projects table,
      // so the builds table arrives via CREATE TABLE IF NOT EXISTS.
      {
        const raw = new DatabaseSync(file);
        raw.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
        raw.close();
      }
      const fdb1 = new FactoryDatabase(file);
      assert.deepEqual(fdb1.builds.list(), [], 'builds table exists and starts empty');
      const rec = fdb1.builds.record(makeInput());
      assertHonestShape(rec, makeInput());
      fdb1.close();

      const fdb2 = new FactoryDatabase(file);
      const rows = fdb2.builds.listByPr('pr-1');
      assert.equal(rows.length, 1, 'record durable across reopen');
      assertHonestShape(rows[0], makeInput());
      assert.equal(rows[0].id, rec.id);
      fdb2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown row status fails loudly instead of being silently coerced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'builds-corrupt-'));
    try {
      const file = join(dir, 'c.db');
      const raw = new DatabaseSync(file);
      raw.exec(
        `CREATE TABLE builds (id TEXT PRIMARY KEY, revision TEXT NOT NULL, target_sha TEXT, base_sha TEXT, diff_hash TEXT, repo_path TEXT NOT NULL, pr_id TEXT NOT NULL, task_id TEXT, source_branch TEXT NOT NULL, target_branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'NOT_EXECUTED', digest TEXT, digest_note TEXT NOT NULL, definition_json TEXT, definition_note TEXT NOT NULL, sbom_ref TEXT, attestation_ref TEXT, built_by TEXT NOT NULL DEFAULT '', built_at TEXT NOT NULL);
         INSERT INTO builds (id, revision, repo_path, pr_id, source_branch, target_branch, status, digest_note, definition_note, built_at)
         VALUES ('x', '${REV}', '/r', 'p', 'f', 'main', 'SUCCEEDED', 'n', 'n', '2026-01-01T00:00:00.000Z')`,
      );
      const store = new SqliteBuildRecordStore(raw);
      assert.throws(() => store.get('x'), /unknown status/, 'foreign status is not misread as NOT_EXECUTED');
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

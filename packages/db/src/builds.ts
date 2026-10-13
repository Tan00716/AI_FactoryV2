/**
 * Build records — SPEC v2 §40 (Batch 23).
 *
 * §40 requires a build's digest to be stored (with SBOM/attestation when
 * policy requires). Batch 22-3 audited the merge surface and found the
 * uncomfortable truth: merges never run a build, lockBuild() has zero
 * production callers, and there was no builds table at all — so
 * artifactDigest stayed null with an honest 'no artifact' note.
 *
 * This module is step one of the "minimal build-record loop": a durable
 * builds table, written the moment a merge lands. The record is
 * deliberately NOT a fake build:
 *  - status is 'NOT_EXECUTED' — no build ran for this merge;
 *  - digest is null — a digest without a build would be fabrication
 *    (calling lockBuild() with unassemblable inputs is exactly that);
 *  - definition / sbomRef / attestationRef are null, each with a note
 *    saying what is missing and why.
 * The nulls record ABSENCE, not placeholders. A future batch that
 * executes a real build can extend the status union and fill the digest
 * on the same row shape; until then, 'no artifact' stays the only honest
 * state for merge evidence (see gap-audit/AUDIT_BUILD_DIGEST_40_TO_36.md).
 *
 * Copy contract (same as the other stores): reads return fresh deep
 * copies; record() snapshots its input.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

/**
 * Build execution status. Only NOT_EXECUTED exists today: the record
 * marks that a merge landed and no build was executed for it. A real
 * build executor (future batch) extends this union (e.g. SUCCEEDED /
 * FAILED) and fills digest/definition then — never retroactively.
 */
export type BuildRecordStatus = 'NOT_EXECUTED';

/** Exact note stored on every record whose digest is null. Pinned by tests. */
export const NO_BUILD_DIGEST_NOTE =
  'no build was executed for this merge — merge does not run a build; ' +
  'digest is null (records absence, not a placeholder). See KNOWN_LIMITATIONS §40.';

/** Exact note stored on every record whose build definition is null. Pinned by tests. */
export const NO_BUILD_DEFINITION_NOTE =
  'lockBuild() inputs (lockfileHash, toolchain, buildDefinitionHash, ' +
  'configHash) are not assemblable from the merge context; calling ' +
  'lockBuild() here would fabricate a digest.';

export interface StoredBuildRecord {
  id: string;
  /** Candidate SHA — the merged branch tip that carries the change. */
  revision: string;
  /** Target branch tip after the merge landed. */
  targetSha: string | null;
  /** Target branch tip before the merge (the change's base). */
  baseSha: string | null;
  /** sha256 hex of the base→target diff that landed. */
  diffHash: string | null;
  repo: string;
  prId: string;
  taskId: string | null;
  sourceBranch: string;
  targetBranch: string;
  status: BuildRecordStatus;
  /** Build digest — null until a real build executes. */
  digest: string | null;
  /** Why digest is null (always NO_BUILD_DIGEST_NOTE today). */
  digestNote: string;
  /**
   * Serialized BuildDefinition — null until a real build locks one.
   * Typed as null (not unknown) so a future executor must extend the
   * shape deliberately instead of smuggling values through.
   */
  definition: null;
  /** Why definition is null (always NO_BUILD_DEFINITION_NOTE today). */
  definitionNote: string;
  /** SBOM reference — null: no SBOM exists without a build. */
  sbomRef: string | null;
  /** Attestation reference — null: no attestation exists without a build. */
  attestationRef: string | null;
  /** Who triggered the merge that this record was written for. */
  builtBy: string;
  /** When the merge landed (ISO-8601). Not a build timestamp. */
  builtAt: string;
}

/**
 * What a merge path can honestly provide. Every field here is a real
 * value taken from the merge itself; everything the store cannot know
 * (digest, definition, SBOM, attestation) is filled with explicit
 * absence + reason by the store, never by the caller.
 */
export interface RecordBuildInput {
  revision: string;
  targetSha?: string | null;
  baseSha?: string | null;
  diffHash?: string | null;
  repo: string;
  prId: string;
  taskId?: string | null;
  sourceBranch: string;
  targetBranch: string;
  builtBy: string;
}

export interface BuildRecordStore {
  /** Write one build record for a landed merge. Insert-only: one merge,
   *  one record. Returns a copy of the stored row. */
  record(input: RecordBuildInput): StoredBuildRecord;
  /** One record by id (a copy), or undefined. */
  get(id: string): StoredBuildRecord | undefined;
  /** All records, oldest first. */
  list(): StoredBuildRecord[];
  /** Records for one PR, oldest first. */
  listByPr(prId: string): StoredBuildRecord[];
  /** Records for one revision, oldest first. */
  listByRevision(revision: string): StoredBuildRecord[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function copyRecord(r: StoredBuildRecord): StoredBuildRecord {
  return structuredClone(r);
}

function toRecord(input: RecordBuildInput): StoredBuildRecord {
  if (!input.revision) {
    throw new Error('RecordBuildInput.revision is required — refusing to record a build with no revision');
  }
  return {
    id: randomUUID(),
    revision: input.revision,
    targetSha: input.targetSha ?? null,
    baseSha: input.baseSha ?? null,
    diffHash: input.diffHash ?? null,
    repo: input.repo,
    prId: input.prId,
    taskId: input.taskId ?? null,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    status: 'NOT_EXECUTED',
    digest: null,
    digestNote: NO_BUILD_DIGEST_NOTE,
    definition: null,
    definitionNote: NO_BUILD_DEFINITION_NOTE,
    sbomRef: null,
    attestationRef: null,
    builtBy: input.builtBy,
    builtAt: nowIso(),
  };
}

/** In-memory reference implementation (tests, embedders without SQLite). */
export class MemoryBuildRecordStore implements BuildRecordStore {
  private readonly rows = new Map<string, StoredBuildRecord>();

  record(input: RecordBuildInput): StoredBuildRecord {
    const stored = copyRecord(toRecord(input));
    this.rows.set(stored.id, stored);
    return copyRecord(stored);
  }

  get(id: string): StoredBuildRecord | undefined {
    const r = this.rows.get(id);
    return r ? copyRecord(r) : undefined;
  }

  list(): StoredBuildRecord[] {
    return [...this.rows.values()].map(copyRecord);
  }

  listByPr(prId: string): StoredBuildRecord[] {
    return this.list().filter((r) => r.prId === prId);
  }

  listByRevision(revision: string): StoredBuildRecord[] {
    return this.list().filter((r) => r.revision === revision);
  }
}

function rowToRecord(r: Record<string, unknown>): StoredBuildRecord {
  const status = r['status'] as string;
  // Loud on unknown status: this table is only ever written by this
  // store, so a foreign value means corruption or a newer writer this
  // reader does not understand — coercing it silently would
  // misrepresent the row. (Merge-queue rows fall back to QUEUED by
  // design because hydrate() re-verifies them; build rows are pure
  // history with no re-verification step, so there is nothing safe to
  // fall back to.)
  if (status !== 'NOT_EXECUTED') {
    throw new Error(
      `builds row ${r['id']} has unknown status ${JSON.stringify(status)} — refusing to misread it`,
    );
  }
  return {
    id: r['id'] as string,
    revision: r['revision'] as string,
    targetSha: (r['target_sha'] as string | null) ?? null,
    baseSha: (r['base_sha'] as string | null) ?? null,
    diffHash: (r['diff_hash'] as string | null) ?? null,
    repo: r['repo_path'] as string,
    prId: r['pr_id'] as string,
    taskId: (r['task_id'] as string | null) ?? null,
    sourceBranch: r['source_branch'] as string,
    targetBranch: r['target_branch'] as string,
    status: 'NOT_EXECUTED' as BuildRecordStatus,
    digest: (r['digest'] as string | null) ?? null,
    digestNote: r['digest_note'] as string,
    definition: null,
    definitionNote: r['definition_note'] as string,
    sbomRef: (r['sbom_ref'] as string | null) ?? null,
    attestationRef: (r['attestation_ref'] as string | null) ?? null,
    builtBy: r['built_by'] as string,
    builtAt: r['built_at'] as string,
  };
}

/** SQLite-backed BuildRecordStore. Insert-only; rows are history. */
export class SqliteBuildRecordStore implements BuildRecordStore {
  constructor(private readonly db: DatabaseSync) {}

  record(input: RecordBuildInput): StoredBuildRecord {
    const rec = toRecord(input);
    this.db
      .prepare(
        `INSERT INTO builds
           (id, revision, target_sha, base_sha, diff_hash, repo_path, pr_id,
            task_id, source_branch, target_branch, status, digest, digest_note,
            definition_json, definition_note, sbom_ref, attestation_ref,
            built_by, built_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        rec.id,
        rec.revision,
        rec.targetSha,
        rec.baseSha,
        rec.diffHash,
        rec.repo,
        rec.prId,
        rec.taskId,
        rec.sourceBranch,
        rec.targetBranch,
        rec.status,
        rec.digest,
        rec.digestNote,
        null, // definition_json: no definition exists without a build
        rec.definitionNote,
        rec.sbomRef,
        rec.attestationRef,
        rec.builtBy,
        rec.builtAt,
      );
    return copyRecord(rec);
  }

  get(id: string): StoredBuildRecord | undefined {
    const r = this.db
      .prepare('SELECT * FROM builds WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return r ? copyRecord(rowToRecord(r)) : undefined;
  }

  list(): StoredBuildRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM builds ORDER BY rowid')
      .all() as unknown as Record<string, unknown>[];
    return rows.map((r) => copyRecord(rowToRecord(r)));
  }

  listByPr(prId: string): StoredBuildRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM builds WHERE pr_id = ? ORDER BY rowid')
      .all(prId) as unknown as Record<string, unknown>[];
    return rows.map((r) => copyRecord(rowToRecord(r)));
  }

  listByRevision(revision: string): StoredBuildRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM builds WHERE revision = ? ORDER BY rowid')
      .all(revision) as unknown as Record<string, unknown>[];
    return rows.map((r) => copyRecord(rowToRecord(r)));
  }
}

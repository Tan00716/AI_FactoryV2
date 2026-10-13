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
 * Build execution status.
 *  - NOT_EXECUTED: the merge landed and no build ran (the Batch 23 state).
 *  - SUCCEEDED: a real build executed for this record (Batch 24). The
 *    digest is the §40 lockBuild digest over real inputs when all inputs
 *    were assemblable, else null with a note naming the missing inputs.
 *  - FAILED: a real build was attempted but failed (non-zero exit,
 *    timeout, or policy refusal). digest stays null with the reason.
 * Transitions are one-way: NOT_EXECUTED → SUCCEEDED | FAILED. A future
 * batch that re-runs builds must add an explicit re-run transition —
 * silently overwriting a terminal row would misrepresent history.
 */
export type BuildRecordStatus = 'NOT_EXECUTED' | 'SUCCEEDED' | 'FAILED';

/** Exact note stored on every record whose digest is null. Pinned by tests. */
export const NO_BUILD_DIGEST_NOTE =
  'no build was executed for this merge — merge does not run a build; ' +
  'digest is null (records absence, not a placeholder). See KNOWN_LIMITATIONS §40.';

/** Exact note stored on every record whose build definition is null. Pinned by tests. */
export const NO_BUILD_DEFINITION_NOTE =
  'lockBuild() inputs (lockfileHash, toolchain, buildDefinitionHash, ' +
  'configHash) are not assemblable from the merge context; calling ' +
  'lockBuild() here would fabricate a digest.';

/** Exact sbomNote on a fresh record: no build ran, so no SBOM exists. Pinned by tests. */
export const NO_SBOM_NOTE =
  'no build was executed for this merge — no SBOM exists ' +
  '(records absence, not a placeholder).';

/** sbomNote when a real build ran but no lockfile yielded an inventory. */
export const SBOM_NO_LOCKFILE_NOTE =
  'no parsable lockfile found in the build worktree — no SBOM generated ' +
  '(nothing honest to derive from; node_modules/package.json ranges are a weaker claim).';

/** sbomNote set by markFailed: a failed build produces no SBOM. */
export const BUILD_FAILED_NO_SBOM_NOTE =
  'build failed — no SBOM generated (no successful build output to inventory).';

/** sbomNote when SBOM generation itself threw. The reason is named, never hidden. */
export function sbomGenerationFailedNote(reason: string): string {
  return `SBOM generation failed: ${reason} — no SBOM recorded (the build itself still stands as SUCCEEDED).`;
}

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
  /** Build digest — the §40 lockBuild digest over real inputs once a
   *  real build SUCCEEDED and all lock inputs were assemblable; null
   *  otherwise (never fabricated). */
  digest: string | null;
  /** Why digest is null (always set when digest is null). */
  digestNote: string;
  /**
   * Serialized BuildDefinition JSON — set when a real build locked one.
   * Null until then (never a placeholder).
   */
  definition: string | null;
  /** Why definition is null (always set when definition is null). */
  definitionNote: string;
  /** SBOM reference — null: no SBOM exists without a build. */
  sbomRef: string | null;
  /** Why sbomRef is null, or '' when an SBOM was recorded. Always set. */
  sbomNote: string;
  /** Attestation reference — null: no attestation exists without a build. */
  attestationRef: string | null;
  /** Build process exit code — set once a real build ran. */
  exitCode: number | null;
  /** Why a build FAILED (or why the digest could not be locked). */
  failureReason: string | null;
  /** When the build finished (ISO-8601) — set on SUCCEEDED/FAILED. */
  completedAt: string | null;
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
  /**
   * Transition a NOT_EXECUTED record to SUCCEEDED after a real build.
   * Throws when the record is missing or not NOT_EXECUTED — terminal
   * rows are history and are never overwritten.
   */
  markSucceeded(
    id: string,
    result: {
      digest: string | null;
      digestNote: string;
      definition: string | null;
      definitionNote: string;
      sbomRef: string | null;
      sbomNote: string;
      exitCode: number;
      completedAt?: string;
    },
  ): StoredBuildRecord;
  /**
   * Transition a NOT_EXECUTED record to FAILED after a real build
   * attempt failed (non-zero exit, timeout, policy refusal). Same
   * one-way guard as markSucceeded.
   */
  markFailed(
    id: string,
    result: { reason: string; exitCode?: number | null; completedAt?: string },
  ): StoredBuildRecord;
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
    sbomNote: NO_SBOM_NOTE,
    attestationRef: null,
    builtBy: input.builtBy,
    builtAt: nowIso(),
    exitCode: null,
    failureReason: null,
    completedAt: null,
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

  markSucceeded(
    id: string,
    result: {
      digest: string | null;
      digestNote: string;
      definition: string | null;
      definitionNote: string;
      sbomRef: string | null;
      sbomNote: string;
      exitCode: number;
      completedAt?: string;
    },
  ): StoredBuildRecord {
    const r = this.rows.get(id);
    const next = transition(r, id, 'SUCCEEDED');
    next.digest = result.digest;
    next.digestNote = result.digestNote;
    next.definition = result.definition;
    next.definitionNote = result.definitionNote;
    next.sbomRef = result.sbomRef;
    next.sbomNote = result.sbomNote;
    next.exitCode = result.exitCode;
    next.completedAt = result.completedAt ?? nowIso();
    this.rows.set(id, next);
    return copyRecord(next);
  }

  markFailed(
    id: string,
    result: { reason: string; exitCode?: number | null; completedAt?: string },
  ): StoredBuildRecord {
    const r = this.rows.get(id);
    const next = transition(r, id, 'FAILED');
    next.failureReason = result.reason;
    next.sbomNote = BUILD_FAILED_NO_SBOM_NOTE;
    next.exitCode = result.exitCode ?? null;
    next.completedAt = result.completedAt ?? nowIso();
    this.rows.set(id, next);
    return copyRecord(next);
  }
}

/**
 * One-way transition guard shared by both stores: only a NOT_EXECUTED
 * row may move, and only to a terminal state. Returns a fresh copy so
 * callers fill the terminal fields before persisting.
 */
function transition(
  r: StoredBuildRecord | undefined,
  id: string,
  to: 'SUCCEEDED' | 'FAILED',
): StoredBuildRecord {
  if (!r) {
    throw new Error(`builds row ${id} not found — refusing to transition a missing record`);
  }
  if (r.status !== 'NOT_EXECUTED') {
    throw new Error(
      `builds row ${id} has status ${r.status} — transitions are one-way from NOT_EXECUTED; refusing to overwrite terminal history`,
    );
  }
  const next = copyRecord(r);
  next.status = to;
  return next;
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
  if (status !== 'NOT_EXECUTED' && status !== 'SUCCEEDED' && status !== 'FAILED') {
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
    status: status as BuildRecordStatus,
    digest: (r['digest'] as string | null) ?? null,
    digestNote: r['digest_note'] as string,
    definition: (r['definition_json'] as string | null) ?? null,
    definitionNote: r['definition_note'] as string,
    sbomRef: (r['sbom_ref'] as string | null) ?? null,
    // Old rows (Batch 23/24) predate sbom_note — they never had SBOMs,
    // so the absence note is exactly their semantics.
    sbomNote: (r['sbom_note'] as string | null) ?? NO_SBOM_NOTE,
    attestationRef: (r['attestation_ref'] as string | null) ?? null,
    builtBy: r['built_by'] as string,
    builtAt: r['built_at'] as string,
    exitCode: (r['exit_code'] as number | null) ?? null,
    failureReason: (r['failure_reason'] as string | null) ?? null,
    completedAt: (r['completed_at'] as string | null) ?? null,
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
            definition_json, definition_note, sbom_ref, sbom_note,
            attestation_ref, built_by, built_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        rec.sbomNote,
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

  markSucceeded(
    id: string,
    result: {
      digest: string | null;
      digestNote: string;
      definition: string | null;
      definitionNote: string;
      sbomRef: string | null;
      sbomNote: string;
      exitCode: number;
      completedAt?: string;
    },
  ): StoredBuildRecord {
    const current = this.get(id);
    transition(current, id, 'SUCCEEDED');
    const completedAt = result.completedAt ?? nowIso();
    this.db
      .prepare(
        `UPDATE builds SET status = 'SUCCEEDED', digest = ?, digest_note = ?,
          definition_json = ?, definition_note = ?, sbom_ref = ?,
          sbom_note = ?, exit_code = ?, completed_at = ? WHERE id = ?`,
      )
      .run(
        result.digest,
        result.digestNote,
        result.definition,
        result.definitionNote,
        result.sbomRef,
        result.sbomNote,
        result.exitCode,
        completedAt,
        id,
      );
    return this.get(id) as StoredBuildRecord;
  }

  markFailed(
    id: string,
    result: { reason: string; exitCode?: number | null; completedAt?: string },
  ): StoredBuildRecord {
    const current = this.get(id);
    transition(current, id, 'FAILED');
    const completedAt = result.completedAt ?? nowIso();
    this.db
      .prepare(
        `UPDATE builds SET status = 'FAILED', failure_reason = ?,
          sbom_note = ?, exit_code = ?, completed_at = ? WHERE id = ?`,
      )
      .run(
        result.reason,
        BUILD_FAILED_NO_SBOM_NOTE,
        result.exitCode ?? null,
        completedAt,
        id,
      );
    return this.get(id) as StoredBuildRecord;
  }
}

/**
 * Merge Queue + PR persistence — SPEC v2 §36 (Batch 20).
 *
 * §36: "Base SHA、Candidate SHA、Target SHA、Diff Hash、Artifact Digest
 * 必须记录" and "用 Merge Queue/合并候选验证处理'PR 都测试通过，但合并
 * 一起失败'". Batch 16 shipped the queue with in-process state; this
 * file is the durable backing: every queue mutation is written through
 * the moment it happens, so a restarted server rebuilds the queue via
 * MergeQueue.hydrate() instead of losing it.
 *
 * Two tables (see schema.ts):
 *  - pull_requests: the PrStore's core fields (the PR records the queue
 *    consumes were in-memory too);
 *  - merge_queue_entries: one row per queue entry, with the five §36
 *    evidence fields, the verification snapshot, the failure reason and
 *    the decision audit reference.
 *
 * Crash-honesty contract (enforced by MergeQueue.hydrate, stored here):
 *  - a row left VERIFYING by a crash is NOT trusted on reload — it is
 *    demoted to QUEUED and re-verified from a freshly assembled
 *    candidate. The stored verification snapshot is display-only
 *    history until the re-run overwrites it.
 *  - MERGED / FAILED rows are terminal history, never reprocessed.
 *  - one PR holds at most one ACTIVE (QUEUED/VERIFYING) entry: the
 *    partial unique index merge_queue_active_pr rejects a second one,
 *    so a cross-process double-enqueue that races past the queue's
 *    in-memory check still fails with a UNIQUE constraint error, which
 *    the queue maps to its duplicate-enqueue domain error.
 *
 * Copy contract (same as the other stores): reads return fresh deep
 * copies; save() snapshots its input.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  type CreatePrInput,
  type DrainAcquireResult,
  type MergeQueueDrainLock,
  type MergeQueueDrainLockState,
  type MergeQueueEntry,
  type MergeQueueEntryPersistence,
  type PrRecord,
  type PrStatus,
} from '@ai-factory/git';

const PR_STATUSES: readonly PrStatus[] = ['OPEN', 'MERGED', 'CLOSED'];
const ENTRY_STATUSES = ['QUEUED', 'VERIFYING', 'MERGED', 'FAILED'] as const;

function rowToPr(r: Record<string, unknown>): PrRecord {
  const status = r['status'] as string;
  return {
    id: r['id'] as string,
    taskId: r['task_id'] as string,
    sourceBranch: r['source_branch'] as string,
    targetBranch: r['target_branch'] as string,
    title: r['title'] as string,
    status: (PR_STATUSES as readonly string[]).includes(status)
      ? (status as PrStatus)
      : 'OPEN',
    commits: JSON.parse((r['commits'] as string) ?? '[]') as string[],
    createdBy: r['created_by'] as string,
    createdAt: r['created_at'] as string,
    mergedAt: (r['merged_at'] as string | null) ?? null,
  };
}

/**
 * SQLite-backed PR store — same shapes and error behavior as the
 * in-memory PrStore in @ai-factory/git (create/get/list/updateStatus;
 * get/updateStatus throw `PR not found: <id>` for unknown ids).
 */
export class SqlitePrStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreatePrInput): PrRecord {
    const pr: PrRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      title: input.title,
      status: 'OPEN',
      commits: [...(input.commits ?? [])],
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      mergedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO pull_requests
           (id, task_id, source_branch, target_branch, title, status,
            commits, created_by, created_at, merged_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        pr.id,
        pr.taskId,
        pr.sourceBranch,
        pr.targetBranch,
        pr.title,
        pr.status,
        JSON.stringify(pr.commits),
        pr.createdBy,
        pr.createdAt,
        pr.mergedAt,
      );
    return structuredClone(pr);
  }

  get(id: string): PrRecord {
    const r = this.db
      .prepare('SELECT * FROM pull_requests WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!r) throw new Error(`PR not found: ${id}`);
    return rowToPr(r);
  }

  list(): PrRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM pull_requests ORDER BY rowid')
      .all() as unknown as Record<string, unknown>[];
    return rows.map(rowToPr);
  }

  updateStatus(id: string, status: PrStatus): PrRecord {
    const pr = this.get(id); // throws PR not found for unknown ids
    pr.status = status;
    if (status === 'MERGED') pr.mergedAt = new Date().toISOString();
    this.db
      .prepare('UPDATE pull_requests SET status = ?, merged_at = ? WHERE id = ?')
      .run(pr.status, pr.mergedAt, id);
    return structuredClone(pr);
  }
}

function rowToEntry(r: Record<string, unknown>): MergeQueueEntry {
  const status = r['status'] as string;
  return {
    id: r['id'] as string,
    repo: r['repo_path'] as string,
    prId: r['pr_id'] as string,
    taskId: r['task_id'] as string,
    sourceBranch: r['source_branch'] as string,
    targetBranch: r['target_branch'] as string,
    status: (ENTRY_STATUSES as readonly string[]).includes(status)
      ? (status as (typeof ENTRY_STATUSES)[number])
      : 'QUEUED',
    position: r['position'] as number,
    enqueuedBy: r['enqueued_by'] as string,
    enqueuedAt: r['enqueued_at'] as string,
    processedAt: (r['processed_at'] as string | null) ?? null,
    baseSha: (r['base_sha'] as string | null) ?? null,
    candidateSha: (r['candidate_sha'] as string | null) ?? null,
    candidateTreeOid: (r['candidate_tree_oid'] as string | null) ?? null,
    targetSha: (r['target_sha'] as string | null) ?? null,
    diffHash: (r['diff_hash'] as string | null) ?? null,
    artifactDigest: (r['artifact_digest'] as string | null) ?? null,
    verification:
      r['verification'] === null || r['verification'] === undefined
        ? null
        : (JSON.parse(r['verification'] as string) as MergeQueueEntry['verification']),
    failureReason: (r['failure_reason'] as string | null) ?? null,
    mergeCommitSha: (r['merge_commit_sha'] as string | null) ?? null,
    decisionAuditRef: (r['decision_audit_ref'] as string | null) ?? null,
    claimedBy: (r['claimed_by'] as string | null) ?? null,
    claimedAt: (r['claimed_at'] as string | null) ?? null,
  };
}

/**
 * SQLite-backed MergeQueueEntryPersistence. save() is an upsert by id;
 * the partial unique index on ACTIVE rows makes a second active entry
 * for one PR throw a UNIQUE constraint error (the queue maps it to its
 * duplicate-enqueue domain error). All writes are synchronous, so a
 * mutation is durable the moment persist() returns — a row can only
 * ever be left VERIFYING by a real crash, which is exactly the case
 * hydrate() treats honestly.
 */
export class SqliteMergeQueueEntryStore implements MergeQueueEntryPersistence {
  /**
   * Cross-process drain mutual exclusion (Batch 23). When set (the
   * FactoryDatabase wires one in), the queue serializes drains per
   * repo across processes. Absent, the queue keeps its pre-Batch-23
   * behavior: in-process serialization only.
   */
  readonly drainLock?: MergeQueueDrainLock;

  constructor(
    private readonly db: DatabaseSync,
    drainLock?: MergeQueueDrainLock,
  ) {
    this.drainLock = drainLock;
  }

  save(entry: MergeQueueEntry): void {
    const updated = this.db
      .prepare(
        `UPDATE merge_queue_entries SET
           repo_path=?, pr_id=?, task_id=?, source_branch=?, target_branch=?,
           status=?, position=?, enqueued_by=?, enqueued_at=?, processed_at=?,
           base_sha=?, candidate_sha=?, candidate_tree_oid=?, target_sha=?,
           diff_hash=?, artifact_digest=?, verification=?, failure_reason=?,
           merge_commit_sha=?, decision_audit_ref=?, claimed_by=?, claimed_at=?
         WHERE id = ?`,
      )
      .run(
        entry.repo,
        entry.prId,
        entry.taskId,
        entry.sourceBranch,
        entry.targetBranch,
        entry.status,
        entry.position,
        entry.enqueuedBy,
        entry.enqueuedAt,
        entry.processedAt,
        entry.baseSha,
        entry.candidateSha,
        entry.candidateTreeOid,
        entry.targetSha,
        entry.diffHash,
        entry.artifactDigest,
        entry.verification === null ? null : JSON.stringify(entry.verification),
        entry.failureReason,
        entry.mergeCommitSha,
        entry.decisionAuditRef,
        entry.claimedBy,
        entry.claimedAt,
        entry.id,
      );
    if (updated.changes === 0) {
      this.db
        .prepare(
          `INSERT INTO merge_queue_entries
             (id, repo_path, pr_id, task_id, source_branch, target_branch,
              status, position, enqueued_by, enqueued_at, processed_at,
              base_sha, candidate_sha, candidate_tree_oid, target_sha,
              diff_hash, artifact_digest, verification, failure_reason,
              merge_commit_sha, decision_audit_ref, claimed_by, claimed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          entry.id,
          entry.repo,
          entry.prId,
          entry.taskId,
          entry.sourceBranch,
          entry.targetBranch,
          entry.status,
          entry.position,
          entry.enqueuedBy,
          entry.enqueuedAt,
          entry.processedAt,
          entry.baseSha,
          entry.candidateSha,
          entry.candidateTreeOid,
          entry.targetSha,
          entry.diffHash,
          entry.artifactDigest,
          entry.verification === null ? null : JSON.stringify(entry.verification),
          entry.failureReason,
          entry.mergeCommitSha,
          entry.decisionAuditRef,
          entry.claimedBy,
          entry.claimedAt,
        );
    }
  }

  /**
   * Atomically claim a QUEUED entry for draining (Batch 23). A single
   * UPDATE … WHERE is atomic in SQLite: two processes racing on the
   * same row cannot both see changes === 1. The claim wins when the row
   * is QUEUED and (unclaimed, already held by `token`, or held longer
   * ago than now - ttlMs). Terminal rows (MERGED/FAILED) are never
   * claimable — the status predicate enforces it.
   */
  tryClaim(id: string, token: string, ttlMs: number): boolean {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    const updated = this.db
      .prepare(
        `UPDATE merge_queue_entries
         SET claimed_by = ?, claimed_at = ?
         WHERE id = ?
           AND status = 'QUEUED'
           AND (claimed_by IS NULL OR claimed_by = ? OR claimed_at < ?)`,
      )
      .run(token, now, id, token, cutoff);
    return updated.changes === 1;
  }

  load(repo: string): MergeQueueEntry[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM merge_queue_entries WHERE repo_path = ? ORDER BY position',
      )
      .all(repo) as unknown as Record<string, unknown>[];
    return rows.map((r) => structuredClone(rowToEntry(r)));
  }

  /**
   * Highest stored position for a repo (Batch 26): the arbiter input
   * for enqueue()'s position-collision retry. Null when the repo has
   * no rows.
   */
  maxPosition(repoPath: string): number | null {
    const row = this.db
      .prepare(
        'SELECT MAX(position) AS m FROM merge_queue_entries WHERE repo_path = ?',
      )
      .get(repoPath) as { m: number | null };
    return row.m;
  }

  /** One entry by id (a copy), or undefined. */
  get(id: string): MergeQueueEntry | undefined {
    const r = this.db
      .prepare('SELECT * FROM merge_queue_entries WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return r ? structuredClone(rowToEntry(r)) : undefined;
  }

  /** Record the audit-log id of the entry's terminal decision event. */
  setDecisionAuditRef(id: string, auditId: string): void {
    this.db
      .prepare('UPDATE merge_queue_entries SET decision_audit_ref = ? WHERE id = ?')
      .run(auditId, id);
  }
}

/**
 * SQLite-backed cross-process drain mutual exclusion (Batch 23).
 * One lease row per repo in `merge_queue_drain_locks`.
 *
 * Atomicity: the INSERT either wins outright or fails on the PRIMARY
 * KEY; the takeover is a single conditional UPDATE on the observed
 * heartbeat, so two contenders racing a stale lock cannot both win
 * (exactly one sees changes === 1). SQLite serializes the writers;
 * with the default rollback journal a contender that hits SQLITE_BUSY
 * fails loudly rather than silently proceeding.
 */
export class SqliteMergeQueueDrainLock implements MergeQueueDrainLock {
  constructor(private readonly db: DatabaseSync) {}

  drainState(repo: string): MergeQueueDrainLockState | null {
    const r = this.db
      .prepare(
        'SELECT holder_id, claimed_at, heartbeat_at FROM merge_queue_drain_locks WHERE repo_path = ?',
      )
      .get(repo) as
      | { holder_id: string; claimed_at: number; heartbeat_at: number }
      | undefined;
    if (!r) return null;
    return { holderId: r.holder_id, claimedAt: r.claimed_at, heartbeatAt: r.heartbeat_at };
  }

  acquireDrain(
    repo: string,
    holderId: string,
    nowMs: number,
    ttlMs: number,
  ): DrainAcquireResult {
    // Fast path: no row — the INSERT wins the race; losers get a
    // PRIMARY KEY violation below.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.db
          .prepare(
            `INSERT INTO merge_queue_drain_locks
               (repo_path, holder_id, claimed_at, heartbeat_at)
             VALUES (?,?,?,?)`,
          )
          .run(repo, holderId, nowMs, nowMs);
        return 'acquired';
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
      const cur = this.drainState(repo);
      if (!cur) continue; // holder released between our INSERT and SELECT — retry
      if (nowMs - cur.heartbeatAt <= ttlMs) return 'contested';
      // Stale heartbeat: conditional takeover — only one contender's
      // UPDATE matches the observed heartbeat.
      const took = this.db
        .prepare(
          `UPDATE merge_queue_drain_locks
           SET holder_id = ?, claimed_at = ?, heartbeat_at = ?
           WHERE repo_path = ? AND heartbeat_at = ?`,
        )
        .run(holderId, nowMs, nowMs, repo, cur.heartbeatAt);
      return took.changes === 1 ? 'takeover' : 'contested';
    }
    return 'contested';
  }

  heartbeatDrain(repo: string, holderId: string, nowMs: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE merge_queue_drain_locks SET heartbeat_at = ?
         WHERE repo_path = ? AND holder_id = ?`,
      )
      .run(nowMs, repo, holderId);
    return r.changes === 1;
  }

  releaseDrain(repo: string, holderId: string): void {
    this.db
      .prepare('DELETE FROM merge_queue_drain_locks WHERE repo_path = ? AND holder_id = ?')
      .run(repo, holderId);
  }
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

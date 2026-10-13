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
  constructor(private readonly db: DatabaseSync) {}

  save(entry: MergeQueueEntry): void {
    const updated = this.db
      .prepare(
        `UPDATE merge_queue_entries SET
           repo_path=?, pr_id=?, task_id=?, source_branch=?, target_branch=?,
           status=?, position=?, enqueued_by=?, enqueued_at=?, processed_at=?,
           base_sha=?, candidate_sha=?, candidate_tree_oid=?, target_sha=?,
           diff_hash=?, artifact_digest=?, verification=?, failure_reason=?,
           merge_commit_sha=?, decision_audit_ref=?
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
              merge_commit_sha, decision_audit_ref)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        );
    }
  }

  load(repo: string): MergeQueueEntry[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM merge_queue_entries WHERE repo_path = ? ORDER BY position',
      )
      .all(repo) as unknown as Record<string, unknown>[];
    return rows.map((r) => structuredClone(rowToEntry(r)));
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

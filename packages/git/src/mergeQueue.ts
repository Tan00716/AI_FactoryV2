/**
 * Merge Queue — spec §36 ("用 Merge Queue/合并候选验证处理'PR 都测试
 * 通过，但合并一起失败'": use a merge queue / merge-candidate
 * verification for the case where every PR passes its own tests but
 * they fail merged together).
 *
 * The failure this prevents: PR-A and PR-B each merge cleanly into the
 * target branch ON THEIR OWN, but once A has landed, B conflicts. A
 * direct merge discovers that only at merge time — halfway through,
 * with the repository left mid-merge. The queue instead:
 *
 *   1. takes PRs strictly one at a time, in enqueue order, per repo;
 *   2. for the head PR, assembles a MERGE CANDIDATE against the CURRENT
 *      target tip (which already contains every previously queued
 *      merge) and verifies the candidate BEFORE anything lands —
 *      built-in conflict detection via `git merge-tree --write-tree`
 *      (no working-tree contact), plus any injected verifier (the
 *      host's test command, StepFn-style);
 *   3. only a verified candidate is really merged; the merge records
 *      the five §36 fields (Base/Candidate/Target SHA, Diff Hash,
 *      Artifact Digest) on the queue entry;
 *   4. a candidate that fails verification is dequeued as FAILED with
 *      the reason recorded, and the queue CONTINUES with the next
 *      entry — one bad PR never swallows the entries behind it, but
 *      it never lands either. (SPEC §36 does not state whether a
 *      failure halts the queue; "fail → dequeue + record + continue"
 *      is the recorded choice: the queue's job is to keep verified
 *      work landing, and the failed PR stays OPEN for its author.)
 *
 * State is IN-PROCESS (a Map/array inside the instance), deliberately
 * consistent with PrStore — the PR records this queue consumes are
 * themselves in-memory in this codebase (see evidence.ts: "In-memory
 * PR store (prototype…)"). Queue entries are lost on restart exactly
 * like PR records are; no db table is invented ahead of the PR store's
 * own persistence.
 *
 * §36 also requires the current Candidate's Gate for a Protected
 * Branch Merge: on this path the candidate verification above IS that
 * gate — nothing merges into any branch through the queue unverified.
 */

import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { GitRepo, type GitAuditHook } from './git';
import type { PrRecord, PrStore } from './evidence';

export type MergeQueueEntryStatus = 'QUEUED' | 'VERIFYING' | 'MERGED' | 'FAILED';

/** One verification check on a merge candidate. SKIPPED is a recorded
 *  outcome, never a silent pass (§38: skipped does not count as PASS —
 *  the overall verdict only requires no FAIL among the checks that the
 *  gate defines as mandatory, and the conflict check is always one). */
export interface MergeQueueCheck {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  detail: string;
}

export interface MergeCandidateVerification {
  checks: MergeQueueCheck[];
  /** Files the candidate would leave unmerged (from the preview). */
  conflicts: string[];
  verifiedAt: string;
}

/**
 * Injected candidate verifier — the host's extra validation beyond the
 * built-in conflict check (typically: run the test suite against the
 * candidate). StepFn-style: receives the assembled candidate, returns a
 * verdict with a human-readable detail. Never invoked when the
 * candidate already conflicts.
 */
export type MergeCandidateVerifier = (info: {
  repo: GitRepo;
  pr: PrRecord;
  candidate: {
    /** Target branch tip the candidate is assembled against. */
    baseSha: string;
    /** Source branch tip (the candidate's change). */
    candidateSha: string;
    /** Tree OID of the would-be merged tree (merge-tree preview). */
    candidateTreeOid: string | null;
  };
}) => Promise<{ ok: boolean; detail: string }>;

export interface MergeQueueEntry {
  id: string;
  /** Repository path this entry belongs to (the queue's repo). */
  repo: string;
  prId: string;
  taskId: string;
  sourceBranch: string;
  targetBranch: string;
  status: MergeQueueEntryStatus;
  /** 1-based enqueue order within this queue; processing is FIFO. */
  position: number;
  enqueuedBy: string;
  enqueuedAt: string;
  processedAt: string | null;
  /* ---- §36 change-evidence fields (null until the candidate is
   * assembled / the merge lands; never invented) ---- */
  /** Target tip when the candidate was assembled. */
  baseSha: string | null;
  /** Source branch tip. */
  candidateSha: string | null;
  /** Tree OID of the would-be merge result (candidate identity). */
  candidateTreeOid: string | null;
  /** Target tip after the merge (== baseSha when nothing landed). */
  targetSha: string | null;
  /** sha256 of the landed base→target diff (merged) or of the proposed
   *  base→candidate diff (failed candidate). */
  diffHash: string | null;
  /** A merge produces no build artifact — always null ('no artifact'). */
  artifactDigest: string | null;
  verification: MergeCandidateVerification | null;
  /** Why a FAILED entry failed (conflicts or verifier verdict). */
  failureReason: string | null;
  /** The merge commit sha when MERGED (== targetSha). */
  mergeCommitSha: string | null;
}

/** Per-call hooks: hosts whose audit/evidence context is per-request
 *  (the HTTP server) pass these to processNext/processAll; embedders
 *  may instead fix them in the constructor options. */
export interface MergeQueueHooks {
  audit?: GitAuditHook;
  /** Invoked after an entry lands (PR already marked MERGED). */
  onMerged?: (entry: MergeQueueEntry, pr: PrRecord) => void;
}

export interface MergeQueueOptions extends MergeQueueHooks {
  /** PR store to read records from / mark MERGED in. Optional: without
   *  it the queue still verifies and merges branches, it just cannot
   *  update PR records. */
  prs?: PrStore;
  /** Extra candidate verifier beyond conflict detection. */
  verify?: MergeCandidateVerifier;
  /** Label for the injected verifier's check. Default 'tests'. */
  verifierName?: string;
}

export class MergeQueue {
  /** Repository path this queue serializes merges for. */
  readonly repoPath: string;
  private readonly repo: GitRepo;
  private readonly prs?: PrStore;
  private readonly verify?: MergeCandidateVerifier;
  private readonly verifierName: string;
  private readonly hooks: MergeQueueHooks;
  private readonly entries: MergeQueueEntry[] = [];
  /** Serializes processing: drains chain onto this promise. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(repoPath: string, opts: MergeQueueOptions = {}) {
    this.repoPath = repoPath;
    this.repo = new GitRepo(repoPath);
    this.prs = opts.prs;
    this.verify = opts.verify;
    this.verifierName = opts.verifierName ?? 'tests';
    this.hooks = { audit: opts.audit, onMerged: opts.onMerged };
  }

  /**
   * Queue a PR for verified merging. The PR must be OPEN and must not
   * already have an active (QUEUED/VERIFYING) entry. Returns a copy of
   * the new entry; nothing is merged yet — see processNext/processAll.
   */
  enqueue(pr: PrRecord, actor: string): MergeQueueEntry {
    if (pr.status !== 'OPEN') {
      throw new Error(`cannot enqueue PR ${pr.id}: status is ${pr.status}, not OPEN`);
    }
    const active = this.entries.find(
      (e) => e.prId === pr.id && (e.status === 'QUEUED' || e.status === 'VERIFYING'),
    );
    if (active) {
      throw new Error(`PR ${pr.id} is already in the merge queue (entry ${active.id})`);
    }
    const entry: MergeQueueEntry = {
      id: randomUUID(),
      repo: this.repoPath,
      prId: pr.id,
      taskId: pr.taskId,
      sourceBranch: pr.sourceBranch,
      targetBranch: pr.targetBranch,
      status: 'QUEUED',
      position: this.entries.length + 1,
      enqueuedBy: actor,
      enqueuedAt: new Date().toISOString(),
      processedAt: null,
      baseSha: null,
      candidateSha: null,
      candidateTreeOid: null,
      targetSha: null,
      diffHash: null,
      artifactDigest: null,
      verification: null,
      failureReason: null,
      mergeCommitSha: null,
    };
    this.entries.push(entry);
    this.hooks.audit?.('GIT_MERGE_QUEUE_ENQUEUED', {
      repo: this.repoPath,
      entryId: entry.id,
      prId: pr.id,
      taskId: pr.taskId,
      position: entry.position,
    });
    return structuredClone(entry);
  }

  /** All entries in enqueue order (copies). */
  list(): MergeQueueEntry[] {
    return this.entries.map((e) => structuredClone(e));
  }

  /** One entry by id, or undefined. */
  get(id: string): MergeQueueEntry | undefined {
    const e = this.entries.find((x) => x.id === id);
    return e ? structuredClone(e) : undefined;
  }

  /**
   * Process the head QUEUED entry, if any: assemble + verify its
   * candidate against the CURRENT target tip, then merge only on a
   * passing verdict. Returns the processed entry (copy), or null when
   * the queue has nothing waiting. Serialized against other
   * processNext/processAll calls.
   */
  processNext(hooks: MergeQueueHooks = {}): Promise<MergeQueueEntry | null> {
    const run = this.tail.then(() => this.processOne(hooks));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Drain every QUEUED entry, in FIFO order. Returns the processed
   *  entries (copies) in processing order. */
  processAll(hooks: MergeQueueHooks = {}): Promise<MergeQueueEntry[]> {
    const run = this.tail.then(async () => {
      const done: MergeQueueEntry[] = [];
      for (;;) {
        const entry = await this.processOne(hooks);
        if (!entry) return done;
        done.push(entry);
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async processOne(hooks: MergeQueueHooks): Promise<MergeQueueEntry | null> {
    const entry = this.entries.find((e) => e.status === 'QUEUED');
    if (!entry) return null;
    const audit = hooks.audit ?? this.hooks.audit;
    const onMerged = hooks.onMerged ?? this.hooks.onMerged;
    const pr = this.prs ? this.prs.get(entry.prId) : undefined;
    const prRecord: PrRecord =
      pr ??
      ({
        id: entry.prId,
        taskId: entry.taskId,
        sourceBranch: entry.sourceBranch,
        targetBranch: entry.targetBranch,
        title: '',
        status: 'OPEN',
        commits: [],
        createdBy: entry.enqueuedBy,
        createdAt: entry.enqueuedAt,
        mergedAt: null,
      } satisfies PrRecord);

    entry.status = 'VERIFYING';
    try {
      // --- assemble the candidate against the CURRENT target tip ---
      const baseSha = await this.repo.resolveRef(entry.targetBranch);
      const candidateSha = await this.repo.resolveRef(entry.sourceBranch);
      const preview = await this.repo.mergePreview(entry.targetBranch, entry.sourceBranch);
      entry.baseSha = baseSha;
      entry.candidateSha = candidateSha;
      entry.candidateTreeOid = preview.treeOid;
      entry.targetSha = baseSha; // nothing has landed yet

      // --- verify the candidate BEFORE anything merges ---
      const checks: MergeQueueCheck[] = [];
      if (preview.clean) {
        checks.push({
          name: 'conflict',
          status: 'PASS',
          detail: `candidate merges cleanly into ${entry.targetBranch} @ ${baseSha.slice(0, 8)}`,
        });
      } else {
        checks.push({
          name: 'conflict',
          status: 'FAIL',
          detail: `candidate conflicts with current ${entry.targetBranch} in: ${preview.conflicts.join(', ')}`,
        });
      }
      let verifierOk = true;
      if (!preview.clean) {
        checks.push({
          name: this.verifierName,
          status: 'SKIPPED',
          detail: 'not run: candidate has conflicts',
        });
      } else if (this.verify) {
        const verdict = await this.verify({
          repo: this.repo,
          pr: prRecord,
          candidate: { baseSha, candidateSha, candidateTreeOid: preview.treeOid },
        });
        verifierOk = verdict.ok;
        checks.push({
          name: this.verifierName,
          status: verdict.ok ? 'PASS' : 'FAIL',
          detail: verdict.detail,
        });
      } else {
        checks.push({
          name: this.verifierName,
          status: 'SKIPPED',
          detail: 'no candidate verifier configured — conflict check only',
        });
      }
      entry.verification = {
        checks,
        conflicts: preview.conflicts,
        verifiedAt: new Date().toISOString(),
      };

      const verified = preview.clean && verifierOk;
      if (!verified) {
        entry.status = 'FAILED';
        entry.failureReason = !preview.clean
          ? `merge candidate conflicts with current ${entry.targetBranch} in: ${preview.conflicts.join(', ')}`
          : `${this.verifierName} verification failed for merge candidate`;
        entry.diffHash = await this.proposedDiffHash(baseSha, candidateSha);
        entry.processedAt = new Date().toISOString();
        audit?.('GIT_MERGE_QUEUE_FAILED', {
          repo: this.repoPath,
          entryId: entry.id,
          prId: entry.prId,
          taskId: entry.taskId,
          reason: entry.failureReason,
          conflicts: preview.conflicts,
        });
        return structuredClone(entry);
      }

      // --- verified: land the real merge ---
      await this.repo.checkout(entry.targetBranch, { audit });
      const result = await this.repo.merge(entry.sourceBranch, { audit });
      if (!result.ok) {
        // The tree moved between preview and merge (someone merged
        // outside the queue). Same honesty as the direct path: record
        // the failure; the working tree is left mid-merge exactly as
        // GitRepo.merge leaves it, for a human to resolve.
        entry.status = 'FAILED';
        entry.failureReason =
          `merge conflicted at merge time (target moved after verification): ${result.conflicts.join(', ')}`;
        entry.verification = {
          checks,
          conflicts: result.conflicts,
          verifiedAt: entry.verification.verifiedAt,
        };
        entry.processedAt = new Date().toISOString();
        audit?.('GIT_MERGE_QUEUE_FAILED', {
          repo: this.repoPath,
          entryId: entry.id,
          prId: entry.prId,
          taskId: entry.taskId,
          reason: entry.failureReason,
          conflicts: result.conflicts,
        });
        return structuredClone(entry);
      }

      const evidence = result.evidence;
      entry.baseSha = evidence?.baseSha ?? baseSha;
      entry.candidateSha = evidence?.candidateSha ?? candidateSha;
      entry.targetSha = evidence?.targetSha ?? null;
      entry.diffHash = evidence?.diffHash ?? null;
      entry.artifactDigest = evidence?.artifactDigest ?? null;
      entry.mergeCommitSha = evidence?.targetSha ?? null;
      entry.status = 'MERGED';
      entry.processedAt = new Date().toISOString();
      if (this.prs) this.prs.updateStatus(entry.prId, 'MERGED');
      audit?.('GIT_MERGE_QUEUE_MERGED', {
        repo: this.repoPath,
        entryId: entry.id,
        prId: entry.prId,
        taskId: entry.taskId,
        mergeCommitSha: entry.mergeCommitSha,
      });
      onMerged?.(structuredClone(entry), this.prs ? this.prs.get(entry.prId) : prRecord);
      return structuredClone(entry);
    } catch (err) {
      // Operational failure (missing branch, git error, …): the entry
      // is FAILED with the real error recorded — never silently dropped.
      entry.status = 'FAILED';
      entry.failureReason = err instanceof Error ? err.message : String(err);
      entry.processedAt = new Date().toISOString();
      audit?.('GIT_MERGE_QUEUE_FAILED', {
        repo: this.repoPath,
        entryId: entry.id,
        prId: entry.prId,
        taskId: entry.taskId,
        reason: entry.failureReason,
        conflicts: [],
      });
      return structuredClone(entry);
    }
  }

  /** sha256 of the diff the candidate PROPOSES (base → source tip);
   *  recorded on failed candidates, where no landed diff exists. */
  private async proposedDiffHash(baseSha: string, candidateSha: string): Promise<string | null> {
    try {
      const diff = await this.repo.diffBetween(baseSha, candidateSha);
      return createHash('sha256').update(diff).digest('hex');
    } catch {
      return null;
    }
  }
}

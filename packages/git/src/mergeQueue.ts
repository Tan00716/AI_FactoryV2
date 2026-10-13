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
 * State is IN-PROCESS by default (an array inside the instance). With a
 * MergeQueueEntryPersistence (Batch 20, @ai-factory/db), every mutation
 * is written through the moment it happens and hydrate() rebuilds the
 * queue after a restart: VERIFYING rows come back QUEUED (a verification
 * that died mid-flight is re-run, never trusted), MERGED/FAILED rows
 * are history. Without persistence the Batch 16 behavior stands: state
 * is lost on restart.
 *
 * §36 also requires the current Candidate's Gate for a Protected
 * Branch Merge: on this path the candidate verification above IS that
 * gate — nothing merges into any branch through the queue unverified.
 */

import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { GitRepo, type GitAuditHook } from './git';
import type { PrRecord, PrStoreApi } from './evidence';

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
  /**
   * Audit-log id of the terminal decision event (GIT_MERGE_QUEUE_MERGED /
   * GIT_MERGE_QUEUE_FAILED) for this entry. Filled by the host after the
   * decision is audited — null when the host did not resolve it. The
   * decision itself is always auditable by entryId without this field.
   */
  decisionAuditRef: string | null;
  /**
   * Cross-process drain claim (Batch 23). When set, the named process
   * (its claim token) owns this entry's drain turn: no other process may
   * start processing it until the claim expires (claimedAt + the queue's
   * claimTtlMs). Terminal rows keep the claim as the record of who
   * processed them. hydrate() never clears a live claim — a crashed
   * holder's claim expires by TTL; clearing it early would let a
   * restarting process steal an entry a live peer is still merging.
   */
  claimedBy: string | null;
  /** ISO-8601 time the claim was taken (null when unclaimed). */
  claimedAt: string | null;
}

/**
 * Durable backing for queue entries (Batch 20). The queue's operational
 * state stays in memory, but every mutation is written through via save()
 * the moment it happens, and hydrate() rebuilds the in-memory state from
 * load() after a restart. The seam is synchronous: node:sqlite writes are
 * sync, and the queue never wants a mutation to be "pending" across a
 * crash — a VERIFYING row that never reached a terminal state is the
 * honest crash evidence hydrate() demotes back to QUEUED.
 *
 * Implementations must reject a second ACTIVE (QUEUED/VERIFYING) row for
 * the same prId — e.g. a partial unique index — so cross-process
 * double-enqueue cannot slip past the queue's in-memory check.
 */
export interface MergeQueueEntryPersistence {
  save(entry: MergeQueueEntry): void;
  /** All entries for one repo, in enqueue (position) order. */
  load(repo: string): MergeQueueEntry[];
  /**
   * Atomically claim a QUEUED entry for draining (Batch 23, optional).
   * Returns true iff this caller now holds the claim: the row is QUEUED
   * and (unclaimed, already claimed by `token`, or claimed earlier than
   * now - ttlMs). The check-and-set must be atomic in the backing store
   * (single UPDATE … WHERE) so two processes cannot both win.
   * Backings without this method keep the old behavior: in-process
   * tail-chain serialization only, cross-process drain unsafe.
   */
  tryClaim?(id: string, token: string, ttlMs: number): boolean;
  /**
   * Cross-process drain mutual exclusion (Batch 23, optional). The
   * per-entry tryClaim above stops two processes from working the SAME
   * entry, but it still lets two processes drain DIFFERENT entries of
   * one repo concurrently — which breaks the queue's core §36 invariant
   * (entries verified strictly one at a time, each against the tip that
   * already contains every previously queued merge). When present, the
   * queue takes this repo-level lease before each processOne: only one
   * drainer per repo at a time. A contested drain yields loudly
   * (audited MERGE_QUEUE_DRAIN_CONTESTED) instead of double-draining.
   * When absent, cross-process drain stays unsafe (documented).
   */
  drainLock?: MergeQueueDrainLock;
}

/**
 * Cross-process drain mutual exclusion for one repo (Batch 23).
 *
 * The lock is a lease row: the holder refreshes `heartbeatAt` at every
 * drain progress point; a contender that finds a heartbeat older than
 * `ttlMs` may take over (the previous holder is dead or wedged —
 * takeover is audited and the new holder re-hydrates honestly before
 * processing). A contender that finds a LIVE heartbeat yields loudly
 * instead of touching the queue.
 *
 * Implementations must make acquireDrain's check-and-set atomic (a
 * single conditional UPDATE) so two contenders cannot both believe
 * they won the takeover.
 */
export type DrainAcquireResult = 'acquired' | 'contested' | 'takeover';

export interface MergeQueueDrainLockState {
  holderId: string;
  /** ms epoch when the current holder took the lock. */
  claimedAt: number;
  /** ms epoch of the holder's last heartbeat. */
  heartbeatAt: number;
}

export interface MergeQueueDrainLock {
  /**
   * Try to become the drainer for `repo`. Returns 'acquired' (lock was
   * free), 'takeover' (previous heartbeat was stale — caller must
   * re-hydrate before processing), or 'contested' (a live holder owns
   * the repo — caller must yield without touching the queue).
   */
  acquireDrain(repo: string, holderId: string, nowMs: number, ttlMs: number): DrainAcquireResult;
  /**
   * Refresh the heartbeat. Returns false when this holder no longer
   * owns the lock (lost to a takeover) — the caller must stop writing.
   */
  heartbeatDrain(repo: string, holderId: string, nowMs: number): boolean;
  /** Release the lock; only releases when `holderId` still owns it. */
  releaseDrain(repo: string, holderId: string): void;
  /** Current lock row, or null when no drainer holds the repo. */
  drainState(repo: string): MergeQueueDrainLockState | null;
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
   *  update PR records. Accepts the in-memory PrStore or the durable
   *  SqlitePrStore from @ai-factory/db (structural contract). */
  prs?: PrStoreApi;
  /** Extra candidate verifier beyond conflict detection. */
  verify?: MergeCandidateVerifier;
  /** Label for the injected verifier's check. Default 'tests'. */
  verifierName?: string;
  /**
   * Durable entry backing (Batch 20). Without it the queue is exactly
   * what Batch 16 shipped: in-process state, lost on restart. With it,
   * call hydrate() once after construction to rebuild from load().
   */
  persistence?: MergeQueueEntryPersistence;
  /**
   * How long a drain claim stays valid (Batch 23). A crashed holder's
   * entry becomes claimable again after this long; a live holder
   * finishes merges far faster. Set it above your longest injected
   * verifier runtime. Default 5 minutes.
   */
  claimTtlMs?: number;
  /**
   * How long a drain-lock heartbeat stays valid (Batch 23). A holder
   * that stops heartbeating for longer than this is presumed dead or
   * wedged and its lock may be taken over. Heartbeats are refreshed at
   * every drain progress point, so set this above the longest gap
   * between progress points — in practice, above your longest injected
   * verifier runtime. Default 2 minutes.
   */
  drainLockTtlMs?: number;
  /** Clock for drain-lock timestamps (Batch 23). Default Date. */
  clock?: { now(): number };
}

/** Default drain-claim lease (Batch 23). */
export const DEFAULT_CLAIM_TTL_MS = 5 * 60 * 1000;

/** Default drain-lock heartbeat TTL (Batch 23). */
export const DEFAULT_DRAIN_LOCK_TTL_MS = 2 * 60 * 1000;

export class MergeQueue {
  /** Repository path this queue serializes merges for. */
  readonly repoPath: string;
  private readonly repo: GitRepo;
  private readonly prs?: PrStoreApi;
  private readonly verify?: MergeCandidateVerifier;
  private readonly verifierName: string;
  private readonly hooks: MergeQueueHooks;
  private readonly persistence?: MergeQueueEntryPersistence;
  private readonly entries: MergeQueueEntry[] = [];
  /** Next enqueue position; advanced by hydrate() past restored rows. */
  private nextPosition = 1;
  /** Serializes processing: drains chain onto this promise. */
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * This instance's drain-claim identity (Batch 23): a random token so
   * two processes' claims are distinguishable in the shared backing.
   */
  private readonly claimToken: string = randomUUID();
  /** Lease length for drain claims (see MergeQueueOptions.claimTtlMs). */
  private readonly claimTtlMs: number;
  /** Heartbeat TTL for the cross-process drain lock (Batch 23). */
  private readonly drainLockTtlMs: number;
  /** Clock for drain-lock timestamps (Batch 23). */
  private readonly clock: { now(): number };

  constructor(repoPath: string, opts: MergeQueueOptions = {}) {
    this.repoPath = repoPath;
    this.repo = new GitRepo(repoPath);
    this.prs = opts.prs;
    this.verify = opts.verify;
    this.verifierName = opts.verifierName ?? 'tests';
    this.persistence = opts.persistence;
    this.claimTtlMs = opts.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.drainLockTtlMs = opts.drainLockTtlMs ?? DEFAULT_DRAIN_LOCK_TTL_MS;
    this.clock = opts.clock ?? Date;
    this.hooks = { audit: opts.audit, onMerged: opts.onMerged };
  }

  /**
   * Rebuild in-memory state from the durable backing after a restart
   * (Batch 20). Honest crash semantics:
   *  - QUEUED rows come back QUEUED (position preserved);
   *  - VERIFYING rows come back QUEUED — the queue cannot pretend a
   *    verification that died mid-flight completed; each demotion is
   *    audited as MERGE_QUEUE_REHYDRATED and the entry is re-verified
   *    from a freshly assembled candidate on the next process call
   *    (the stored verification snapshot is display-only history);
   *  - MERGED / FAILED rows are history: listed, never reprocessed.
   * Idempotent: rows already present in memory are not duplicated.
   */
  hydrate(): void {
    if (!this.persistence) return;
    const rows = this.persistence.load(this.repoPath);
    const known = new Set(this.entries.map((e) => e.id));
    // Batch 23: when a live drainer holds this repo's drain lock, its
    // VERIFYING rows are being worked RIGHT NOW — demoting them would
    // let this process steal an in-flight merge. Defer the demotion;
    // the rows stay VERIFYING in memory and are skipped by claim logic.
    const drainLockLive = this.drainLockLive();
    const deferred: string[] = [];
    for (const row of rows) {
      if (known.has(row.id)) continue;
      const entry = structuredClone(row);
      if (entry.position >= this.nextPosition) {
        this.nextPosition = entry.position + 1;
      }
      if (entry.status === 'VERIFYING') {
        if (drainLockLive) {
          deferred.push(entry.id);
          this.entries.push(entry);
          known.add(entry.id);
          continue;
        }
        // Batch 23: only demote when no live process owns the row. A
        // fresh claim means a peer is still working it — demoting (and
        // clearing the claim) would let this process steal an entry
        // that is being merged right now. An expired claim means the
        // holder died: demote, clear the stale claim, re-audit.
        const liveClaim =
          entry.claimedBy !== null &&
          entry.claimedAt !== null &&
          Date.now() - Date.parse(entry.claimedAt) < this.claimTtlMs;
        if (!liveClaim) {
          entry.status = 'QUEUED';
          entry.claimedBy = null;
          entry.claimedAt = null;
          this.persist(entry);
          this.hooks.audit?.('MERGE_QUEUE_REHYDRATED', {
            repo: this.repoPath,
            entryId: entry.id,
            prId: entry.prId,
            taskId: entry.taskId,
            fromStatus: 'VERIFYING',
            toStatus: 'QUEUED',
          });
        }
      }
      this.entries.push(entry);
      known.add(entry.id);
    }
    if (deferred.length > 0) {
      this.hooks.audit?.('MERGE_QUEUE_REHYDRATED_DEFERRED', {
        repo: this.repoPath,
        entryIds: deferred,
        note: 'a live drainer holds this repo; VERIFYING rows left untouched',
      });
    }
  }

  /**
   * True when another (or this) drainer currently holds this repo's
   * drain lock with a fresh heartbeat (Batch 23). Used to avoid
   * stealing in-flight work during hydrate().
   */
  private drainLockLive(): boolean {
    const lock = this.persistence?.drainLock;
    if (!lock) return false;
    const state = lock.drainState(this.repoPath);
    return !!state && this.clock.now() - state.heartbeatAt <= this.drainLockTtlMs;
  }

  /**
   * Write one entry's current state through to the durable backing.
   * A duplicate-active-entry rejection from the backing (partial
   * unique index) surfaces as the same domain error as the in-memory
   * check, so cross-process double-enqueue answers identically.
   */
  private persist(entry: MergeQueueEntry): void {
    if (!this.persistence) return;
    try {
      this.persistence.save(structuredClone(entry));
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
        throw new Error(
          `PR ${entry.prId} is already in the merge queue (entry ${entry.id})`,
        );
      }
      throw e;
    }
  }

  /**
   * Record the audit-log id of this entry's terminal decision event.
   * The host resolves it (the decision event is already audited with
   * the entryId in its details); the queue only stores the reference.
   */
  setDecisionAuditRef(entryId: string, auditId: string): void {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`merge queue entry not found: ${entryId}`);
    entry.decisionAuditRef = auditId;
    this.persist(entry);
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
      position: this.nextPosition,
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
      decisionAuditRef: null,
      claimedBy: null,
      claimedAt: null,
    };
    // Persist BEFORE the in-memory push: a cross-process duplicate is
    // rejected by the backing's partial unique index and must surface
    // as a 409, not as a row this process already believes it owns.
    // nextPosition advances only on success, so a rejected duplicate
    // does not burn a position number.
    this.persist(entry);
    this.nextPosition = entry.position + 1;
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
   * Take the first QUEUED entry this process may drain (Batch 23).
   * Without a persistence tryClaim the head QUEUED entry wins (the old
   * behavior — in-process tail-chain serialization only). With one, each
   * QUEUED entry is atomically claimed first: entries owned by a live
   * peer are skipped, the first claimable entry is taken and stamped
   * with this instance's claim token. Returns null when nothing is
   * claimable right now. Skipped entries stay in the list — a peer's
   * claim expiring (or its row reaching a terminal status, which the
   * claim's status check enforces) makes them claimable on a later
   * drain; nothing is dropped.
   */
  private claimNextQueued(): MergeQueueEntry | null {
    for (const entry of this.entries) {
      if (entry.status !== 'QUEUED') continue;
      if (this.persistence?.tryClaim) {
        if (!this.persistence.tryClaim(entry.id, this.claimToken, this.claimTtlMs)) {
          continue;
        }
        entry.claimedBy = this.claimToken;
        entry.claimedAt = new Date().toISOString();
      }
      return entry;
    }
    return null;
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

  /**
   * Re-read the shared backing and reconcile in-memory state (Batch 23).
   * Called with the drain lock held at the start of each processOne:
   *  - rows other processes enqueued (or finished) since our last sync
   *    are picked up, so a drainer never starves work it cannot see;
   *  - known rows adopt the backing store's truth for non-terminal
   *    states (a terminal in-memory state is never regressed — our own
   *    terminal write is final).
   */
  private refreshFromPersistence(): void {
    if (!this.persistence) return;
    const rows = this.persistence.load(this.repoPath);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const fresh = byId.get(entry.id);
      if (!fresh) continue;
      if (entry.status === 'MERGED' || entry.status === 'FAILED') continue;
      if (fresh.status !== entry.status || fresh.claimedBy !== entry.claimedBy) {
        this.entries[i] = structuredClone(fresh);
      }
    }
    const known = new Set(this.entries.map((e) => e.id));
    for (const row of rows) {
      if (known.has(row.id)) continue;
      if (row.position >= this.nextPosition) {
        this.nextPosition = row.position + 1;
      }
      this.entries.push(structuredClone(row));
      known.add(row.id);
    }
  }

  /**
   * Crash recovery after a drain-lock takeover (Batch 23): rows the
   * dead holder left VERIFYING go back to QUEUED with their claims
   * cleared, each audited. Only rows still VERIFYING in the backing
   * store are demoted — a row the dead holder already finished keeps
   * its terminal state and is never resurrected. Callers must
   * refreshFromPersistence() first so memory matches the store.
   */
  private demoteAbandoned(audit?: GitAuditHook): void {
    for (const entry of this.entries) {
      if (entry.status !== 'VERIFYING') continue;
      entry.status = 'QUEUED';
      entry.claimedBy = null;
      entry.claimedAt = null;
      this.persist(entry);
      audit?.('MERGE_QUEUE_REHYDRATED', {
        repo: this.repoPath,
        entryId: entry.id,
        prId: entry.prId,
        taskId: entry.taskId,
        fromStatus: 'VERIFYING',
        toStatus: 'QUEUED',
      });
    }
  }

  /** Refresh the drain-lock heartbeat (Batch 23); no-op without a lock. */
  private heartbeat(holderId: string | null): void {
    const drain = this.persistence?.drainLock;
    if (drain && holderId) drain.heartbeatDrain(this.repoPath, holderId, this.clock.now());
  }

  /**
   * True when this instance still owns the drain lock (Batch 23).
   * Heartbeats first, then re-reads the lock row: a false means a
   * takeover stole the lock while we were inside a slow verifier, and
   * the caller must stop writing immediately to avoid double-processing.
   */
  private stillDrainOwner(holderId: string | null): boolean {
    const drain = this.persistence?.drainLock;
    if (!drain || !holderId) return true;
    this.heartbeat(holderId);
    return drain.drainState(this.repoPath)?.holderId === holderId;
  }

  private async processOne(hooks: MergeQueueHooks): Promise<MergeQueueEntry | null> {
    const audit = hooks.audit ?? this.hooks.audit;
    const onMerged = hooks.onMerged ?? this.hooks.onMerged;
    const drain = this.persistence?.drainLock;
    let holderId: string | null = null;

    // --- Batch 23: cross-process drain mutual exclusion. Only one
    // drainer per repo at a time; a contested drain yields loudly
    // (audited) instead of double-draining. ---
    if (drain) {
      holderId = randomUUID();
      const acquired = drain.acquireDrain(
        this.repoPath,
        holderId,
        this.clock.now(),
        this.drainLockTtlMs,
      );
      if (acquired === 'contested') {
        const live = drain.drainState(this.repoPath);
        audit?.('MERGE_QUEUE_DRAIN_CONTESTED', {
          repo: this.repoPath,
          holderId,
          liveHolderId: live?.holderId ?? null,
          note: 'another drainer holds this repo; yielding without touching the queue',
        });
        return null;
      }
      // Re-read shared state now that we serialize the repo: pick up
      // entries other processes enqueued and rows peers finished.
      this.refreshFromPersistence();
      if (acquired === 'takeover') {
        audit?.('MERGE_QUEUE_DRAIN_TAKEOVER', {
          repo: this.repoPath,
          holderId,
          note: 'previous drain lock was stale; taking over after honest re-hydration',
        });
        this.demoteAbandoned(audit);
      }
      this.heartbeat(holderId);
    }

    const release = () => {
      if (drain && holderId) drain.releaseDrain(this.repoPath, holderId);
    };

    // Batch 23: declared outside the try so the catch block can mark a
    // claimed entry FAILED on operational errors (never silently dropped).
    // Null only when claimNextQueued itself threw — then there is no
    // entry to fail, and the error propagates after release().
    let entry: MergeQueueEntry | null = null;
    try {
      entry = this.claimNextQueued();
      if (!entry) return null;
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
    this.persist(entry);
    // Batch 23: the claim is written through — refresh the lease so a
    // slow peer never mistakes this live drain for a dead one.
    this.heartbeat(holderId);
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
      // Batch 23: the injected verifier is the long pole of a drain. If
      // a takeover stole our lock while we were inside it, the new
      // holder has re-hydrated and may already be processing this entry
      // — abort before merging rather than double-processing. Our
      // in-memory entry is stale (the new holder owns the DB row), so
      // drop it; the next refreshFromPersistence() re-reads the truth.
      if (!this.stillDrainOwner(holderId)) {
        audit?.('MERGE_QUEUE_DRAIN_LOST', {
          repo: this.repoPath,
          entryId: entry.id,
          prId: entry.prId,
          taskId: entry.taskId,
          note: 'drain lock lost during candidate verification; aborting before merge to avoid double-processing',
        });
        const ix = this.entries.indexOf(entry);
        if (ix >= 0) this.entries.splice(ix, 1);
        return null;
      }
      entry.verification = {
        checks,
        conflicts: preview.conflicts,
        verifiedAt: new Date().toISOString(),
      };
      // Written through BEFORE the verdict: a crash between verification
      // and the terminal transition leaves VERIFYING, which hydrate()
      // honestly demotes to QUEUED for a fresh re-verification.
      this.persist(entry);

      const verified = preview.clean && verifierOk;
      if (!verified) {
        entry.status = 'FAILED';
        entry.failureReason = !preview.clean
          ? `merge candidate conflicts with current ${entry.targetBranch} in: ${preview.conflicts.join(', ')}`
          : `${this.verifierName} verification failed for merge candidate`;
        entry.diffHash = await this.proposedDiffHash(baseSha, candidateSha);
        entry.processedAt = new Date().toISOString();
        this.persist(entry);
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
        this.persist(entry);
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
      this.persist(entry);
      audit?.('GIT_MERGE_QUEUE_MERGED', {
        repo: this.repoPath,
        entryId: entry.id,
        prId: entry.prId,
        taskId: entry.taskId,
        mergeCommitSha: entry.mergeCommitSha,
      });
      onMerged?.(structuredClone(entry), this.prs ? this.prs.get(entry.prId) : prRecord);
      // Batch 23: the merge landed — refresh the lease before releasing.
      this.heartbeat(holderId);
      return structuredClone(entry);
    } catch (err) {
      // Operational failure (missing branch, git error, …): the entry
      // is FAILED with the real error recorded — never silently dropped.
      // (If claimNextQueued itself threw, entry is still null: nothing
      // to mark FAILED, so the error propagates after release().)
      if (!entry) throw err;
      entry.status = 'FAILED';
      entry.failureReason = err instanceof Error ? err.message : String(err);
      entry.processedAt = new Date().toISOString();
      this.persist(entry);
      audit?.('GIT_MERGE_QUEUE_FAILED', {
        repo: this.repoPath,
        entryId: entry.id,
        prId: entry.prId,
        taskId: entry.taskId,
        reason: entry.failureReason,
        conflicts: [],
      });
      return structuredClone(entry);
    } finally {
      // Batch 23: always release the drain lease (holder-conditional —
      // a no-op when a takeover already moved it to the new holder).
      release();
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

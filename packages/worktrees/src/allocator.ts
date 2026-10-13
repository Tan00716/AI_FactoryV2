/**
 * Worktree allocator — SPEC v2 §22.1 (G-37, Batch 19).
 *
 * "不同写入任务使用独立 Worktree/Branch 或独立 Clone；一次可写
 * Workspace 一名有效执行 Owner。" — allocate() gives a writing task its
 * own git worktree (branch named `task/<shortid>-<slug>`, the task id
 * embedded and traceable), records the allocation in the worktree
 * store, and release() tears the worktree down and archives the
 * record. Non-Git sources get an honestly labeled 'dir-copy' (§22.1's
 * snapshot/working-copy clause) instead of a fake git worktree.
 *
 * Broker relationship (§36): creating a worktree is classified as the
 * broker's 'worktree' action and ALWAYS carries the task binding — the
 * package default requires it. A denial is zero-side-effect: the
 * branch/worktree is never created. Release is not a separate broker
 * category; the release path is protected by the record itself
 * (the path released must be the path recorded, inside the configured
 * root — see release()), because removal cannot touch shared refs
 * beyond git's own worktree metadata cleanup, and inventing another
 * category would only re-state the same authorization.
 *
 * Honesty notes (also in KNOWN_LIMITATIONS):
 *  - A git worktree shares the repository's common directory, hooks
 *    and refs (§22.1: "不能把 Worktree 宣称为 OS 安全隔离"). This is
 *    per-task filesystem isolation, not a security boundary.
 *  - If the `git` binary is unavailable but the source IS a git repo,
 *    allocation fails closed (WorktreeUnavailableError) — the
 *    allocator refuses to silently downgrade a git repo to a copy.
 *  - One ACTIVE allocation per (repo, task), enforced by the store's
 *    partial unique index; concurrent allocates converge on the
 *    winner (insert → conflict → re-read), pinned by a test.
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  cpSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  GitRepo,
  GitBrokerDeniedError,
  taskBranchName,
  type GitBroker,
  type GitBrokerContext,
} from '@ai-factory/git';
import {
  type WorktreeRecord,
  type WorktreeStore,
  WorktreeConflictError,
  WorktreeNotFoundError,
  WorktreeStateError,
} from '@ai-factory/db';

export type WorktreeAuditHook = (event: string, details: Record<string, unknown>) => void;

export class WorktreeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
  }
}

/** `git` binary missing while the source needs git: fail closed. */
export class WorktreeUnavailableError extends WorktreeError {
  constructor(message: string) {
    super('WORKTREE_GIT_UNAVAILABLE', message);
    this.name = 'WorktreeUnavailableError';
  }
}

/** Release refused: the path on record does not verify. Nothing deleted. */
export class WorktreeReleaseRefusedError extends WorktreeError {
  readonly worktreeId: string;
  constructor(worktreeId: string, message: string) {
    super('WORKTREE_RELEASE_REFUSED', message);
    this.name = 'WorktreeReleaseRefusedError';
    this.worktreeId = worktreeId;
  }
}

export interface AllocateInput {
  /** Source repository (or source directory for dir-copy). */
  repoPath: string;
  /** Owning task — §22.1's single effective Owner. Required. */
  taskId: string;
  projectId?: string | null;
  /** Human title, used for the branch slug. */
  title?: string;
  /** Base ref for the new branch (default HEAD). */
  base?: string;
  /** Identity recorded on the broker decision and audit. */
  actor?: string;
}

export interface AllocateResult {
  record: WorktreeRecord;
  /** True when an existing ACTIVE allocation was returned, not created. */
  reused: boolean;
}

export interface WorktreeAllocatorOptions {
  /** Git Broker gating the 'worktree' action (task-bound). Required. */
  broker: GitBroker;
  store: WorktreeStore;
  /** All worktree directories live under this root. Required. */
  rootDir: string;
  audit?: WorktreeAuditHook;
  now?: () => string;
  /**
   * Injectable git availability probe (default: `git --version`).
   * Injected by tests to simulate a git-less host.
   */
  gitProbe?: () => Promise<boolean>;
  /** Injectable directory copy for dir-copy mode (default fs.cpSync). */
  copyDir?: (src: string, dest: string) => void;
}

const DIR_NAME_RE = /^wt-[a-z0-9][a-z0-9-]{1,63}$/;

function shortTaskId(taskId: string): string {
  const alnum = taskId.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (alnum.slice(0, 8) || 'task').padEnd(4, '0');
}

function defaultGitProbe(): Promise<boolean> {
  return new Promise((res) => {
    execFile('git', ['--version'], (err) => res(!err));
  });
}

/** True when `child` is inside `parent` (both resolved). */
export function pathWithin(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + '/');
}

export class WorktreeAllocator {
  /**
   * In-process keyed mutex: allocate is check-then-act (getActive →
   * git worktree add → insert), which races between two callers in
   * the same process. The lock serializes allocates for the same
   * (repo, task) so the second deterministically takes the idempotent
   * path. Module-level so it is shared across allocator instances
   * (the server builds one per request). Cross-PROCESS races cannot
   * be locked here — they fall back to the store's partial unique
   * index plus the bounded winner re-check in allocate().
   */
  private static readonly keyLocks = new Map<string, Promise<void>>();

  private readonly broker: GitBroker;
  private readonly store: WorktreeStore;
  private readonly root: string;
  private readonly audit?: WorktreeAuditHook;
  private readonly now: () => string;
  private readonly gitProbe: () => Promise<boolean>;
  private readonly copyDir: (src: string, dest: string) => void;

  private static async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = WorktreeAllocator.keyLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mine = prev.then(() => gate);
    WorktreeAllocator.keyLocks.set(key, mine);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (WorktreeAllocator.keyLocks.get(key) === mine) {
        WorktreeAllocator.keyLocks.delete(key);
      }
    }
  }

  constructor(opts: WorktreeAllocatorOptions) {
    if (!opts.broker) throw new WorktreeError('WORKTREE_NO_BROKER', 'a GitBroker is required');
    if (!opts.rootDir) throw new WorktreeError('WORKTREE_NO_ROOT', 'rootDir is required');
    this.broker = opts.broker;
    this.store = opts.store;
    this.root = resolve(opts.rootDir);
    this.audit = opts.audit;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.gitProbe = opts.gitProbe ?? defaultGitProbe;
    this.copyDir =
      opts.copyDir ?? ((src, dest) => cpSync(src, dest, { recursive: true }));
  }

  private dirNameFor(taskId: string, id: string): string {
    return `wt-${shortTaskId(taskId)}-${id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;
  }

  /**
   * Allocate a worktree for (repoPath, taskId). Idempotent: an existing
   * ACTIVE allocation for the pair is returned untouched. Concurrent
   * allocates converge on the winner via the store's conflict → re-read.
   */
  async allocate(input: AllocateInput): Promise<AllocateResult> {
    if (!input.taskId) {
      throw new WorktreeError('WORKTREE_NO_TASK', 'taskId is required: worktrees are task-owned (§22.1)');
    }
    const repoAbs = resolve(input.repoPath);
    if (!existsSync(repoAbs) || !statSync(repoAbs).isDirectory()) {
      throw new WorktreeError('WORKTREE_REPO_NOT_FOUND', `source directory not found: ${input.repoPath}`);
    }

    // Fast path outside the lock; the locked section re-checks.
    const existing = this.store.getActive(repoAbs, input.taskId);
    if (existing) return { record: existing, reused: true };

    return WorktreeAllocator.withKeyLock(`${repoAbs} ${input.taskId}`, () =>
      this.allocateLocked(repoAbs, input),
    );
  }

  private async allocateLocked(repoAbs: string, input: AllocateInput): Promise<AllocateResult> {
    const again = this.store.getActive(repoAbs, input.taskId);
    if (again) return { record: again, reused: true };

    mkdirSync(this.root, { recursive: true });

    const hasGitDir = existsSync(join(repoAbs, '.git'));
    const gitOk = await this.gitProbe();
    if (!gitOk && hasGitDir) {
      // Fail closed: a git repo must not silently become a plain copy.
      throw new WorktreeUnavailableError(
        `git binary unavailable and ${repoAbs} is a git repository; refusing to downgrade to a copy`,
      );
    }

    const repo = new GitRepo(repoAbs);
    // Dir-copy needs no git at all; a git repo without a git binary
    // already failed closed above.
    const isGitRepo = gitOk && (await repo.isGitRepository().catch(() => false));

    const id = randomUUID();
    const dirName = this.dirNameFor(input.taskId, id);
    if (!DIR_NAME_RE.test(dirName)) {
      throw new WorktreeError('WORKTREE_BAD_NAME', `generated directory name failed validation: ${dirName}`);
    }
    const worktreePath = join(this.root, dirName);
    // The name is generated by us and validated above; the join cannot
    // escape the root, but the assertion stays as the invariant.
    if (!pathWithin(this.root, worktreePath)) {
      throw new WorktreeError('WORKTREE_ESCAPE', 'allocated path escapes the worktree root');
    }

    let kind: 'git-worktree' | 'dir-copy';
    let branch: string | null = null;

    if (isGitRepo) {
      kind = 'git-worktree';
      const gitBranch = taskBranchName(input.taskId, input.title ?? 'work');
      branch = gitBranch;
      const ctx: GitBrokerContext = {
        actor: input.actor ?? 'system',
        repo: repoAbs,
        taskId: input.taskId,
        projectId: input.projectId ?? undefined,
        branch: gitBranch,
      };
      // The broker gate runs BEFORE anything touches the repo: a
      // denial throws and the worktree/branch is never created.
      try {
        await this.broker.execute('worktree', ctx, async () => {
          await repo.worktreeAdd(worktreePath, {
            branch: gitBranch,
            base: input.base ?? 'HEAD',
          });
        });
      } catch (e) {
        // A broker denial is final: zero side effects by construction,
        // and it must never be reinterpreted as a race.
        if (e instanceof GitBrokerDeniedError) throw e;
        // The concurrent-allocate race: the winner's branch became
        // visible between our branches() check and our `worktree add
        // -b`. The branch cannot be checked out twice, so the loser
        // must NOT attach — it converges on the winner's record, the
        // same as the store-conflict path below. The in-process lock
        // above already serializes same-process callers; this path is
        // the cross-process fallback, so the winner's insert gets a
        // bounded wait before we give up and rethrow.
        const winner = await this.awaitWinner(repoAbs, input.taskId);
        if (winner) {
          this.audit?.('WORKTREE_ALLOCATE_RACE', {
            repo: repoAbs,
            taskId: input.taskId,
            winner: winner.id,
            loserPath: worktreePath,
          });
          return { record: winner, reused: true };
        }
        throw e;
      }
    } else {
      // §22.1: non-Git projects use a snapshot/working copy — labeled
      // honestly as a downgrade, never as a git worktree.
      kind = 'dir-copy';
      if (existsSync(worktreePath)) {
        throw new WorktreeError('WORKTREE_PATH_TAKEN', `path already exists: ${worktreePath}`);
      }
      this.copyDir(repoAbs, worktreePath);
    }

    try {
      const record = this.store.insert({
        id,
        repoPath: repoAbs,
        branch,
        worktreePath,
        kind,
        taskId: input.taskId,
        projectId: input.projectId ?? null,
        createdAt: this.now(),
      });
      this.audit?.('WORKTREE_ALLOCATED', {
        id,
        repo: repoAbs,
        branch,
        path: worktreePath,
        kind,
        taskId: input.taskId,
        actor: input.actor ?? 'system',
      });
      return { record, reused: false };
    } catch (e) {
      // Lost the race: another allocate won. Clean up OUR side effects
      // (we own nothing else yet) and return the winner.
      if (e instanceof WorktreeConflictError && e.kind === 'active-duplicate') {
        await this.rollbackPartial(repoAbs, kind, branch, worktreePath);
        const winner = this.store.getActive(repoAbs, input.taskId);
        if (winner) {
          this.audit?.('WORKTREE_ALLOCATE_RACE', {
            repo: repoAbs,
            taskId: input.taskId,
            winner: winner.id,
            rolledBack: id,
          });
          return { record: winner, reused: true };
        }
      }
      // Path duplicate (or anything else): remove what we created so
      // the root does not accumulate orphan directories.
      await this.rollbackPartial(repoAbs, kind, branch, worktreePath);
      throw e;
    }
  }

  /**
   * Release a worktree. Verifies the path on record BEFORE deleting
   * anything: it must still be the recorded absolute path, its
   * basename must still match the generated pattern, and it must be
   * inside the configured root. On any mismatch the release is
   * REFUSED (fail-closed, audit WORKTREE_RELEASE_REFUSED) and the
   * record stays ACTIVE — nothing is deleted.
   */
  async release(id: string, opts: { actor?: string; note?: string } = {}): Promise<WorktreeRecord> {
    const rec = this.store.get(id);
    if (!rec) throw new WorktreeNotFoundError(id);
    if (rec.status !== 'ACTIVE') throw new WorktreeStateError(id, rec.status, 'release');

    const refuse = (why: string): never => {
      this.audit?.('WORKTREE_RELEASE_REFUSED', {
        id,
        taskId: rec.taskId,
        recordedPath: rec.worktreePath,
        reason: why,
        actor: opts.actor ?? 'system',
      });
      throw new WorktreeReleaseRefusedError(id, why);
    };

    const p = resolve(rec.worktreePath);
    if (!pathWithin(this.root, p)) refuse('recorded path escapes the worktree root');
    if (!DIR_NAME_RE.test(basename(p))) refuse('recorded path does not match the allocator naming pattern');

    let note = opts.note ?? 'released';
    if (rec.kind === 'git-worktree') {
      const repo = new GitRepo(rec.repoPath);
      let listed: string[];
      try {
        listed = (await repo.worktreeList()).map((w) => resolve(w));
      } catch (e) {
        refuse(`could not list worktrees of ${rec.repoPath}: ${(e as Error).message}`);
        throw new Error('unreachable: refuse() always throws');
      }
      if (listed.includes(p)) {
        // git removes exactly the registered working tree — never a
        // hand-rolled rm, so a TOCTOU swap outside git still fails here.
        await repo.worktreeRemove(p, { force: true });
      } else {
        // Path already gone (deleted outside git): prune the stale
        // metadata and archive the record honestly.
        await repo.worktreePrune().catch(() => undefined);
        note = `${note}; path already absent from git worktree list (stale)`;
      }
    } else {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      else note = `${note}; directory already absent (stale)`;
    }

    const released = this.store.release(id, note, this.now());
    this.audit?.('WORKTREE_RELEASED', {
      id,
      taskId: rec.taskId,
      path: p,
      kind: rec.kind,
      note,
      actor: opts.actor ?? 'system',
    });
    return released;
  }

  /**
   * Bounded wait for a concurrent winner's record to appear
   * (cross-process race fallback). Returns undefined on timeout —
   * the caller then rethrows the original git error, loudly.
   */
  private async awaitWinner(
    repoAbs: string,
    taskId: string,
  ): Promise<WorktreeRecord | undefined> {
    for (let i = 0; i < 40; i++) {
      const winner = this.store.getActive(repoAbs, taskId);
      if (winner) return winner;
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.store.getActive(repoAbs, taskId);
  }

  /** Remove side effects of a losing allocate (best-effort, no throw). */
  private async rollbackPartial(
    repoPath: string,
    kind: 'git-worktree' | 'dir-copy',
    branch: string | null,
    worktreePath: string,
  ): Promise<void> {
    try {
      if (kind === 'git-worktree') {
        const repo = new GitRepo(repoPath);
        const listed = (await repo.worktreeList()).map((w) => resolve(w));
        if (listed.includes(resolve(worktreePath))) {
          await repo.worktreeRemove(worktreePath, { force: true });
        }
        // The branch stays: branch creation is idempotent and shared
        // naming (task/<shortid>-<slug>) means the winner uses it.
      } else if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    } catch {
      // Rollback is best-effort; the record was never inserted so the
      // next allocate/prune pass can reconcile.
    }
  }

  /** Read surface for the server routes. */
  get(id: string): WorktreeRecord | undefined {
    return this.store.get(id);
  }

  list(filter?: { taskId?: string; status?: 'ACTIVE' | 'RELEASED'; repoPath?: string }) {
    return this.store.list(filter ?? {});
  }
}

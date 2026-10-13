/**
 * Worktree allocation records — SPEC v2 §22.1 (G-37, Batch 19).
 *
 * §22.1: different writing tasks use independent Worktrees/Branches
 * (or independent Clones); one writable Workspace has one effective
 * executing Owner. QA uses an independent read-only source copy; non-
 * Git projects use a snapshot/working copy with an explicit
 * Merge/Patch flow. And the honesty clause: a git worktree shares the
 * common directory, hooks and refs — it is NOT OS security isolation.
 *
 * This file is the RECORD layer only (who owns what, where, and in
 * which state). The filesystem mechanics live in @ai-factory/worktrees.
 *
 * Record semantics (pinned by tests):
 *  - One ACTIVE allocation per (repo, task): enforced in SQLite by a
 *    partial unique index and in memory by an explicit check. A second
 *    allocate for the same pair is not a second worktree — the
 *    allocator returns the existing record (idempotent). The store
 *    itself reports the conflict via WorktreeConflictError so the
 *    allocator can re-read and return the winner (the race-safe
 *    pattern for concurrent allocates).
 *  - Paths are unique, period: worktree_path has a plain unique
 *    index, so a leaked path can never be silently reassigned.
 *  - Records are never deleted: release flips ACTIVE → RELEASED and
 *    stamps released_at + a note. History stays inspectable.
 *  - kind distinguishes 'git-worktree' (real `git worktree add`) from
 *    'dir-copy' (non-Git source, §22.1's snapshot/working-copy clause —
 *    an honest downgrade, always labeled).
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type WorktreeStatus = 'ACTIVE' | 'RELEASED';
export type WorktreeKind = 'git-worktree' | 'dir-copy';

export interface WorktreeRecord {
  id: string;
  /** Absolute path of the source repository (or source dir for dir-copy). */
  repoPath: string;
  /** Branch the worktree is attached to; null for dir-copy. */
  branch: string | null;
  /** Absolute path of the allocated worktree directory. */
  worktreePath: string;
  kind: WorktreeKind;
  /** Owning task — the §22.1 single effective Owner. */
  taskId: string;
  projectId: string | null;
  status: WorktreeStatus;
  createdAt: string;
  releasedAt: string | null;
  releaseNote: string | null;
}

export interface CreateWorktreeInput {
  id?: string;
  repoPath: string;
  branch?: string | null;
  worktreePath: string;
  kind: WorktreeKind;
  taskId: string;
  projectId?: string | null;
  createdAt?: string;
}

/** Insert collided with the one-ACTIVE-per-(repo,task) or path rule. */
export class WorktreeConflictError extends Error {
  readonly kind: 'active-duplicate' | 'path-duplicate';
  constructor(kind: WorktreeConflictError['kind'], detail: string) {
    super(`worktree ${kind}: ${detail}`);
    this.name = 'WorktreeConflictError';
    this.kind = kind;
  }
}

export class WorktreeNotFoundError extends Error {
  constructor(id: string) {
    super(`worktree ${id} not found`);
    this.name = 'WorktreeNotFoundError';
  }
}

export class WorktreeStateError extends Error {
  constructor(id: string, status: WorktreeStatus, action: string) {
    super(`cannot ${action} worktree ${id}: status is ${status}`);
    this.name = 'WorktreeStateError';
  }
}

export interface WorktreeStore {
  insert(input: CreateWorktreeInput): WorktreeRecord;
  get(id: string): WorktreeRecord | undefined;
  /** The ACTIVE record for (repoPath, taskId), if any. */
  getActive(repoPath: string, taskId: string): WorktreeRecord | undefined;
  list(filter?: {
    taskId?: string;
    status?: WorktreeStatus;
    repoPath?: string;
  }): WorktreeRecord[];
  release(id: string, note: string, releasedAt?: string): WorktreeRecord;
}

function buildRecord(input: CreateWorktreeInput): WorktreeRecord {
  const now = new Date().toISOString();
  return {
    id: input.id ?? randomUUID(),
    repoPath: input.repoPath,
    branch: input.branch ?? null,
    worktreePath: input.worktreePath,
    kind: input.kind,
    taskId: input.taskId,
    projectId: input.projectId ?? null,
    status: 'ACTIVE',
    createdAt: input.createdAt ?? now,
    releasedAt: null,
    releaseNote: null,
  };
}

function copy(r: WorktreeRecord): WorktreeRecord {
  return { ...r };
}

/** In-memory reference implementation — the behavior pin. */
export class MemoryWorktreeStore implements WorktreeStore {
  private readonly rows = new Map<string, WorktreeRecord>();

  insert(input: CreateWorktreeInput): WorktreeRecord {
    for (const r of this.rows.values()) {
      if (
        r.status === 'ACTIVE' &&
        r.repoPath === input.repoPath &&
        r.taskId === input.taskId
      ) {
        throw new WorktreeConflictError(
          'active-duplicate',
          `repo ${input.repoPath} task ${input.taskId} already has ACTIVE worktree ${r.id}`,
        );
      }
      if (r.worktreePath === input.worktreePath) {
        throw new WorktreeConflictError(
          'path-duplicate',
          `path ${input.worktreePath} already allocated to worktree ${r.id}`,
        );
      }
    }
    const rec = buildRecord(input);
    if (this.rows.has(rec.id)) {
      throw new WorktreeConflictError('path-duplicate', `id ${rec.id} taken`);
    }
    this.rows.set(rec.id, rec);
    return copy(rec);
  }

  get(id: string): WorktreeRecord | undefined {
    const r = this.rows.get(id);
    return r ? copy(r) : undefined;
  }

  getActive(repoPath: string, taskId: string): WorktreeRecord | undefined {
    for (const r of this.rows.values()) {
      if (
        r.status === 'ACTIVE' &&
        r.repoPath === repoPath &&
        r.taskId === taskId
      ) {
        return copy(r);
      }
    }
    return undefined;
  }

  list(filter: {
    taskId?: string;
    status?: WorktreeStatus;
    repoPath?: string;
  } = {}): WorktreeRecord[] {
    return [...this.rows.values()]
      .filter(
        (r) =>
          (filter.taskId === undefined || r.taskId === filter.taskId) &&
          (filter.status === undefined || r.status === filter.status) &&
          (filter.repoPath === undefined || r.repoPath === filter.repoPath),
      )
      .map(copy);
  }

  release(id: string, note: string, releasedAt?: string): WorktreeRecord {
    const r = this.rows.get(id);
    if (!r) throw new WorktreeNotFoundError(id);
    if (r.status !== 'ACTIVE') throw new WorktreeStateError(id, r.status, 'release');
    r.status = 'RELEASED';
    r.releasedAt = releasedAt ?? new Date().toISOString();
    r.releaseNote = note;
    return copy(r);
  }
}

function rowToRecord(row: Record<string, unknown>): WorktreeRecord {
  return {
    id: row['id'] as string,
    repoPath: row['repo_path'] as string,
    branch: (row['branch'] as string) ?? null,
    worktreePath: row['worktree_path'] as string,
    kind: row['kind'] as WorktreeKind,
    taskId: row['task_id'] as string,
    projectId: (row['project_id'] as string) ?? null,
    status: row['status'] as WorktreeStatus,
    createdAt: row['created_at'] as string,
    releasedAt: (row['released_at'] as string) ?? null,
    releaseNote: (row['release_note'] as string) ?? null,
  };
}

/** SQLite implementation, pinned against the memory reference. */
export class SqliteWorktreeStore implements WorktreeStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: CreateWorktreeInput): WorktreeRecord {
    const rec = buildRecord(input);
    try {
      this.db
        .prepare(
          `INSERT INTO worktrees
             (id, repo_path, branch, worktree_path, kind, task_id,
              project_id, status, created_at, released_at, release_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, NULL, NULL)`,
        )
        .run(
          rec.id,
          rec.repoPath,
          rec.branch,
          rec.worktreePath,
          rec.kind,
          rec.taskId,
          rec.projectId,
          rec.createdAt,
        );
    } catch (e) {
      // node:sqlite reports a partial-index violation by column list,
      // not by index name: the (repo_path, task_id) message can only
      // come from worktrees_active_task (the partial unique index).
      const msg = (e as Error).message ?? '';
      if (/UNIQUE constraint failed: worktrees\.repo_path, worktrees\.task_id/.test(msg)) {
        throw new WorktreeConflictError(
          'active-duplicate',
          `repo ${input.repoPath} task ${input.taskId} already has an ACTIVE worktree`,
        );
      }
      if (/UNIQUE constraint failed: worktrees\.worktree_path/.test(msg)) {
        throw new WorktreeConflictError(
          'path-duplicate',
          `path ${input.worktreePath} already allocated`,
        );
      }
      throw e;
    }
    return rec;
  }

  get(id: string): WorktreeRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM worktrees WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getActive(repoPath: string, taskId: string): WorktreeRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM worktrees
          WHERE repo_path = ? AND task_id = ? AND status = 'ACTIVE'`,
      )
      .get(repoPath, taskId) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(filter: {
    taskId?: string;
    status?: WorktreeStatus;
    repoPath?: string;
  } = {}): WorktreeRecord[] {
    const conds: string[] = [];
    const args: Array<string | number | null> = [];
    if (filter.taskId !== undefined) {
      conds.push('task_id = ?');
      args.push(filter.taskId);
    }
    if (filter.status !== undefined) {
      conds.push('status = ?');
      args.push(filter.status);
    }
    if (filter.repoPath !== undefined) {
      conds.push('repo_path = ?');
      args.push(filter.repoPath);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM worktrees${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''} ORDER BY created_at ASC`,
      )
      .all(...args) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  release(id: string, note: string, releasedAt?: string): WorktreeRecord {
    const cur = this.get(id);
    if (!cur) throw new WorktreeNotFoundError(id);
    if (cur.status !== 'ACTIVE') {
      throw new WorktreeStateError(id, cur.status, 'release');
    }
    const at = releasedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE worktrees SET status = 'RELEASED', released_at = ?, release_note = ?
          WHERE id = ? AND status = 'ACTIVE'`,
      )
      .run(at, note, id);
    return { ...cur, status: 'RELEASED', releasedAt: at, releaseNote: note };
  }
}

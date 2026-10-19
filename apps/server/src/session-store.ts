/**
 * Session store (W-D) — conversation-level sessions + session checkpoints.
 *
 * Codex has `codex resume`, Claude Code has `/resume` and Esc-Esc rewind.
 * AI Factory had run-level resume (§28.4) and run-level checkpoints
 * (§28.3) but no *session* concept: a conversation spanning several
 * tasks/runs could not be listed, resumed, or rolled back as one unit.
 *
 * A "session" groups the tasks and runs of one conversation. A
 * "session checkpoint" snapshots the session record plus the resume
 * point of every attached run (latest §28.3 checkpoint position) plus,
 * best-effort, a `git diff` of a caller-supplied code root — so one
 * restore rolls back the conversation state AND the code.
 *
 * Persistence: JSON files under AI_FACTORY_DATA_DIR (same convention as
 * plan-store.ts). Fail-closed on corrupt files: a corrupt file refuses
 * writes and serves empty rather than silently dropping sessions.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type SessionStatus = 'active' | 'archived';

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  projectId: string | null;
  runIds: string[];
  taskIds: string[];
  checkpointIds: string[];
  /** Bound session worktree id (task 3) — null when the session runs in the main checkout. */
  worktreeId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunResumePoint {
  runId: string;
  /** Latest §28.3 checkpoint step position at capture time (-1 = none). */
  stepPosition: number;
  capturedAt: number;
}

export interface SessionCheckpoint {
  id: string;
  sessionId: string;
  label: string;
  createdAt: string;
  createdBy: string;
  /** Full session record at capture time — restore writes this back. */
  sessionSnapshot: Session;
  /** Per-run resume points at capture time. */
  runResumePoints: RunResumePoint[];
  codeRoot: string | null;
  gitHead: string | null;
  gitDiff: string | null;
  gitDiffTruncated: boolean;
  /** Machine-readable reason when gitDiff is null: 'no-code-root' | 'not-a-git-repo' | 'capture-failed'. */
  gitDiffNote: string;
}

/** Max bytes of git diff stored in a checkpoint (larger diffs truncate with a flag). */
export const SESSION_CHECKPOINT_DIFF_LIMIT = 256 * 1024;

export function sessionStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_SESSION_STORE_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'sessions.json');
}

export function sessionCheckpointStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_SESSION_CHECKPOINTS_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'session-checkpoints.json');
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SessionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStoreError';
  }
}

function isValidSession(s: unknown): s is Session {
  if (!s || typeof s !== 'object') return false;
  const r = s as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['title'] === 'string' &&
    (r['status'] === 'active' || r['status'] === 'archived') &&
    Array.isArray(r['runIds']) &&
    Array.isArray(r['taskIds']) &&
    Array.isArray(r['checkpointIds'])
  );
}

/** Atomic write: write temp file then rename (crash-safe, same as plan-store). */
function atomicWriteJson(path: string, payload: unknown): void {
  const dir = resolve(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, path);
}

export class SessionStore {
  private readonly path: string;
  private sessions: Map<string, Session> | null = null;
  private corrupt = false;

  constructor(path: string = sessionStorePath()) {
    this.path = path;
  }

  isCorrupt(): boolean {
    this.load();
    return this.corrupt;
  }

  private load(): Map<string, Session> {
    if (this.sessions) return this.sessions;
    const map = new Map<string, Session>();
    if (!existsSync(this.path)) {
      this.sessions = map;
      return map;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { sessions?: unknown[] };
      for (const s of raw.sessions ?? []) {
        if (isValidSession(s)) {
          // Pre-task-3 records have no worktreeId — normalize to null.
          if (s.worktreeId == null) s.worktreeId = null;
          map.set(s.id, s);
        }
      }
    } catch {
      // Fail-closed: serve empty, refuse writes — never silently drop sessions.
      this.corrupt = true;
      this.sessions = new Map();
      return this.sessions;
    }
    this.sessions = map;
    return map;
  }

  private persist(): void {
    if (this.corrupt) {
      throw new SessionStoreError('session store is corrupt; refusing writes');
    }
    atomicWriteJson(this.path, { sessions: [...this.load().values()] });
  }

  list(): Session[] {
    return [...this.load().values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id: string): Session | undefined {
    return this.load().get(id);
  }

  create(input: { title: string; projectId?: string | null; createdBy?: string }): Session {
    const title = input.title.trim();
    if (!title) throw new SessionStoreError('title is required');
    if (title.length > 200) throw new SessionStoreError('title too long (max 200)');
    const now = nowIso();
    const s: Session = {
      id: randomUUID(),
      title,
      status: 'active',
      projectId: input.projectId ?? null,
      runIds: [],
      taskIds: [],
      checkpointIds: [],
      worktreeId: null,
      createdBy: input.createdBy ?? 'human',
      createdAt: now,
      updatedAt: now,
    };
    this.load().set(s.id, s);
    this.persist();
    return s;
  }

  archive(id: string): Session {
    const s = this.load().get(id);
    if (!s) throw new SessionStoreError(`session not found: ${id}`);
    s.status = 'archived';
    s.updatedAt = nowIso();
    this.persist();
    return s;
  }

  attach(id: string, kind: 'run' | 'task', refId: string): Session {
    const s = this.load().get(id);
    if (!s) throw new SessionStoreError(`session not found: ${id}`);
    const list = kind === 'run' ? s.runIds : s.taskIds;
    if (!list.includes(refId)) list.push(refId);
    s.updatedAt = nowIso();
    this.persist();
    return s;
  }

  linkCheckpoint(id: string, checkpointId: string): Session {
    const s = this.load().get(id);
    if (!s) throw new SessionStoreError(`session not found: ${id}`);
    if (!s.checkpointIds.includes(checkpointId)) s.checkpointIds.push(checkpointId);
    s.updatedAt = nowIso();
    this.persist();
    return s;
  }

  /**
   * Bind (or unbind with null) a session worktree to a session. The
   * caller validates that the worktree exists — the store only records
   * the id. Restoring a checkpoint snapshot replaces this field like
   * every other field (the snapshot is the authority).
   */
  bindWorktree(id: string, worktreeId: string | null): Session {
    const s = this.load().get(id);
    if (!s) throw new SessionStoreError(`session not found: ${id}`);
    s.worktreeId = worktreeId;
    s.updatedAt = nowIso();
    this.persist();
    return s;
  }

  /**
   * Restore a session record from a checkpoint snapshot. The snapshot is
   * the authority: every field is replaced except that the live
   * checkpointIds list is merged (checkpoints created after the snapshot
   * — including the auto-created pre-restore checkpoint — must survive).
   */
  restoreFromSnapshot(snapshot: Session): Session {
    const live = this.load().get(snapshot.id);
    if (!live) throw new SessionStoreError(`session not found: ${snapshot.id}`);
    const mergedCheckpointIds = [...snapshot.checkpointIds];
    for (const cid of live.checkpointIds) {
      if (!mergedCheckpointIds.includes(cid)) mergedCheckpointIds.push(cid);
    }
    const restored: Session = { ...snapshot, checkpointIds: mergedCheckpointIds, updatedAt: nowIso() };
    this.load().set(snapshot.id, restored);
    this.persist();
    return restored;
  }
}

function isValidCheckpoint(c: unknown): c is SessionCheckpoint {
  if (!c || typeof c !== 'object') return false;
  const r = c as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['sessionId'] === 'string' &&
    typeof r['label'] === 'string' &&
    isValidSession(r['sessionSnapshot']) &&
    Array.isArray(r['runResumePoints'])
  );
}

/**
 * Capture `git diff` + HEAD of a code root, best-effort.
 * Never throws: failures are reported via gitDiffNote, never a crash.
 */
export function captureCodeDiff(codeRoot: string | null | undefined): {
  codeRoot: string | null;
  gitHead: string | null;
  gitDiff: string | null;
  gitDiffTruncated: boolean;
  gitDiffNote: string;
} {
  const none = {
    codeRoot: null,
    gitHead: null,
    gitDiff: null,
    gitDiffTruncated: false,
    gitDiffNote: 'no-code-root',
  };
  if (!codeRoot || typeof codeRoot !== 'string' || !codeRoot.trim()) return none;
  const dir = resolve(codeRoot.trim());
  if (!existsSync(dir)) {
    return { ...none, codeRoot: dir, gitDiffNote: 'capture-failed' };
  }
  try {
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    let diff = execFileSync('git', ['-C', dir, 'diff', 'HEAD', '--', '.'], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: SESSION_CHECKPOINT_DIFF_LIMIT * 4,
    });
    let truncated = false;
    if (diff.length > SESSION_CHECKPOINT_DIFF_LIMIT) {
      diff = diff.slice(0, SESSION_CHECKPOINT_DIFF_LIMIT);
      truncated = true;
    }
    return { codeRoot: dir, gitHead: head || null, gitDiff: diff, gitDiffTruncated: truncated, gitDiffNote: '' };
  } catch {
    // Not a git repo, git missing, or diff failed — honest note, no throw.
    let note = 'capture-failed';
    try {
      execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', timeout: 10_000 });
    } catch {
      note = 'not-a-git-repo';
    }
    return { ...none, codeRoot: dir, gitDiffNote: note };
  }
}

export class SessionCheckpointStore {
  private readonly path: string;
  private checkpoints: Map<string, SessionCheckpoint> | null = null;
  private corrupt = false;

  constructor(path: string = sessionCheckpointStorePath()) {
    this.path = path;
  }

  isCorrupt(): boolean {
    this.load();
    return this.corrupt;
  }

  private load(): Map<string, SessionCheckpoint> {
    if (this.checkpoints) return this.checkpoints;
    const map = new Map<string, SessionCheckpoint>();
    if (!existsSync(this.path)) {
      this.checkpoints = map;
      return map;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { checkpoints?: unknown[] };
      for (const c of raw.checkpoints ?? []) {
        if (isValidCheckpoint(c)) map.set(c.id, c);
      }
    } catch {
      this.corrupt = true;
      this.checkpoints = new Map();
      return this.checkpoints;
    }
    this.checkpoints = map;
    return map;
  }

  private persist(): void {
    if (this.corrupt) {
      throw new SessionStoreError('session checkpoint store is corrupt; refusing writes');
    }
    atomicWriteJson(this.path, { checkpoints: [...this.load().values()] });
  }

  list(sessionId: string): SessionCheckpoint[] {
    return [...this.load().values()]
      .filter((c) => c.sessionId === sessionId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id: string): SessionCheckpoint | undefined {
    return this.load().get(id);
  }

  create(input: {
    session: Session;
    runResumePoints: RunResumePoint[];
    label?: string;
    createdBy?: string;
    codeRoot?: string | null;
  }): SessionCheckpoint {
    const label = (input.label ?? '').trim().slice(0, 120) || `checkpoint ${nowIso()}`;
    const code = captureCodeDiff(input.codeRoot ?? null);
    const c: SessionCheckpoint = {
      id: randomUUID(),
      sessionId: input.session.id,
      label,
      createdAt: nowIso(),
      createdBy: input.createdBy ?? 'human',
      sessionSnapshot: JSON.parse(JSON.stringify(input.session)) as Session,
      runResumePoints: input.runResumePoints,
      codeRoot: code.codeRoot,
      gitHead: code.gitHead,
      gitDiff: code.gitDiff,
      gitDiffTruncated: code.gitDiffTruncated,
      gitDiffNote: code.gitDiffNote,
    };
    this.load().set(c.id, c);
    this.persist();
    return c;
  }
}

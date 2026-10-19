/**
 * Session worktrees — git worktree session isolation (the Claude Code
 * `claude --worktree` equivalent), third strengthening wave, task 3.
 *
 * Multiple parallel sessions each get an isolated git worktree so they
 * can run without stepping on each other's files. Pure git plumbing,
 * zero model involvement:
 *
 *   createWorktree(projectPath, name)
 *     → `git -C <projectPath> worktree add --detach <root>/wt-<name>-<shortid>`
 *   listWorktrees()
 *     → records enriched from `git worktree list --porcelain` (branch/head)
 *   removeWorktree(id)
 *     → `git worktree remove --force <path>` + `git worktree prune`
 *   pruneStale()
 *     → drop records whose path is gone or no longer registered
 *
 * `.worktreeinclude`: a file in the project root listing relative paths
 * (one per line, `#` comments) that are copied from the main checkout
 * into the new worktree — e.g. `.env`. Entries are path-jailed:
 * absolute paths and `..` segments are skipped (reported, not fatal).
 *
 * Fail-closed rules (honest boundaries):
 *
 *   - projectPath must be an existing directory inside the server
 *     workspace root (same confinement as /api/exec cwd) — otherwise
 *     WORKTREE_PATH_ESCAPE / WORKTREE_PROJECT_NOT_FOUND.
 *   - projectPath must be a git repository (`git rev-parse --git-dir`
 *     must succeed) — otherwise WORKTREE_NOT_A_GIT_REPO. No silent
 *     copy-tree fallback: a "worktree" of a non-git dir is a lie.
 *   - Removing a worktree NEVER deletes branches — only the working
 *     tree is removed (documented; there is no branch to delete for
 *     --detach worktrees anyway).
 *   - The JSON store is corrupt-fail-closed: corrupt file → serves
 *     empty and refuses writes (same convention as session-store.ts).
 *
 * Where the worktrees live: FACTORY_SESSION_WORKTREE_ROOT, default
 * `<cwd>/session-worktrees`. Deliberately NOT under the data dir:
 * §4.1 forbids /api/exec (and terminals) from running with a cwd
 * inside the control-plane data directory, and a session worktree is
 * useless if you cannot exec in it. The *record store* JSON stays in
 * the data dir (AI_FACTORY_DATA_DIR/session-worktrees.json) — it is
 * metadata, never an exec cwd.
 *
 * This module is node-builtins only so server tests may import it
 * straight from src (dual-mode import rule).
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** Env override for the worktree root directory. */
export const SESSION_WORKTREE_ROOT_ENV = 'FACTORY_SESSION_WORKTREE_ROOT';
/** Env override for the record-store JSON file. */
export const SESSION_WORKTREE_STORE_FILE_ENV = 'AI_FACTORY_SESSION_WORKTREE_FILE';
/** Data-dir env (store file location only — never the worktrees themselves). */
export const SESSION_WORKTREE_DATA_DIR_ENV = 'AI_FACTORY_DATA_DIR';
/** Name of the per-project include file copied into new worktrees. */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

export class WorktreeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
  }
}

export interface SessionWorktreeRecord {
  id: string;
  name: string;
  /** Absolute path of the source repository. */
  projectPath: string;
  /** Absolute path of the worktree checkout. */
  worktreePath: string;
  sessionId: string | null;
  createdBy: string;
  createdAt: string;
}

export interface SessionWorktreeInfo extends SessionWorktreeRecord {
  /** Branch the worktree is on (null when detached — the normal case). */
  branch: string | null;
  /** HEAD commit sha of the worktree (null when not registered). */
  head: string | null;
  /** False when the path is gone from disk or from `git worktree list`. */
  registered: boolean;
}

export interface CreateWorktreeResult {
  record: SessionWorktreeRecord;
  /** Include entries actually copied. */
  includeCopied: string[];
  /** Include entries skipped as unsafe (absolute or escaping). */
  includeSkipped: string[];
}

/** Injectable seams for tests. */
export interface SessionWorktreeManagerOptions {
  rootDir?: string;
  storeFile?: string;
  /** Jail root for projectPath (default: process.cwd(), the server workspace). */
  workspaceRoot?: string;
  now?: () => string;
  /** Run git; default execFileSync. Throw to simulate git failure. */
  runGit?: (args: string[], cwd: string) => string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function defaultRootDir(): string {
  const fromEnv = process.env[SESSION_WORKTREE_ROOT_ENV];
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return resolve(process.cwd(), 'session-worktrees');
}

function defaultStoreFile(): string {
  const fromEnv = process.env[SESSION_WORKTREE_STORE_FILE_ENV];
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env[SESSION_WORKTREE_DATA_DIR_ENV] ?? 'data';
  return resolve(dataDir, 'session-worktrees.json');
}

function isValidRecord(r: unknown): r is SessionWorktreeRecord {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['name'] === 'string' &&
    typeof o['projectPath'] === 'string' &&
    typeof o['worktreePath'] === 'string' &&
    typeof o['createdAt'] === 'string'
  );
}

/** Parse `git worktree list --porcelain` into path → { branch, head }. */
export function parseWorktreePorcelain(
  out: string,
): Map<string, { branch: string | null; head: string | null }> {
  const map = new Map<string, { branch: string | null; head: string | null }>();
  let curPath: string | null = null;
  let curBranch: string | null = null;
  let curHead: string | null = null;
  const flush = () => {
    if (curPath !== null) map.set(curPath, { branch: curBranch, head: curHead });
    curPath = null;
    curBranch = null;
    curHead = null;
  };
  for (const rawLine of out.split('\n')) {
    const line = rawLine.trimEnd();
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      curPath = resolve(line.slice('worktree '.length).trim());
    } else if (line.startsWith('HEAD ')) {
      curHead = line.slice('HEAD '.length).trim() || null;
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      curBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
    // 'detached', 'bare', 'locked', 'prunable' lines carry no extra state we need.
  }
  flush();
  return map;
}

export class SessionWorktreeManager {
  private readonly rootDir: string;
  private readonly storeFile: string;
  private readonly workspaceRoot: string;
  private readonly now: () => string;
  private readonly runGit: (args: string[], cwd: string) => string;
  private records: Map<string, SessionWorktreeRecord> | null = null;
  private corrupt = false;

  constructor(opts: SessionWorktreeManagerOptions = {}) {
    this.rootDir = resolve(opts.rootDir ?? defaultRootDir());
    this.storeFile = opts.storeFile ?? defaultStoreFile();
    this.workspaceRoot = resolve(opts.workspaceRoot ?? process.cwd());
    this.now = opts.now ?? (() => new Date().toISOString());
    this.runGit =
      opts.runGit ??
      ((args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  }

  /** The on-disk root holding every session worktree. */
  getRootDir(): string {
    return this.rootDir;
  }

  private load(): Map<string, SessionWorktreeRecord> {
    if (this.records) return this.records;
    const map = new Map<string, SessionWorktreeRecord>();
    if (!existsSync(this.storeFile)) {
      this.records = map;
      return map;
    }
    try {
      const raw = JSON.parse(readFileSync(this.storeFile, 'utf8')) as { worktrees?: unknown[] };
      for (const r of raw.worktrees ?? []) {
        if (isValidRecord(r)) {
          map.set(r.id, { ...r, sessionId: typeof r.sessionId === 'string' ? r.sessionId : null });
        }
      }
    } catch {
      // Fail-closed: serve empty, refuse writes — never silently drop records.
      this.corrupt = true;
      this.records = new Map();
      return this.records;
    }
    this.records = map;
    return map;
  }

  private persist(): void {
    if (this.corrupt) {
      throw new WorktreeError('WORKTREE_STORE_CORRUPT', 'session worktree store is corrupt; refusing writes');
    }
    mkdirSync(dirname(this.storeFile), { recursive: true });
    const tmp = `${this.storeFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ worktrees: [...this.load().values()] }, null, 2), 'utf8');
    renameSync(tmp, this.storeFile);
  }

  isCorrupt(): boolean {
    this.load();
    return this.corrupt;
  }

  get(id: string): SessionWorktreeRecord | undefined {
    return this.load().get(id);
  }

  /** Resolve + validate the project path. Throws WorktreeError fail-closed. */
  private resolveProject(projectPath: string): string {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      throw new WorktreeError('WORKTREE_BAD_PROJECT', 'projectPath is required');
    }
    const workspaceRoot = this.workspaceRoot;
    const abs = resolve(workspaceRoot, projectPath.trim());
    if (abs !== workspaceRoot && !abs.startsWith(workspaceRoot + sep)) {
      throw new WorktreeError(
        'WORKTREE_PATH_ESCAPE',
        `projectPath must stay inside the server workspace (${workspaceRoot})`,
      );
    }
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new WorktreeError('WORKTREE_PROJECT_NOT_FOUND', `project directory not found: ${projectPath}`);
    }
    return abs;
  }

  /** Fail-closed: the project MUST be a git repo. No silent copy fallback. */
  private assertGitRepo(projectAbs: string): void {
    try {
      this.runGit(['rev-parse', '--git-dir'], projectAbs);
    } catch {
      throw new WorktreeError(
        'WORKTREE_NOT_A_GIT_REPO',
        `not a git repository (refusing to fake a worktree): ${projectAbs}`,
      );
    }
  }

  /** Copy .worktreeinclude entries. Returns { copied, skipped }. */
  private applyIncludeFile(projectAbs: string, target: string): { copied: string[]; skipped: string[] } {
    const copied: string[] = [];
    const skipped: string[] = [];
    const includePath = join(projectAbs, WORKTREE_INCLUDE_FILE);
    if (!existsSync(includePath)) return { copied, skipped };
    const lines = readFileSync(includePath, 'utf8').split('\n');
    for (const raw of lines) {
      const entry = raw.trim();
      if (!entry || entry.startsWith('#')) continue;
      // Path jail: relative only, no parent escapes.
      if (
        entry.startsWith('/') ||
        /^[A-Za-z]:[\\/]/.test(entry) ||
        entry.split('/').includes('..')
      ) {
        skipped.push(entry);
        continue;
      }
      const src = resolve(projectAbs, entry);
      if (src !== projectAbs && !src.startsWith(projectAbs + sep)) {
        skipped.push(entry);
        continue;
      }
      if (!existsSync(src)) continue; // missing entry: skip silently, not fatal
      const dest = join(target, entry);
      try {
        mkdirSync(dirname(dest), { recursive: true });
        const st = statSync(src);
        if (st.isDirectory()) cpSync(src, dest, { recursive: true });
        else copyFileSync(src, dest);
        copied.push(entry);
      } catch {
        skipped.push(entry);
      }
    }
    return { copied, skipped };
  }

  /**
   * Create an isolated detached worktree for a project.
   * Rolls back (git worktree remove + prune) if the include copy fails
   * after the worktree was added — never leaves a half-built worktree.
   */
  createWorktree(
    projectPath: string,
    name: string,
    opts: { sessionId?: string; createdBy?: string } = {},
  ): CreateWorktreeResult {
    if (typeof name !== 'string' || !NAME_RE.test(name.trim())) {
      throw new WorktreeError(
        'WORKTREE_BAD_NAME',
        'name must be 1-64 chars: letters, digits, _ and - (must start alnum)',
      );
    }
    const cleanName = name.trim();
    const projectAbs = this.resolveProject(projectPath);
    this.assertGitRepo(projectAbs);
    // Fail-closed BEFORE touching git: a corrupt store must refuse the
    // whole create, not orphan a worktree that no record points to.
    this.load();
    if (this.corrupt) {
      throw new WorktreeError('WORKTREE_STORE_CORRUPT', 'session worktree store is corrupt; refusing writes');
    }

    const id = randomUUID();
    const dirName = `wt-${cleanName}-${id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;
    const target = join(this.rootDir, dirName);
    if (existsSync(target)) {
      throw new WorktreeError('WORKTREE_COLLISION', `worktree path already exists: ${target}`);
    }
    mkdirSync(this.rootDir, { recursive: true });

    try {
      this.runGit(['worktree', 'add', '--detach', target], projectAbs);
    } catch (e) {
      throw new WorktreeError(
        'WORKTREE_GIT_FAILED',
        `git worktree add failed: ${(e as Error).message ?? e}`,
      );
    }

    let include: { copied: string[]; skipped: string[] };
    try {
      include = this.applyIncludeFile(projectAbs, target);
    } catch (e) {
      // Roll back the half-built worktree — never leave it behind.
      try {
        this.runGit(['worktree', 'remove', '--force', target], projectAbs);
      } catch {
        /* best effort */
      }
      try {
        this.runGit(['worktree', 'prune'], projectAbs);
      } catch {
        /* best effort */
      }
      throw e instanceof WorktreeError
        ? e
        : new WorktreeError('WORKTREE_INCLUDE_FAILED', `include copy failed: ${(e as Error).message ?? e}`);
    }

    const record: SessionWorktreeRecord = {
      id,
      name: cleanName,
      projectPath: projectAbs,
      worktreePath: target,
      sessionId: typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : null,
      createdBy: opts.createdBy ?? 'human',
      createdAt: this.now(),
    };
    this.load().set(id, record);
    this.persist();
    return { record, includeCopied: include.copied, includeSkipped: include.skipped };
  }

  /** Records enriched with live git state (branch/head/registered). */
  listWorktrees(): SessionWorktreeInfo[] {
    const records = [...this.load().values()];
    // One porcelain call per distinct repo (usually one).
    const porcelainByRepo = new Map<string, Map<string, { branch: string | null; head: string | null }>>();
    const porcelainFor = (repo: string) => {
      let m = porcelainByRepo.get(repo);
      if (!m) {
        try {
          m = parseWorktreePorcelain(this.runGit(['worktree', 'list', '--porcelain'], repo));
        } catch {
          m = new Map();
        }
        porcelainByRepo.set(repo, m);
      }
      return m;
    };
    return records.map((r) => {
      const entry = porcelainFor(r.projectPath).get(resolve(r.worktreePath));
      return {
        ...r,
        branch: entry?.branch ?? null,
        head: entry?.head ?? null,
        registered: entry !== undefined && existsSync(r.worktreePath),
      };
    });
  }

  /**
   * Remove a session worktree. Deletes the WORKING TREE ONLY — branches
   * are never touched (documented honest boundary; --detach worktrees
   * create no branch in the first place).
   */
  removeWorktree(id: string): SessionWorktreeRecord {
    const rec = this.load().get(id);
    if (!rec) throw new WorktreeError('WORKTREE_NOT_FOUND', `session worktree not found: ${id}`);
    try {
      this.runGit(['worktree', 'remove', '--force', rec.worktreePath], rec.projectPath);
    } catch {
      // Tolerate "already gone" — the record still needs cleanup.
    }
    try {
      this.runGit(['worktree', 'prune'], rec.projectPath);
    } catch {
      /* best effort */
    }
    // Fail-closed on the git side: if git still lists it, refuse to drop the record.
    try {
      const stillThere = parseWorktreePorcelain(
        this.runGit(['worktree', 'list', '--porcelain'], rec.projectPath),
      ).has(resolve(rec.worktreePath));
      if (stillThere) {
        throw new WorktreeError('WORKTREE_GIT_FAILED', `git still lists the worktree; refusing to drop record ${id}`);
      }
    } catch (e) {
      if (e instanceof WorktreeError) throw e;
      // porcelain itself failed — the remove already ran; drop the record.
    }
    if (existsSync(rec.worktreePath)) {
      rmSync(rec.worktreePath, { recursive: true, force: true });
    }
    this.load().delete(id);
    this.persist();
    return rec;
  }

  /**
   * Drop records whose path is gone from disk or no longer registered
   * with git (e.g. removed by hand). Returns the pruned ids.
   */
  pruneStale(): string[] {
    const pruned: string[] = [];
    for (const r of this.listWorktrees()) {
      if (!r.registered) {
        this.load().delete(r.id);
        pruned.push(r.id);
      }
    }
    if (pruned.length > 0) this.persist();
    return pruned;
  }
}

/** Module singleton for the production server (lazy — created on first use). */
let singleton: SessionWorktreeManager | null = null;

export function sessionWorktrees(): SessionWorktreeManager {
  if (!singleton) singleton = new SessionWorktreeManager();
  return singleton;
}

/** Re-exported for tests: drop the singleton so the next call re-reads. */
export function resetSessionWorktreesForTests(): void {
  singleton = null;
}

/**
 * sessionId → bound worktree absolute path (or null). Setter-injected by
 * routes/sessions.ts (it owns the SessionStore singleton); routes/exec.ts
 * calls resolveSessionWorktreePath() so POST /api/exec {sessionId} runs
 * in the session's worktree without an explicit cwd. Default: unbound
 * (no behavior change).
 */
let sessionWorktreePathResolver: ((sessionId: string) => string | null) | null = null;

export function setSessionWorktreePathResolver(
  fn: ((sessionId: string) => string | null) | null,
): void {
  sessionWorktreePathResolver = fn;
}

export function resolveSessionWorktreePath(sessionId: string): string | null {
  return sessionWorktreePathResolver ? sessionWorktreePathResolver(sessionId) : null;
}

/**
 * Map a WorktreeError code to an HTTP status. Exported for the route
 * layer and its tests.
 */
export function worktreeErrorStatus(e: unknown): number {
  if (e instanceof WorktreeError) {
    switch (e.code) {
      case 'WORKTREE_NOT_FOUND':
        return 404;
      case 'WORKTREE_PATH_ESCAPE':
        return 403;
      case 'WORKTREE_STORE_CORRUPT':
        return 503;
      case 'WORKTREE_GIT_FAILED':
        return 500;
      default:
        return 400;
    }
  }
  return 500;
}

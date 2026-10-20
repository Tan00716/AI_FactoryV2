/**
 * Shadow git checkpoints (third-wave task 7, Cline sidecar style).
 *
 * A file-level, git-object-based checkpoint layer that sits *beside* the
 * existing snapshot-style checkpoints (W-D session checkpoints are
 * untouched — this is an independent "shadow" layer, never a replacement).
 *
 * Each workspace gets a sidecar bare repo at
 *   AI_FACTORY_DATA_DIR/checkpoints/<workspace-id>.git
 * Snapshots are taken with `git --git-dir=<bare> --work-tree=<workspace>`,
 * so the workspace itself never needs to be a git repo. Every snapshot is
 * one commit; the commit message carries the task id, which is what makes
 * diffs task-scoped.
 *
 * Honest boundaries (also surfaced in the UI copy):
 * 1. This is a FILE-level snapshot store (git objects), not a semantic
 *    record of "task intent". It remembers bytes, not meaning.
 * 2. Files larger than MAX_SHADOW_FILE_BYTES (default 5 MiB) are skipped
 *    and listed as skipped — the snapshot does not pretend to hold them.
 * 3. Symlinks are never followed/stored (escape risk); they are listed as
 *    skipped instead.
 * 4. Undo restores tracked file CONTENT to the checkpoint. Files created
 *    after the checkpoint that were never snapshotted stay on disk and are
 *    reported as leftInPlace — undo is "restore to this point", not
 *    "replay every step backwards".
 * 5. The sidecar is a bare object store; git is never *executed* out of a
 *    control-plane data dir (§4.1) — we only read/write git objects, and
 *    workspace writes happen in the caller's own workspace, not in data/.
 * 6. Determinism: file enumeration is sorted; commit metadata is fixed
 *    (fixed author); nothing here needs a model.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Max bytes of a single file that may enter a snapshot (env override). */
export const DEFAULT_MAX_SHADOW_FILE_BYTES = 5 * 1024 * 1024;
/** Cap on unified-diff bytes returned by the diff API. */
export const MAX_SHADOW_DIFF_BYTES = 128 * 1024;
/** Cap on entries reported in skipped / leftInPlace lists. */
const MAX_LISTED = 100;
/** Directories never walked when snapshotting. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'build',
  'out',
  '.next',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.idea',
  '.vscode',
  '.DS_Store',
]);
/** Empty-tree sha, used as the diff base for a sidecar's first commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class ShadowCheckpointError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ShadowCheckpointError';
    this.code = code;
  }
}

export interface ShadowSkipped {
  path: string;
  reason: 'too-large' | 'grew-over-cap' | 'symlink';
}

export interface ShadowCheckpoint {
  id: string;
  workspaceId: string;
  taskId: string | null;
  label: string;
  /** true when created by an automatic trigger (not a human click). */
  auto: boolean;
  trigger: 'manual' | 'run-start' | 'post-tool-use' | 'pre-restore';
  createdAt: string;
  sha: string;
  parentSha: string | null;
  fileCount: number;
  additions: number;
  deletions: number;
  /** true when the workspace had no changes vs the previous snapshot. */
  empty: boolean;
  skipped: ShadowSkipped[];
  skippedTotal: number;
}

export interface ShadowConfig {
  workspaceId: string;
  /** Resolved workspace path registered for this workspace id. */
  workspacePath: string;
  autoOnToolUse: boolean;
  autoOnRunStart: boolean;
  updatedAt: string;
}

export function maxShadowFileBytes(): number {
  const raw = process.env.FACTORY_SHADOW_MAX_FILE_BYTES;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 512 * 1024 * 1024) return Math.floor(n);
  }
  return DEFAULT_MAX_SHADOW_FILE_BYTES;
}

export function shadowRootDir(): string {
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'checkpoints');
}

export function shadowStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_SHADOW_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'shadow-checkpoints.json');
}

const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function validateWorkspaceId(raw: unknown): string {
  if (typeof raw !== 'string' || !WORKSPACE_ID_RE.test(raw.trim())) {
    throw new ShadowCheckpointError(
      'workspaceId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}',
      'SHADOW_BAD_WORKSPACE_ID',
    );
  }
  return raw.trim();
}

/** Sidecar bare-repo path for a workspace id (path-jail enforced). */
export function sidecarPath(workspaceId: string): string {
  const id = validateWorkspaceId(workspaceId);
  const root = shadowRootDir();
  const p = resolve(root, `${id}.git`);
  if (p !== root && !p.startsWith(root + sep)) {
    throw new ShadowCheckpointError('sidecar path escapes checkpoints root', 'SHADOW_PATH_ESCAPE');
  }
  return p;
}

/**
 * Allowed workspace roots for snapshotting (colon-separated env, default
 * server cwd). The resolved workspace path must sit inside one root —
 * same jail posture as FACTORY_CODEINDEX_ROOTS.
 */
export function shadowAllowedRoots(): string[] {
  const raw = process.env.FACTORY_SHADOW_ROOTS;
  if (raw && raw.trim()) {
    const parts = raw
      .split(process.platform === 'win32' ? ';' : ':')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts.map((p) => resolve(p));
  }
  return [resolve(process.cwd())];
}

/** Resolve + jail a caller-supplied workspace path. */
export function resolveWorkspacePath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 1024) {
    throw new ShadowCheckpointError('workspacePath must be a non-empty string', 'SHADOW_BAD_PATH');
  }
  if (!isAbsolute(raw.trim())) {
    throw new ShadowCheckpointError('workspacePath must be absolute', 'SHADOW_BAD_PATH');
  }
  const p = resolve(raw.trim());
  const ok = shadowAllowedRoots().some((r) => p === r || p.startsWith(r + sep));
  if (!ok) {
    throw new ShadowCheckpointError(
      `workspacePath escapes allowed shadow roots (${shadowAllowedRoots().join(', ')})`,
      'SHADOW_PATH_ESCAPE',
    );
  }
  if (!existsSync(p) || !lstatSync(p).isDirectory()) {
    throw new ShadowCheckpointError('workspacePath is not an existing directory', 'SHADOW_BAD_PATH');
  }
  return p;
}

// ------------------------------------------------------------ git ----

let gitOk: boolean | null = null;

/** Fail-closed when no git binary is available. */
export function requireGit(): void {
  if (gitOk === null) {
    const r = spawnSync('git', ['--version'], { timeout: 10_000 });
    gitOk = r.status === 0;
  }
  if (!gitOk) {
    throw new ShadowCheckpointError(
      'git is not available on this host — shadow checkpoints cannot run',
      'SHADOW_GIT_UNAVAILABLE',
    );
  }
}

function git(args: string[], opts: { gitDir: string; workTree?: string; timeoutMs?: number }): {
  status: number;
  stdout: string;
  stderr: string;
} {
  requireGit();
  const env = {
    ...process.env,
    GIT_DIR: opts.gitDir,
    ...(opts.workTree ? { GIT_WORK_TREE: opts.workTree } : {}),
    // Keep sidecars hermetic: never read user git config / system templates.
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: process.env.HOME,
  };
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status ?? 1,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
  };
}

function checkGit(r: { status: number; stderr: string }, what: string): void {
  if (r.status !== 0) {
    throw new ShadowCheckpointError(
      `${what} failed: ${r.stderr.trim().slice(0, 300) || `git exit ${r.status}`}`,
      'SHADOW_GIT_FAILED',
    );
  }
}

/** Create the sidecar bare repo if missing; return its path. */
export function ensureSidecar(workspaceId: string): string {
  const dir = sidecarPath(workspaceId);
  if (!existsSync(join(dir, 'HEAD'))) {
    mkdirSync(dir, { recursive: true });
    const r = git(['init', '--bare', '-q', dir], { gitDir: dir });
    checkGit(r, 'git init --bare');
  }
  // Sanity: it must actually be a git dir.
  const rev = git(['rev-parse', '--git-dir'], { gitDir: dir });
  checkGit(rev, 'git rev-parse');
  return dir;
}

function headSha(gitDir: string): string | null {
  const r = git(['rev-parse', 'HEAD'], { gitDir });
  return r.status === 0 ? r.stdout.trim() : null;
}

function lsTree(gitDir: string, rev?: string): string[] {
  const head = rev ?? headSha(gitDir);
  if (!head) return [];
  const r = git(['ls-tree', '-r', '--name-only', '-z', head], { gitDir });
  checkGit(r, 'git ls-tree');
  return r.stdout.split('\0').filter(Boolean);
}

/** Paths currently in the index (staged state). */
function lsFiles(gitDir: string, workTree: string): string[] {
  const r = git(['ls-files', '-z'], { gitDir, workTree });
  checkGit(r, 'git ls-files');
  return r.stdout.split('\0').filter(Boolean);
}

// ------------------------------------------------------ enumeration ----

interface Enumeration {
  files: string[];
  skipped: ShadowSkipped[];
  skippedTotal: number;
}

/** Walk a workspace, sorted, skipping ignored dirs / symlinks / big files. */
function enumerateWorkspace(root: string, cap: number): Enumeration {
  const files: string[] = [];
  const skipped: ShadowSkipped[] = [];
  let skippedTotal = 0;
  const pushSkipped = (path: string, reason: ShadowSkipped['reason']) => {
    skippedTotal += 1;
    if (skipped.length < MAX_LISTED) skipped.push({ path, reason });
  };
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        pushSkipped(rel, 'symlink');
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > cap) {
        pushSkipped(rel, 'too-large');
        continue;
      }
      files.push(rel);
    }
  };
  walk(root);
  return { files, skipped, skippedTotal };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ------------------------------------------------------------ store ----

interface ShadowStoreFile {
  version: 1;
  checkpoints: ShadowCheckpoint[];
  configs: Record<string, ShadowConfig>;
}

export class ShadowCheckpointStore {
  private file: ShadowStoreFile | null = null;
  private readonly path: string;
  constructor(path: string = shadowStorePath()) {
    this.path = path;
  }

  private load(): ShadowStoreFile {
    if (this.file) return this.file;
    if (!existsSync(this.path)) {
      this.file = { version: 1, checkpoints: [], configs: {} };
      return this.file;
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (e) {
      throw new ShadowCheckpointError(
        `cannot read shadow checkpoint store: ${(e as Error).message}`,
        'SHADOW_STORE_CORRUPT',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ShadowCheckpointError('shadow checkpoint store is corrupt JSON', 'SHADOW_STORE_CORRUPT');
    }
    const p = parsed as Partial<ShadowStoreFile>;
    if (p.version !== 1 || !Array.isArray(p.checkpoints) || typeof p.configs !== 'object' || p.configs === null) {
      throw new ShadowCheckpointError('shadow checkpoint store has unknown shape', 'SHADOW_STORE_CORRUPT');
    }
    this.file = p as ShadowStoreFile;
    return this.file;
  }

  private save(): void {
    const f = this.load();
    const tmp = `${this.path}.tmp-${process.pid}`;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(f, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  list(workspaceId?: string): ShadowCheckpoint[] {
    const all = this.load().checkpoints;
    const rows = workspaceId ? all.filter((c) => c.workspaceId === workspaceId) : all;
    return [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id: string): ShadowCheckpoint | null {
    return this.load().checkpoints.find((c) => c.id === id) ?? null;
  }

  add(rec: ShadowCheckpoint): void {
    const f = this.load();
    f.checkpoints.push(rec);
    this.save();
  }

  config(workspaceId: string): ShadowConfig | null {
    return this.load().configs[workspaceId] ?? null;
  }

  setConfig(cfg: ShadowConfig): void {
    const f = this.load();
    f.configs[cfg.workspaceId] = cfg;
    this.save();
  }

  /** Find configs whose registered workspacePath matches a resolved cwd. */
  configsForPath(resolvedCwd: string): ShadowConfig[] {
    const cfgs = Object.values(this.load().configs);
    return cfgs.filter((c) => c.workspacePath === resolvedCwd);
  }
}

// ------------------------------------------------------- operations ----

export interface CreateShadowOptions {
  workspaceId: string;
  workspacePath: string;
  taskId?: string | null;
  label?: string;
  auto?: boolean;
  trigger?: ShadowCheckpoint['trigger'];
}

function numstat(gitDir: string, from: string, to: string): { files: { path: string; additions: number; deletions: number; binary: boolean }[]; additions: number; deletions: number } {
  const r = git(['diff', '--numstat', '-z', from, to, '--'], { gitDir });
  checkGit(r, 'git diff --numstat');
  // With -z each file is one NUL-separated record: "add\tdel\tpath".
  const records = r.stdout.split('\0').filter(Boolean);
  const files: { path: string; additions: number; deletions: number; binary: boolean }[] = [];
  let additions = 0;
  let deletions = 0;
  for (const rec of records) {
    const tab1 = rec.indexOf('\t');
    const tab2 = tab1 === -1 ? -1 : rec.indexOf('\t', tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;
    const a = rec.slice(0, tab1);
    const d = rec.slice(tab1 + 1, tab2);
    const p = rec.slice(tab2 + 1);
    const binary = a === '-' || d === '-';
    const fa = binary ? 0 : Number(a);
    const fd = binary ? 0 : Number(d);
    additions += fa;
    deletions += fd;
    files.push({ path: p, additions: fa, deletions: fd, binary });
  }
  return { files, additions, deletions };
}

/**
 * Snapshot a workspace into its sidecar. Returns the checkpoint record
 * (also persisted in the store). Empty workspaces-vs-HEAD produce an
 * `empty` record without a new commit — still useful as a named marker.
 */
export function createShadowCheckpoint(store: ShadowCheckpointStore, opts: CreateShadowOptions): ShadowCheckpoint {
  const workspaceId = validateWorkspaceId(opts.workspaceId);
  const workspacePath = resolveWorkspacePath(opts.workspacePath);
  const taskId =
    typeof opts.taskId === 'string' && opts.taskId.trim() ? opts.taskId.trim().slice(0, 128) : null;
  const label = typeof opts.label === 'string' && opts.label.trim() ? opts.label.trim().slice(0, 200) : 'snapshot';
  const cap = maxShadowFileBytes();
  const gitDir = ensureSidecar(workspaceId);

  const parentSha = headSha(gitDir);
  const { files, skipped, skippedTotal } = enumerateWorkspace(workspacePath, cap);
  const current = new Set(files);
  const tracked = new Set(lsTree(gitDir));

  const added: string[] = [];
  for (const f of files) if (!tracked.has(f)) added.push(f);
  // Stage new + modified files (chunked to stay under arg limits).
  for (const c of chunk(files, 400)) {
    const r = git(['add', '--', ...c], { gitDir, workTree: workspacePath });
    checkGit(r, 'git add');
  }
  // Deletions + files that grew past the cap: drop from the index so the
  // snapshot honestly does not claim to hold them.
  const toRemove: string[] = [];
  for (const t of tracked) {
    if (!current.has(t)) toRemove.push(t);
  }
  for (const c of chunk(toRemove, 400)) {
    const r = git(['rm', '--cached', '-q', '--', ...c], { gitDir, workTree: workspacePath });
    checkGit(r, 'git rm --cached');
  }
  for (const s of skipped) {
    if (s.reason === 'too-large' && tracked.has(s.path)) {
      const r = git(['rm', '--cached', '-q', '--', s.path], { gitDir, workTree: workspacePath });
      checkGit(r, 'git rm --cached (over-cap)');
    }
  }

  const status = git(['status', '--porcelain'], { gitDir, workTree: workspacePath });
  checkGit(status, 'git status');
  const dirty = status.stdout.trim() !== '';

  let sha = parentSha;
  let empty = true;
  if (dirty) {
    const msg = `shadow ${workspaceId} task:${taskId ?? '-'}\n\n${label}`;
    const c = git(
      ['-c', 'user.name=ai-factory-shadow', '-c', 'user.email=shadow@localhost', 'commit', '-q', '-m', msg],
      { gitDir, workTree: workspacePath },
    );
    checkGit(c, 'git commit');
    const h = headSha(gitDir);
    if (!h) throw new ShadowCheckpointError('commit succeeded but HEAD is missing', 'SHADOW_GIT_FAILED');
    sha = h;
    empty = false;
  }
  if (!sha) {
    throw new ShadowCheckpointError('no commit exists and nothing changed — nothing to record', 'SHADOW_GIT_FAILED');
  }

  const base = parentSha ?? EMPTY_TREE;
  const stats = empty ? { files: [], additions: 0, deletions: 0 } : numstat(gitDir, base, sha);

  const rec: ShadowCheckpoint = {
    id: `scp_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
    workspaceId,
    taskId,
    label,
    auto: opts.auto ?? false,
    trigger: opts.trigger ?? 'manual',
    createdAt: new Date().toISOString(),
    sha,
    parentSha,
    fileCount: stats.files.length,
    additions: stats.additions,
    deletions: stats.deletions,
    empty,
    skipped,
    skippedTotal,
  };
  store.add(rec);
  return rec;
}

export interface ShadowDiff {
  from: string;
  to: string;
  files: { path: string; additions: number; deletions: number; binary: boolean }[];
  additions: number;
  deletions: number;
  diff: string;
  truncated: boolean;
}

/** Unified diff between two shas in a workspace's sidecar. */
export function diffShadowCheckpoints(
  store: ShadowCheckpointStore,
  workspaceId: string,
  fromSha: string,
  toSha: string,
): ShadowDiff {
  validateWorkspaceId(workspaceId);
  const gitDir = ensureSidecar(workspaceId);
  const wantType: Record<string, 'commit' | 'tree'> = {};
  for (const s of [fromSha, toSha]) {
    if (!/^[0-9a-f]{4,64}$/.test(s)) {
      throw new ShadowCheckpointError('sha must be hex', 'SHADOW_BAD_SHA');
    }
  }
  // The empty tree is a legal diff base (sidecar's first snapshot), but it
  // is a tree, not a commit.
  wantType[fromSha] = fromSha === EMPTY_TREE ? 'tree' : 'commit';
  wantType[toSha] = 'commit';
  for (const s of [fromSha, toSha]) {
    const v = git(['cat-file', '-t', s], { gitDir });
    if (v.status !== 0 || v.stdout.trim() !== wantType[s]) {
      throw new ShadowCheckpointError(`unknown commit ${s.slice(0, 12)}`, 'SHADOW_UNKNOWN_COMMIT');
    }
  }
  const stats = numstat(gitDir, fromSha, toSha);
  const r = git(['diff', '--no-color', '--no-ext-diff', fromSha, toSha, '--'], { gitDir });
  checkGit(r, 'git diff');
  let diff = r.stdout;
  let truncated = false;
  if (diff.length > MAX_SHADOW_DIFF_BYTES) {
    diff = diff.slice(0, MAX_SHADOW_DIFF_BYTES);
    truncated = true;
  }
  return { from: fromSha, to: toSha, ...stats, diff, truncated };
}

/**
 * Task-scoped diff range: from the checkpoint *before* the task's first
 * snapshot to the task's last snapshot. Returns null when the task has no
 * snapshots in this workspace.
 */
export function taskDiffRange(
  store: ShadowCheckpointStore,
  workspaceId: string,
  taskId: string,
): { base: string; tip: string; checkpoints: ShadowCheckpoint[] } | null {
  validateWorkspaceId(workspaceId);
  const rows = store
    .list(workspaceId)
    .filter((c) => c.taskId === taskId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  if (rows.length === 0) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  return { base: first.parentSha ?? EMPTY_TREE, tip: last.sha, checkpoints: rows };
}

export interface RestoreResult {
  restoredId: string;
  sha: string;
  /** Auto-created pre-restore backup checkpoint, or null when nothing changed. */
  backup: ShadowCheckpoint | null;
  /** Files created after the checkpoint that were never snapshotted — left in place. */
  leftInPlace: string[];
}

/**
 * Undo: restore a workspace to a checkpoint's content. A pre-restore
 * backup snapshot is taken first (when the workspace differs), so the
 * undo itself is reversible — "restore to this point", never "replay
 * every step backwards" (see module header).
 */
export function restoreShadowCheckpoint(
  store: ShadowCheckpointStore,
  opts: { workspaceId: string; workspacePath: string; checkpointId: string },
): RestoreResult {
  const workspaceId = validateWorkspaceId(opts.workspaceId);
  const workspacePath = resolveWorkspacePath(opts.workspacePath);
  const cp = store.get(opts.checkpointId);
  if (!cp || cp.workspaceId !== workspaceId) {
    throw new ShadowCheckpointError('checkpoint not found in this workspace', 'SHADOW_NOT_FOUND');
  }
  const gitDir = ensureSidecar(workspaceId);

  // 1. Pre-restore backup (reversibility). Skip when nothing changed —
  // there is nothing to lose, and the record would be noise.
  const backup = createShadowCheckpoint(store, {
    workspaceId,
    workspacePath,
    taskId: cp.taskId,
    label: `pre-restore backup before restoring ${cp.id}`,
    auto: true,
    trigger: 'pre-restore',
  });
  const backupRec = backup.empty ? null : backup;

  // 2. Restore tracked content to the checkpoint.
  const co = git(['checkout', '-q', cp.sha, '--', '.'], { gitDir, workTree: workspacePath });
  checkGit(co, `git checkout ${cp.sha.slice(0, 12)}`);

  // 3. Report files kept in place: tracked in the index but absent from
  // the restored commit — i.e. created after the checkpoint and never
  // snapshotted there. Empirically, `git checkout <sha> -- .` leaves such
  // index entries (and their worktree files) untouched, so they survive
  // the undo with their latest content.
  const targetFiles = new Set(lsTree(gitDir, cp.sha));
  const leftInPlace = lsFiles(gitDir, workspacePath)
    .filter((f) => !targetFiles.has(f))
    .sort()
    .slice(0, MAX_LISTED);

  return { restoredId: cp.id, sha: cp.sha, backup: backupRec, leftInPlace };
}

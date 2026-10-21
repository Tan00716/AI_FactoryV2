/**
 * Local History — JetBrains-style per-save content snapshots (R3-T6).
 *
 * Every successful file write through POST /api/file records a timestamped
 * snapshot of the written content under
 *   AI_FACTORY_DATA_DIR/local-history/<workspace>/<file>/
 * so that even non-git projects have a recoverable save history.
 *
 * This is orthogonal to shadow git checkpoints (third-wave task ⑦):
 * shadow checkpoints are task-scoped git objects; Local History is
 * save-scoped plain-text snapshots. Both coexist; neither replaces the
 * other.
 *
 * Design rules (deterministic, zero real-model dependency):
 *  - node builtins + type-only imports only, so server tests can import
 *    this module straight from src under node type-stripping (same
 *    pattern as db-time-travel.ts / coverage.ts). No enums, no
 *    parameter properties, no extensionless value imports.
 *  - Snapshot writes never throw on the save path: snapshotOnSave
 *    returns a status object; oversize / unchanged / disabled / error
 *    are explicit `skipped-*` statuses with a human-readable reason
 *    (mirrors the db-time-travel skip-and-say-plainly convention).
 *    A snapshot failure never undoes the file write.
 *  - Identical consecutive saves are skipped (skipped-unchanged) so
 *    the history is not polluted with no-op entries.
 *  - Retention: per-file snapshot count cap + per-workspace byte cap;
 *    oldest-first pruning, pruned count reported in the result.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

export class LocalHistoryError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'LocalHistoryError';
    this.code = code;
  }
}

export const LH_DEFAULT_MAX_SNAPSHOTS_PER_FILE = 50;
export const LH_DEFAULT_MAX_SNAPSHOT_BYTES = 1024 * 1024; // 1 MiB — mirrors the /api/file write cap
export const LH_DEFAULT_MAX_WORKSPACE_BYTES = 100 * 1024 * 1024; // 100 MiB — same order as db snapshots

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/** Master kill switch for environments that do not want per-save snapshots. */
export function localHistoryDisabled(): boolean {
  return (process.env.FACTORY_LOCAL_HISTORY_DISABLED ?? '') === '1';
}

export function maxSnapshotsPerFile(): number {
  return readPositiveInt(
    process.env.FACTORY_LOCAL_HISTORY_MAX_SNAPSHOTS_PER_FILE,
    LH_DEFAULT_MAX_SNAPSHOTS_PER_FILE,
  );
}

export function maxSnapshotBytes(): number {
  return readPositiveInt(
    process.env.FACTORY_LOCAL_HISTORY_MAX_SNAPSHOT_BYTES,
    LH_DEFAULT_MAX_SNAPSHOT_BYTES,
  );
}

export function maxWorkspaceHistoryBytes(): number {
  return readPositiveInt(
    process.env.FACTORY_LOCAL_HISTORY_MAX_WORKSPACE_BYTES,
    LH_DEFAULT_MAX_WORKSPACE_BYTES,
  );
}

export function localHistoryRoot(): string {
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'local-history');
}

/**
 * Stable per-workspace directory name derived from the workspace root.
 * The file server is single-workspace (WORKSPACE_ROOT = process cwd),
 * so the root path itself is the workspace identity.
 */
export function workspaceDirName(workspaceRoot: string): string {
  const root = resolve(workspaceRoot);
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 8);
  const base =
    (basename(root) || 'workspace').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) ||
    'workspace';
  return `${base}-${hash}`;
}

function sanitizeSegment(seg: string): string {
  if (seg === '..') return '__up__';
  if (seg === '.') return '__dot__';
  return seg.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/**
 * Directory holding the snapshots of one workspace-relative file.
 * Each path segment is sanitized so a crafted relPath can never
 * escape the local-history root (belt and braces — callers already
 * confined the path to the workspace).
 */
export function historyDirForFile(workspaceRoot: string, relPath: string): string {
  const segs = relPath
    .split(/[\\/]+/)
    .map(sanitizeSegment)
    .filter((s) => s.length > 0);
  if (segs.length === 0) {
    throw new LocalHistoryError('refusing to snapshot an empty file path', 'LH_BAD_PATH');
  }
  return join(localHistoryRoot(), workspaceDirName(workspaceRoot), ...segs);
}

export type SnapshotKind = 'save' | 'pre-restore';

export type SnapshotStatus =
  | 'ok'
  | 'skipped-unchanged'
  | 'skipped-too-large'
  | 'skipped-disabled'
  | 'skipped-error';

export interface SnapshotRecord {
  status: SnapshotStatus;
  /** Snapshot file name inside the file's history dir (null unless status=ok). */
  id: string | null;
  /** Human-readable reason (null when status=ok). */
  reason: string | null;
  /** Snapshots pruned by retention during this call. */
  pruned: number;
}

export interface SnapshotMeta {
  id: string;
  createdAt: string;
  kind: SnapshotKind;
  size: number;
}

const SNAPSHOT_NAME_RE = /^(\d+)-(\d{6})-(save|pre-restore)\.snap$/;

function snapshotFileName(kind: SnapshotKind): string {
  const now = Date.now();
  // hrtime sub-millisecond part disambiguates bursts within the same ms.
  const seq = String(process.hrtime.bigint() % 1000000n).padStart(6, '0');
  return `${now}-${seq}-${kind}.snap`;
}

function parseSnapshotName(name: string): { epochMs: number; kind: SnapshotKind } | null {
  const m = SNAPSHOT_NAME_RE.exec(name);
  if (!m) return null;
  return { epochMs: Number(m[1]), kind: m[3] as SnapshotKind };
}

function listSnapshotNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => SNAPSHOT_NAME_RE.test(n))
    .sort();
}

function newestSnapshot(dir: string): string | null {
  const names = listSnapshotNames(dir);
  return names.length > 0 ? names[names.length - 1] : null;
}

/** Prune one file's history dir down to the per-file count cap. Returns pruned count. */
function pruneFileDir(dir: string, cap: number): number {
  const names = listSnapshotNames(dir);
  let pruned = 0;
  while (names.length - pruned > cap) {
    try {
      unlinkSync(join(dir, names[pruned]));
    } catch {
      break;
    }
    pruned += 1;
  }
  return pruned;
}

/** Walk all snapshot files under a workspace dir (name, abs path). */
function walkSnapshots(wsDir: string): Array<{ name: string; abs: string }> {
  const out: Array<{ name: string; abs: string }> = [];
  if (!existsSync(wsDir)) return out;
  const stack: string[] = [wsDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let dirents: Array<{ name: string; isDirectory(): boolean }>;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const abs = join(dir, d.name);
      if (d.isDirectory()) stack.push(abs);
      else if (SNAPSHOT_NAME_RE.test(d.name)) out.push({ name: d.name, abs });
    }
  }
  return out;
}

/**
 * Prune the whole workspace history down to the byte cap, oldest first.
 * Returns the pruned count.
 */
function pruneWorkspace(workspaceRoot: string, capBytes: number): number {
  const wsDir = join(localHistoryRoot(), workspaceDirName(workspaceRoot));
  const snaps = walkSnapshots(wsDir);
  if (snaps.length === 0) return 0;
  let total = 0;
  const sized: Array<{ name: string; abs: string; size: number }> = [];
  for (const s of snaps) {
    let size = 0;
    try {
      size = statSync(s.abs).size;
    } catch {
      continue;
    }
    total += size;
    sized.push({ ...s, size });
  }
  sized.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let pruned = 0;
  for (const s of sized) {
    if (total <= capBytes) break;
    try {
      unlinkSync(s.abs);
      total -= s.size;
      pruned += 1;
    } catch {
      break;
    }
  }
  return pruned;
}

/**
 * Record a snapshot of freshly written content. Never throws: every
 * failure mode is reported as an explicit skipped-* status. Callers
 * (the /api/file save path) must always land the file write first and
 * treat this as best-effort history.
 */
export function snapshotOnSave(
  workspaceRoot: string,
  relPath: string,
  content: string | Buffer,
  kind: SnapshotKind,
): SnapshotRecord {
  try {
    if (localHistoryDisabled()) {
      return { status: 'skipped-disabled', id: null, reason: 'local history is disabled (FACTORY_LOCAL_HISTORY_DISABLED=1)', pruned: 0 };
    }
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const cap = maxSnapshotBytes();
    if (bytes.length > cap) {
      return {
        status: 'skipped-too-large',
        id: null,
        reason: `content is ${bytes.length} bytes, over the ${cap}-byte local-history snapshot cap`,
        pruned: 0,
      };
    }
    const dir = historyDirForFile(workspaceRoot, relPath);
    mkdirSync(dir, { recursive: true });
    // Dedup: identical consecutive saves do not create a new snapshot.
    const latest = newestSnapshot(dir);
    if (latest) {
      try {
        if (readFileSync(join(dir, latest)).equals(bytes)) {
          return { status: 'skipped-unchanged', id: null, reason: 'content identical to the latest snapshot', pruned: 0 };
        }
      } catch {
        // unreadable latest snapshot — fall through and write a fresh one
      }
    }
    const id = snapshotFileName(kind);
    writeFileSync(join(dir, id), bytes);
    let pruned = pruneFileDir(dir, maxSnapshotsPerFile());
    pruned += pruneWorkspace(workspaceRoot, maxWorkspaceHistoryBytes());
    return { status: 'ok', id, reason: null, pruned };
  } catch (err) {
    return {
      status: 'skipped-error',
      id: null,
      reason: (err as Error).message,
      pruned: 0,
    };
  }
}

/** List snapshots of one file, newest first. Never throws (returns [] on any problem). */
export function listSnapshots(workspaceRoot: string, relPath: string): SnapshotMeta[] {
  try {
    const dir = historyDirForFile(workspaceRoot, relPath);
    const names = listSnapshotNames(dir);
    const metas: SnapshotMeta[] = [];
    for (const name of names) {
      const parsed = parseSnapshotName(name);
      if (!parsed) continue;
      let size = 0;
      try {
        size = statSync(join(dir, name)).size;
      } catch {
        continue;
      }
      metas.push({
        id: name,
        createdAt: new Date(parsed.epochMs).toISOString(),
        kind: parsed.kind,
        size,
      });
    }
    metas.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return metas;
  } catch {
    return [];
  }
}

/**
 * Read one snapshot's content. Returns null when the id is unknown or
 * malformed. The id is validated against the snapshot file-name pattern,
 * so it can never be used for path traversal.
 */
export function readSnapshot(
  workspaceRoot: string,
  relPath: string,
  id: string,
): string | null {
  try {
    if (!SNAPSHOT_NAME_RE.test(id)) return null;
    const dir = historyDirForFile(workspaceRoot, relPath);
    const abs = join(dir, id);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Remove a file's whole history (used by tests). */
export function clearFileHistory(workspaceRoot: string, relPath: string): void {
  const dir = historyDirForFile(workspaceRoot, relPath);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

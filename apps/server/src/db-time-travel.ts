/**
 * Database time travel + dev/prod isolation (round-2 task 10, Replit
 * checkpoint style) — the DATA side of the shadow-checkpoint layer
 * (apps/server/src/shadow-checkpoints.ts owns the CODE side).
 *
 * When a shadow checkpoint is created, the project's *dev* SQLite
 * database (declared in <workspace>/.ai-factory/db.json) can be snapshotted
 * alongside it, under the SAME checkpoint id:
 *
 *   1. `PRAGMA wal_checkpoint(TRUNCATE)` folds the WAL back into the main
 *      file, so the file on disk is a complete, openable database.
 *   2. The file is copied atomically (temp file + rename) into
 *      AI_FACTORY_DATA_DIR/db-snapshots/<workspace-id>/<checkpoint-id>/.
 *   3. Metadata (relative path, size, sha256, status) is recorded in
 *      AI_FACTORY_DATA_DIR/db-time-travel.json, keyed by checkpoint id.
 *
 * Restore is never implicit: it needs an explicit opt-in AND an explicit
 * confirm, and it only ever writes the DEV path. Before any restore, the
 * current dev database is snapshotted again (pre-restore backup), so a
 * restore is itself reversible — the same posture as shadow undo.
 *
 * dev/prod isolation:
 * - Restore NEVER targets the prod path. If dev and prod resolve to the
 *   same file, restore refuses outright (DB_PROD_RESTORE_REFUSED).
 * - Writing data into prod is only possible through the explicit
 *   "promote" action (confirm + DB_PROMOTE audit), which copies a
 *   checkpoint snapshot over the prod file — after a pre-promote backup
 *   of the current prod file.
 *
 * Honest boundaries (also surfaced in the UI copy):
 * 1. This is a FILE-level SQLite snapshot, not point-in-time recovery —
 *    no WAL/binlog replay. A snapshot is the static state at checkpoint
 *    time; restoring overwrites everything written after it (the
 *    pre-restore backup is the safety net, and the UI says so).
 * 2. SQLite only. Postgres/MySQL/etc. are not supported in this phase.
 * 3. The WAL checkpoint is best-effort against a live writer: if another
 *    connection holds the database, wal_checkpoint may fail — then the
 *    snapshot is SKIPPED with the reason recorded, never faked.
 * 4. Symlinked database files are never followed (path-escape risk);
 *    they are skipped and the skip is recorded.
 * 5. Skip is always explicit: too-large / no-config / disabled /
 *    not-found / symlink / error are recorded in the metadata and in the
 *    audit log (DB_SNAPSHOT_SKIPPED) — never silent.
 *
 * This module imports node builtins only, so unit tests can import it
 * straight from src under node's type-stripping loader (AGENTS.md dual
 * mode rule).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export class DbTimeTravelError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'DbTimeTravelError';
    this.code = code;
  }
}

// ------------------------------------------------------------ config ----

export interface DbConfig {
  /** Dev database path, relative to the workspace root. */
  dev: string;
  /** Prod database path, relative to the workspace root (optional). */
  prod?: string;
  /** Snapshot the dev db whenever a shadow checkpoint is created. */
  snapshotOnCheckpoint: boolean;
  /** Per-project size cap override (bytes). */
  maxBytes?: number;
}

/** Default per-database snapshot size cap: 100 MiB. */
export const DEFAULT_MAX_DB_SNAPSHOT_BYTES = 100 * 1024 * 1024;
/** Hard ceiling for any configured cap. */
const MAX_DB_CAP_CEILING = 512 * 1024 * 1024;

const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Mirror of shadow-checkpoints' workspace-id validation (kept local so
 *  this module stays builtins-only / src-importable — see module header). */
export function validateDbWorkspaceId(raw: unknown): string {
  if (typeof raw !== 'string' || !WORKSPACE_ID_RE.test(raw.trim())) {
    throw new DbTimeTravelError(
      'workspaceId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}',
      'DB_BAD_WORKSPACE_ID',
    );
  }
  return raw.trim();
}

export function dbConfigPath(workspacePath: string): string {
  return join(workspacePath, '.ai-factory', 'db.json');
}

/**
 * Validate a workspace-relative database path. Must be a plain relative
 * path (no absolute, no `..`, no drive tricks) pointing at a file.
 */
export function validateDbRelPath(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 512) {
    throw new DbTimeTravelError(`${what} must be a non-empty relative path string`, 'DB_BAD_CONFIG');
  }
  const s = raw.trim().replace(/\\/g, '/');
  if (isAbsolute(s) || s.startsWith('/') || /^[A-Za-z]:/.test(s)) {
    throw new DbTimeTravelError(`${what} must be relative to the workspace root`, 'DB_BAD_CONFIG');
  }
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..')) {
    throw new DbTimeTravelError(`${what} must not escape the workspace (no "..")`, 'DB_BAD_CONFIG');
  }
  return parts.join('/');
}

/** Resolve a config-relative db path inside the workspace (path jail). */
export function resolveDbFile(workspacePath: string, relPath: string): string {
  const rel = validateDbRelPath(relPath, 'db path');
  const abs = resolve(workspacePath, rel);
  const root = resolve(workspacePath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new DbTimeTravelError('db path escapes the workspace', 'DB_PATH_ESCAPE');
  }
  return abs;
}

/** Read + validate `.ai-factory/db.json`. Returns null when absent;
 *  throws DB_CONFIG_CORRUPT / DB_BAD_CONFIG when present but invalid —
 *  a broken config must never be silently treated as "no config". */
export function readDbConfig(workspacePath: string): DbConfig | null {
  const p = dbConfigPath(workspacePath);
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    throw new DbTimeTravelError(`cannot read db config: ${(e as Error).message}`, 'DB_CONFIG_CORRUPT');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DbTimeTravelError('db config is corrupt JSON (.ai-factory/db.json)', 'DB_CONFIG_CORRUPT');
  }
  return validateDbConfig(parsed);
}

export function validateDbConfig(parsed: unknown): DbConfig {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DbTimeTravelError('db config must be a JSON object', 'DB_BAD_CONFIG');
  }
  const o = parsed as Record<string, unknown>;
  const dev = validateDbRelPath(o['dev'], 'db config "dev"');
  const prod = o['prod'] === undefined ? undefined : validateDbRelPath(o['prod'], 'db config "prod"');
  const snapshotOnCheckpoint =
    o['snapshotOnCheckpoint'] === undefined ? true : o['snapshotOnCheckpoint'];
  if (typeof snapshotOnCheckpoint !== 'boolean') {
    throw new DbTimeTravelError('db config "snapshotOnCheckpoint" must be a boolean', 'DB_BAD_CONFIG');
  }
  let maxBytes: number | undefined;
  if (o['maxBytes'] !== undefined) {
    const n = o['maxBytes'];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > MAX_DB_CAP_CEILING) {
      throw new DbTimeTravelError(
        `db config "maxBytes" must be a number in (0, ${MAX_DB_CAP_CEILING}]`,
        'DB_BAD_CONFIG',
      );
    }
    maxBytes = Math.floor(n);
  }
  return { dev, ...(prod ? { prod } : {}), snapshotOnCheckpoint, ...(maxBytes ? { maxBytes } : {}) };
}

/** Atomically write `.ai-factory/db.json` (validates first). */
export function writeDbConfig(workspacePath: string, cfg: DbConfig): DbConfig {
  const valid = validateDbConfig(cfg);
  const p = dbConfigPath(workspacePath);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
  return valid;
}

/** Effective size cap: project config > env > default. */
export function maxDbSnapshotBytes(cfg?: DbConfig | null): number {
  if (cfg?.maxBytes) return cfg.maxBytes;
  const raw = process.env.FACTORY_DB_SNAPSHOT_MAX_BYTES;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= MAX_DB_CAP_CEILING) return Math.floor(n);
  }
  return DEFAULT_MAX_DB_SNAPSHOT_BYTES;
}

// ------------------------------------------------------------- store ----

export type DbSnapshotStatus =
  | 'ok'
  | 'skipped-too-large'
  | 'skipped-no-config'
  | 'skipped-disabled'
  | 'skipped-not-found'
  | 'skipped-symlink'
  | 'skipped-error';

export interface DbSnapshotMeta {
  id: string;
  /** Shadow checkpoint id this snapshot belongs to (same id = same moment). */
  checkpointId: string;
  workspaceId: string;
  kind: 'checkpoint' | 'pre-restore' | 'pre-promote';
  /** Workspace-relative db path the snapshot was taken from. */
  relPath: string;
  /** Which environment file the bytes came from. */
  env: 'dev' | 'prod';
  size: number;
  sha256: string | null;
  status: DbSnapshotStatus;
  /** Human-readable skip/failure reason (null when status=ok). */
  reason: string | null;
  /** Snapshot file name inside dbSnapshotsRoot()/<workspaceId>/<checkpointId>/ (null when skipped). */
  snapshotFile: string | null;
  createdAt: string;
}

export function dbSnapshotsRoot(): string {
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'db-snapshots');
}

export function dbTtStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_DBTT_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'db-time-travel.json');
}

interface DbTtStoreFile {
  version: 1;
  snapshots: DbSnapshotMeta[];
}

export class DbTimeTravelStore {
  private file: DbTtStoreFile | null = null;
  private readonly path: string;
  constructor(path: string = dbTtStorePath()) {
    this.path = path;
  }

  private load(): DbTtStoreFile {
    if (this.file) return this.file;
    if (!existsSync(this.path)) {
      this.file = { version: 1, snapshots: [] };
      return this.file;
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (e) {
      throw new DbTimeTravelError(
        `cannot read db time-travel store: ${(e as Error).message}`,
        'DB_STORE_CORRUPT',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DbTimeTravelError('db time-travel store is corrupt JSON', 'DB_STORE_CORRUPT');
    }
    const p = parsed as Partial<DbTtStoreFile>;
    if (p.version !== 1 || !Array.isArray(p.snapshots)) {
      throw new DbTimeTravelError('db time-travel store has unknown shape', 'DB_STORE_CORRUPT');
    }
    this.file = p as DbTtStoreFile;
    return this.file;
  }

  private save(): void {
    const f = this.load();
    const tmp = `${this.path}.tmp-${process.pid}`;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(f, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  add(rec: DbSnapshotMeta): void {
    this.load().snapshots.push(rec);
    this.save();
  }

  /** All records for one checkpoint (newest first); normally one row. */
  forCheckpoint(checkpointId: string): DbSnapshotMeta[] {
    return this.load()
      .snapshots.filter((s) => s.checkpointId === checkpointId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Latest metadata row for a checkpoint, regardless of status. */
  latestForCheckpoint(checkpointId: string): DbSnapshotMeta | null {
    return this.forCheckpoint(checkpointId)[0] ?? null;
  }

  /** Latest *usable* snapshot for a checkpoint. */
  latestOkForCheckpoint(checkpointId: string): DbSnapshotMeta | null {
    return this.forCheckpoint(checkpointId).find((s) => s.status === 'ok' && s.snapshotFile) ?? null;
  }

  list(workspaceId: string, kind?: DbSnapshotMeta['kind']): DbSnapshotMeta[] {
    return this.load()
      .snapshots.filter((s) => s.workspaceId === workspaceId && (!kind || s.kind === kind))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}

// --------------------------------------------------------- primitives ----

export function sha256FileSync(absPath: string): string {
  const buf = readFileSync(absPath);
  return createHash('sha256').update(buf).digest('hex');
}

/** Fold the WAL back into the main file so a plain copy is consistent. */
export function walCheckpointFile(absPath: string): void {
  const db = new DatabaseSync(absPath);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function snapshotDirFor(workspaceId: string, checkpointId: string): string {
  const id = validateDbWorkspaceId(workspaceId);
  const root = dbSnapshotsRoot();
  const dir = resolve(root, id, checkpointId);
  if (!dir.startsWith(root + sep)) {
    throw new DbTimeTravelError('snapshot dir escapes db-snapshots root', 'DB_PATH_ESCAPE');
  }
  return dir;
}

export function snapshotFilePath(meta: DbSnapshotMeta): string | null {
  if (!meta.snapshotFile) return null;
  return join(snapshotDirFor(meta.workspaceId, meta.checkpointId), meta.snapshotFile);
}

/** Atomic copy: copy to a temp name in the same directory, then rename. */
function atomicCopy(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${randomUUID().slice(0, 6)}`;
  copyFileSync(src, tmp);
  renameSync(tmp, dest);
}

function safeFileName(relPath: string): string {
  return relPath.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function newMeta(partial: Omit<DbSnapshotMeta, 'id' | 'createdAt'>): DbSnapshotMeta {
  return {
    ...partial,
    id: `dbsnap_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
    createdAt: new Date().toISOString(),
  };
}

// --------------------------------------------------------- snapshot ----

export interface SnapshotForCheckpointOpts {
  workspaceId: string;
  workspacePath: string;
  checkpointId: string;
  kind?: DbSnapshotMeta['kind'];
  /** Which env file to snapshot. 'prod' is only used for pre-promote backups. */
  env?: 'dev' | 'prod';
}

/**
 * Snapshot the configured dev database for a shadow checkpoint (same id).
 * Never throws for *expected* skip conditions — every skip is recorded as
 * metadata and returned, so callers can audit it (DB_SNAPSHOT_SKIPPED).
 * Throws only for caller errors (bad workspace id / path escape).
 */
export function snapshotDbForCheckpoint(
  store: DbTimeTravelStore,
  opts: SnapshotForCheckpointOpts,
): DbSnapshotMeta {
  const workspaceId = validateDbWorkspaceId(opts.workspaceId);
  const kind = opts.kind ?? 'checkpoint';
  const env = opts.env ?? 'dev';
  const base = {
    checkpointId: opts.checkpointId,
    workspaceId,
    kind,
    env,
    relPath: '',
    size: 0,
    sha256: null as string | null,
    snapshotFile: null as string | null,
  };
  const record = (m: DbSnapshotMeta): DbSnapshotMeta => {
    store.add(m);
    return m;
  };

  let cfg: DbConfig | null;
  try {
    cfg = readDbConfig(opts.workspacePath);
  } catch (e) {
    return record(
      newMeta({
        ...base,
        status: 'skipped-error',
        reason: `db config invalid: ${(e as Error).message}`,
      }),
    );
  }
  if (!cfg) {
    return record(newMeta({ ...base, status: 'skipped-no-config', reason: 'no .ai-factory/db.json in workspace' }));
  }
  if (kind === 'checkpoint' && !cfg.snapshotOnCheckpoint) {
    return record(
      newMeta({ ...base, relPath: cfg.dev, status: 'skipped-disabled', reason: 'snapshotOnCheckpoint=false' }),
    );
  }
  const relPath = env === 'prod' ? cfg.prod : cfg.dev;
  if (!relPath) {
    return record(
      newMeta({ ...base, status: 'skipped-no-config', reason: `no "${env}" path in db config` }),
    );
  }
  const abs = resolveDbFile(opts.workspacePath, relPath);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return record(newMeta({ ...base, relPath, status: 'skipped-not-found', reason: `db file not found: ${relPath}` }));
  }
  if (st.isSymbolicLink()) {
    return record(newMeta({ ...base, relPath, status: 'skipped-symlink', reason: 'db file is a symlink — never followed' }));
  }
  if (!st.isFile()) {
    return record(newMeta({ ...base, relPath, status: 'skipped-error', reason: 'db path is not a regular file' }));
  }
  const cap = maxDbSnapshotBytes(cfg);
  if (st.size > cap) {
    return record(
      newMeta({
        ...base,
        relPath,
        size: st.size,
        status: 'skipped-too-large',
        reason: `db size ${st.size} exceeds snapshot cap ${cap}`,
      }),
    );
  }
  // WAL checkpoint first: a raw copy of a WAL-mode db without its -wal
  // file would silently lose committed-but-uncheckpointed rows.
  try {
    walCheckpointFile(abs);
  } catch (e) {
    return record(
      newMeta({
        ...base,
        relPath,
        status: 'skipped-error',
        reason: `wal_checkpoint failed: ${(e as Error).message}`,
      }),
    );
  }
  const sizeAfter = statSync(abs).size;
  if (sizeAfter > cap) {
    return record(
      newMeta({
        ...base,
        relPath,
        size: sizeAfter,
        status: 'skipped-too-large',
        reason: `db size ${sizeAfter} after wal checkpoint exceeds snapshot cap ${cap}`,
      }),
    );
  }
  const dir = snapshotDirFor(workspaceId, opts.checkpointId);
  const fileName = safeFileName(relPath);
  const dest = join(dir, fileName);
  try {
    atomicCopy(abs, dest);
  } catch (e) {
    return record(
      newMeta({
        ...base,
        relPath,
        status: 'skipped-error',
        reason: `snapshot copy failed: ${(e as Error).message}`,
      }),
    );
  }
  const sha256 = sha256FileSync(dest);
  return record(
    newMeta({ ...base, relPath, size: sizeAfter, sha256, snapshotFile: fileName, status: 'ok', reason: null }),
  );
}

// ---------------------------------------------------------- restore ----

export interface RestoreDbResult {
  checkpointId: string;
  relPath: string;
  size: number;
  sha256: string;
  /** Pre-restore backup of the dev db as it was just before restore. */
  preRestore: DbSnapshotMeta | null;
}

export interface RestoreDbOpts {
  workspaceId: string;
  workspacePath: string;
  checkpointId: string;
  /** Must be literally true — restore is never implicit. */
  confirm: unknown;
}

function requireConfirm(confirm: unknown, what: string): void {
  if (confirm !== true) {
    throw new DbTimeTravelError(
      `${what} requires explicit confirmation (confirm: true)`,
      'DB_CONFIRM_REQUIRED',
    );
  }
}

function requireRestorableSnapshot(store: DbTimeTravelStore, checkpointId: string): DbSnapshotMeta {
  const meta = store.latestOkForCheckpoint(checkpointId);
  if (!meta || !meta.snapshotFile) {
    throw new DbTimeTravelError(
      `checkpoint ${checkpointId} has no usable db snapshot`,
      'DB_NO_SNAPSHOT',
    );
  }
  const src = snapshotFilePath(meta);
  if (!src || !existsSync(src)) {
    throw new DbTimeTravelError('snapshot file is missing on disk', 'DB_NO_SNAPSHOT');
  }
  return meta;
}

/** Replace a live db file with snapshot bytes (atomic rename), dropping
 *  stale WAL sidecars so SQLite cannot replay pre-restore pages. */
function replaceDbFile(snapshotAbs: string, targetAbs: string): void {
  mkdirSync(dirname(targetAbs), { recursive: true });
  const tmp = `${targetAbs}.tmp-${process.pid}-${randomUUID().slice(0, 6)}`;
  copyFileSync(snapshotAbs, tmp);
  renameSync(tmp, targetAbs);
  for (const suffix of ['-wal', '-shm']) {
    const side = `${targetAbs}${suffix}`;
    try {
      if (existsSync(side)) unlinkSync(side);
    } catch {
      /* best effort — a live connection would recreate them */
    }
  }
}

/**
 * Restore the DEV database from a checkpoint's snapshot. Dev-only by
 * construction: the target is always config.dev, and if dev and prod
 * resolve to the same file the restore refuses (that would be a prod
 * write through the back door).
 */
export function restoreDbFromSnapshot(
  store: DbTimeTravelStore,
  opts: RestoreDbOpts,
): RestoreDbResult {
  const workspaceId = validateDbWorkspaceId(opts.workspaceId);
  requireConfirm(opts.confirm, 'db restore');
  const cfg = readDbConfig(opts.workspacePath);
  if (!cfg) {
    throw new DbTimeTravelError('no .ai-factory/db.json in workspace — nothing configured to restore', 'DB_NO_CONFIG');
  }
  const devAbs = resolveDbFile(opts.workspacePath, cfg.dev);
  if (cfg.prod) {
    const prodAbs = resolveDbFile(opts.workspacePath, cfg.prod);
    if (prodAbs === devAbs) {
      throw new DbTimeTravelError(
        'dev and prod resolve to the same file — restore would write prod; refusing',
        'DB_PROD_RESTORE_REFUSED',
      );
    }
  }
  const meta = requireRestorableSnapshot(store, opts.checkpointId);
  const src = snapshotFilePath(meta) as string;

  // Pre-restore backup first (reversibility), then overwrite dev.
  let preRestore: DbSnapshotMeta | null = null;
  if (existsSync(devAbs)) {
    preRestore = snapshotDbForCheckpoint(store, {
      workspaceId,
      workspacePath: opts.workspacePath,
      checkpointId: `prerestore-${opts.checkpointId}-${Date.now().toString(36)}`,
      kind: 'pre-restore',
      env: 'dev',
    });
    if (preRestore.status !== 'ok') {
      // The current db could not be preserved — restoring would be
      // irreversible, so refuse rather than proceed unprotected.
      throw new DbTimeTravelError(
        `pre-restore backup failed (${preRestore.status}: ${preRestore.reason}) — restore refused`,
        'DB_PRE_RESTORE_FAILED',
      );
    }
  }
  replaceDbFile(src, devAbs);
  return {
    checkpointId: opts.checkpointId,
    relPath: cfg.dev,
    size: statSync(devAbs).size,
    sha256: sha256FileSync(devAbs),
    preRestore,
  };
}

// ---------------------------------------------------------- promote ----

export interface PromoteDbResult {
  checkpointId: string;
  prodRelPath: string;
  size: number;
  sha256: string;
  /** Pre-promote backup of the prod db as it was just before promotion. */
  prePromote: DbSnapshotMeta | null;
}

/**
 * Promote a checkpoint snapshot INTO the prod database. This is the only
 * path that ever writes prod, and it is deliberately explicit: separate
 * action, confirm required, DB_PROMOTE audit at the route layer.
 */
export function promoteDbToProd(
  store: DbTimeTravelStore,
  opts: RestoreDbOpts,
): PromoteDbResult {
  const workspaceId = validateDbWorkspaceId(opts.workspaceId);
  requireConfirm(opts.confirm, 'db promote to prod');
  const cfg = readDbConfig(opts.workspacePath);
  if (!cfg) {
    throw new DbTimeTravelError('no .ai-factory/db.json in workspace — nothing configured to promote', 'DB_NO_CONFIG');
  }
  if (!cfg.prod) {
    throw new DbTimeTravelError('no "prod" path in db config — promote has no target', 'DB_NO_PROD');
  }
  const prodAbs = resolveDbFile(opts.workspacePath, cfg.prod);
  const devAbs = resolveDbFile(opts.workspacePath, cfg.dev);
  if (prodAbs === devAbs) {
    throw new DbTimeTravelError('dev and prod resolve to the same file — refusing to "promote" onto itself', 'DB_BAD_CONFIG');
  }
  const meta = requireRestorableSnapshot(store, opts.checkpointId);
  const src = snapshotFilePath(meta) as string;

  let prePromote: DbSnapshotMeta | null = null;
  if (existsSync(prodAbs)) {
    prePromote = snapshotDbForCheckpoint(store, {
      workspaceId,
      workspacePath: opts.workspacePath,
      checkpointId: `prepromote-${opts.checkpointId}-${Date.now().toString(36)}`,
      kind: 'pre-promote',
      env: 'prod',
    });
    if (prePromote.status !== 'ok') {
      throw new DbTimeTravelError(
        `pre-promote backup of current prod failed (${prePromote.status}: ${prePromote.reason}) — promote refused`,
        'DB_PRE_PROMOTE_FAILED',
      );
    }
  }
  replaceDbFile(src, prodAbs);
  return {
    checkpointId: opts.checkpointId,
    prodRelPath: cfg.prod,
    size: statSync(prodAbs).size,
    sha256: sha256FileSync(prodAbs),
    prePromote,
  };
}

/** Cleanup helper for tests/tools: drop a workspace's snapshot files. */
export function removeWorkspaceDbSnapshots(workspaceId: string): void {
  const id = validateDbWorkspaceId(workspaceId);
  const dir = resolve(dbSnapshotsRoot(), id);
  rmSync(dir, { recursive: true, force: true });
}

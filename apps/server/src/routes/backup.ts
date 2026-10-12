/**
 * Database backup / restore — Batch 13-3.
 *
 *   POST /api/backup            → create a backup of the factory database
 *   GET  /api/backups           → list backups (manifest summaries)
 *   POST /api/restore {backupId}→ validate + stage a restore
 *
 * Scope, stated plainly: the backup covers the factory DATABASE — the
 * single SQLite file (DB_PATH) that is the server's system of record
 * for projects, tasks, evidence, approvals, the audit chain, memory,
 * requirements, run records, step intents, operations and checkpoints.
 * Project working files on disk (source trees, per-project .ai/ config)
 * are NOT in the database and are NOT part of this backup.
 *
 * Backup shape: a self-contained DIRECTORY under the backup dir
 * (env FACTORY_BACKUP_DIR, default <db dir>/backups):
 *   <backupId>/factory.db    — VACUUM INTO snapshot (committed state
 *                              only; never a raw copy of the live file)
 *   <backupId>/manifest.json — createdAt, app version, source DB file
 *                              name, per-file bytes+sha256, per-table
 *                              row counts (counted FROM the snapshot,
 *                              so the manifest describes the backup
 *                              itself, not the live DB beside it)
 * The zero-dependency convention rules out zip; a directory + manifest
 * hashes gives the same integrity story with only node: builtins.
 *
 * Restore semantics — honest staging, no fake hot swap:
 * The process holds a web of stores/managers constructed over one
 * connection; swapping the file under them is not safe. So restore is:
 *   1. validate: manifest parses, every listed file's size + sha256
 *      matches, the snapshot opens and passes PRAGMA integrity_check.
 *      ANY failure → 422 and the live database is untouched.
 *   2. safety: a 'pre-restore' backup of the CURRENT live database is
 *      taken first — a mistaken restore always has a way back.
 *   3. stage: the verified snapshot is copied to <db>.restore-pending
 *      (+ a JSON sidecar naming the backup). NOTHING in the running
 *      process changes; the response says restartRequired: true.
 *   4. apply: at the next startup, BEFORE the database is opened,
 *      applyPendingRestore() renames the live file (with its -wal/-shm
 *      sidecars — a stale WAL replayed over a replaced file would
 *      corrupt the restore) to <db>.superseded-<ts>, moves the staged
 *      file into place, and the boot writes a RESTORE_APPLIED audit
 *      record into the restored database. The superseded file and the
 *      pre-restore backup keep the full trail: the old DB contains the
 *      RESTORE_STAGED record, the new one the RESTORE_APPLIED record.
 *
 * Both endpoints sit behind the same FACTORY_API_TOKEN gate as every
 * other /api route (enforced pre-dispatch in index.ts — no bypass).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'http';
import type { FactoryDatabase } from '@ai-factory/db';
import type { RouteContext } from './context';

export const BACKUP_FORMAT = 'ai-factory-backup/1';
export const BACKUP_DB_FILE = 'factory.db';
export const RESTORE_PENDING_SUFFIX = '.restore-pending';

export interface BackupManifestFile {
  name: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: string;
  backupId: string;
  kind: 'manual' | 'pre-restore';
  createdAt: string;
  appVersion: string;
  sourceDbFile: string;
  /** Backup covers the factory database only — see module docstring. */
  scope: 'factory-database';
  files: BackupManifestFile[];
  tables: Record<string, number>;
}

export interface BackupServiceConfig {
  /** Absolute path of the live database file (DB_PATH resolved). */
  dbPath: string;
  /** Absolute path of the directory holding backup directories. */
  backupDir: string;
  appVersion: string;
}

let config: BackupServiceConfig | null = null;

/** Coordinator wiring (index.ts), before the server takes traffic. */
export function initBackupService(cfg: BackupServiceConfig): void {
  config = cfg;
}

function svc(): BackupServiceConfig {
  if (!config) throw new Error('backup service not initialized');
  return config;
}

function appVersion(): string {
  try {
    // Compiled layout: dist/routes/backup.js → ../../package.json is
    // the server package. Guarded: if this module is ever loaded from
    // src via an ESM type-stripping test, __dirname is absent and the
    // version honestly reports 'unknown' instead of throwing.
    const dir = typeof __dirname === 'string' ? __dirname : null;
    if (!dir) return 'unknown';
    const raw = fs.readFileSync(path.join(dir, '..', '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Resolve the backup service config from env + live DB path (index.ts). */
export function resolveBackupConfig(dbPath: string): BackupServiceConfig {
  const absDb = path.resolve(dbPath);
  const backupDir = process.env['FACTORY_BACKUP_DIR']
    ? path.resolve(process.env['FACTORY_BACKUP_DIR'])
    : path.join(path.dirname(absDb), 'backups');
  return { dbPath: absDb, backupDir, appVersion: appVersion() };
}

// ------------------------------------------------------------- internals --

function newBackupId(kind: 'manual' | 'pre-restore'): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `${kind === 'pre-restore' ? 'pre-restore' : 'backup'}-${ts}-${rand}`;
}

function sha256File(file: string): { bytes: number; sha256: string } {
  const data = fs.readFileSync(file);
  return {
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

/**
 * Count rows and run integrity_check on a snapshot file itself, opened
 * read-only — the manifest must describe the backup, not the live DB.
 */
function inspectSnapshot(file: string): {
  tables: Record<string, number>;
  integrity: string;
} {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as
      | Record<string, unknown>
      | undefined;
    const integrity = String(
      integrityRow?.['integrity_check'] ?? 'unknown',
    );
    const tables: Record<string, number> = {};
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[];
    for (const { name } of names) {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`)
        .get() as { n: number };
      tables[name] = Number(row.n);
    }
    return { tables, integrity };
  } finally {
    db.close();
  }
}

/** Create a backup of the live database. Used by the route AND restore. */
export function createBackup(
  fdb: FactoryDatabase,
  kind: 'manual' | 'pre-restore',
): { backupId: string; dir: string; manifest: BackupManifest } {
  const cfg = svc();
  const backupId = newBackupId(kind);
  const dir = path.join(cfg.backupDir, backupId);
  fs.mkdirSync(dir, { recursive: true });
  const snapshotPath = path.join(dir, BACKUP_DB_FILE);
  fdb.snapshotTo(snapshotPath);
  const { tables, integrity } = inspectSnapshot(snapshotPath);
  if (integrity !== 'ok') {
    throw new Error(`snapshot failed integrity_check: ${integrity}`);
  }
  const fileInfo = sha256File(snapshotPath);
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    backupId,
    kind,
    createdAt: new Date().toISOString(),
    appVersion: cfg.appVersion,
    sourceDbFile: path.basename(cfg.dbPath),
    scope: 'factory-database',
    files: [{ name: BACKUP_DB_FILE, bytes: fileInfo.bytes, sha256: fileInfo.sha256 }],
    tables,
  };
  // manifest lands last (tmp + rename): a directory without a complete
  // manifest is visibly not a finished backup.
  const tmp = path.join(dir, 'manifest.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, path.join(dir, 'manifest.json'));
  return { backupId, dir, manifest };
}

function readManifest(dir: string): BackupManifest | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
    ) as BackupManifest;
    return parsed && parsed.format === BACKUP_FORMAT ? parsed : null;
  } catch {
    return null;
  }
}

function listBackups(): BackupManifest[] {
  const cfg = svc();
  if (!fs.existsSync(cfg.backupDir)) return [];
  const out: BackupManifest[] = [];
  for (const entry of fs.readdirSync(cfg.backupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = readManifest(path.join(cfg.backupDir, entry.name));
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const BACKUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isValidBackupId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 128 &&
    BACKUP_ID_RE.test(id) &&
    !id.includes('..')
  );
}

// ------------------------------------------------------- staged restore --

export interface PendingRestoreInfo {
  backupId: string;
  stagedAt: string;
  preRestoreBackupId: string;
}

export function pendingRestorePath(dbPath: string): string {
  return dbPath + RESTORE_PENDING_SUFFIX;
}

function readPendingInfo(dbPath: string): PendingRestoreInfo | null {
  try {
    return JSON.parse(
      fs.readFileSync(pendingRestorePath(dbPath) + '.json', 'utf8'),
    ) as PendingRestoreInfo;
  } catch {
    return null;
  }
}

/**
 * Startup step (index.ts, BEFORE FactoryDatabase is constructed): if a
 * restore was staged, move it into place. The outgoing database is
 * renamed — never deleted — to <db>.superseded-<ts> together with its
 * WAL sidecars, so the swap is recoverable by hand and the audit trail
 * (RESTORE_STAGED in the old file, RESTORE_APPLIED written by the
 * caller into the new one) stays complete.
 */
export function applyPendingRestore(dbPath: string): {
  applied: boolean;
  info?: PendingRestoreInfo;
  supersededPath?: string;
} {
  const staged = pendingRestorePath(dbPath);
  if (!fs.existsSync(staged)) return { applied: false };
  const info = readPendingInfo(dbPath) ?? undefined;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const supersededPath = `${dbPath}.superseded-${ts}`;
  if (fs.existsSync(dbPath)) fs.renameSync(dbPath, supersededPath);
  // A stale WAL/SHM belongs to the outgoing database: moving them with
  // it is not optional — replayed over the restored file they would
  // resurrect pre-restore writes.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix;
    if (fs.existsSync(sidecar)) fs.renameSync(sidecar, supersededPath + suffix);
  }
  fs.renameSync(staged, dbPath);
  fs.rmSync(staged + '.json', { force: true });
  return { applied: true, info, supersededPath };
}

// ---------------------------------------------------------------- routes --

export async function handleBackupRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const { json, readBody, audit, fdb } = ctx;
  const method = req.method ?? 'GET';
  const p = url.pathname;

  if (p === '/api/backup' && method === 'POST') {
    try {
      const { backupId, dir, manifest } = createBackup(fdb, 'manual');
      audit.record('human', 'BACKUP_CREATED', 'backup', backupId, {
        dir,
        tables: manifest.tables,
        bytes: manifest.files[0]?.bytes ?? 0,
      });
      json(res, 201, { backupId, kind: manifest.kind, dir, manifest });
      return true;
    } catch (e) {
      json(res, 500, { error: `backup failed: ${(e as Error).message}` });
      return true;
    }
  }

  if (p === '/api/backups' && method === 'GET') {
    const backups = listBackups().map((m) => ({
      backupId: m.backupId,
      kind: m.kind,
      createdAt: m.createdAt,
      appVersion: m.appVersion,
      tables: m.tables,
      totalRows: Object.values(m.tables).reduce((a, b) => a + b, 0),
      bytes: m.files.reduce((a, f) => a + f.bytes, 0),
    }));
    const info = readPendingInfo(svc().dbPath);
    json(res, 200, {
      backups,
      pendingRestore: info ? { ...info, restartRequired: true } : null,
    });
    return true;
  }

  if (p === '/api/restore' && method === 'POST') {
    const b = await readBody(req);
    const backupId = b['backupId'];
    if (!isValidBackupId(backupId)) {
      json(res, 400, { error: 'backupId (a backup directory name) is required' });
      return true;
    }
    const cfg = svc();
    const dir = path.join(cfg.backupDir, backupId);
    const manifest = fs.existsSync(dir) ? readManifest(dir) : null;
    if (!manifest) {
      json(res, 404, { error: `unknown backup: ${backupId}` });
      return true;
    }
    // -- validate: hashes + integrity BEFORE anything is staged --------
    const problems: string[] = [];
    for (const f of manifest.files) {
      if (f.name !== BACKUP_DB_FILE || f.name.includes('/') || f.name.includes('\\')) {
        problems.push(`unexpected file entry in manifest: ${f.name}`);
        continue;
      }
      const file = path.join(dir, f.name);
      if (!fs.existsSync(file)) {
        problems.push(`missing file: ${f.name}`);
        continue;
      }
      const actual = sha256File(file);
      if (actual.bytes !== f.bytes) {
        problems.push(`${f.name}: size mismatch (manifest ${f.bytes}, actual ${actual.bytes})`);
      } else if (actual.sha256 !== f.sha256) {
        problems.push(`${f.name}: sha256 mismatch`);
      }
    }
    if (problems.length === 0) {
      try {
        const { integrity } = inspectSnapshot(path.join(dir, BACKUP_DB_FILE));
        if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);
      } catch (e) {
        problems.push(`snapshot unreadable: ${(e as Error).message}`);
      }
    }
    if (problems.length > 0) {
      audit.record('human', 'RESTORE_REJECTED', 'backup', backupId, {
        problems,
      });
      json(res, 422, {
        error: 'backup failed validation; live database untouched',
        problems,
      });
      return true;
    }
    // -- one staged restore at a time -----------------------------------
    if (fs.existsSync(pendingRestorePath(cfg.dbPath))) {
      const existing = readPendingInfo(cfg.dbPath);
      json(res, 409, {
        error: `a restore is already staged (backup ${existing?.backupId ?? 'unknown'}) — restart the server to apply it before staging another`,
        pendingRestore: existing,
      });
      return true;
    }
    // -- safety net: back up the CURRENT database first ------------------
    let preRestore: ReturnType<typeof createBackup>;
    try {
      preRestore = createBackup(fdb, 'pre-restore');
    } catch (e) {
      json(res, 500, {
        error: `pre-restore backup failed, restore NOT staged: ${(e as Error).message}`,
      });
      return true;
    }
    // -- stage (copy via tmp + rename: no torn staging file) -------------
    const staged = pendingRestorePath(cfg.dbPath);
    const tmp = `${staged}.tmp-${Math.floor(Math.random() * 0xffffff).toString(16)}`;
    fs.copyFileSync(path.join(dir, BACKUP_DB_FILE), tmp);
    const fd = fs.openSync(tmp, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, staged);
    const info: PendingRestoreInfo = {
      backupId,
      stagedAt: new Date().toISOString(),
      preRestoreBackupId: preRestore.backupId,
    };
    fs.writeFileSync(staged + '.json', JSON.stringify(info, null, 2));
    audit.record('human', 'RESTORE_STAGED', 'backup', backupId, {
      ...info,
      restartRequired: true,
    });
    json(res, 200, {
      ok: true,
      restartRequired: true,
      backupId,
      preRestoreBackupId: preRestore.backupId,
      message:
        'Restore staged. The running server keeps serving the current database; ' +
        'restart the server to apply the restore. The current database was backed ' +
        `up first (pre-restore backup ${preRestore.backupId}) and will be kept as a ` +
        '.superseded file next to the database when the restore is applied.',
    });
    return true;
  }

  return false;
}

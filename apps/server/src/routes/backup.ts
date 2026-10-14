/**
 * Database backup / restore — Batch 13-3.
 *
 *   POST /api/backup            → create a backup of the factory database
 *   GET  /api/backups           → list backups (manifest summaries)
 *     (each list item carries `backupId` — not `id` — plus kind, scope,
 *     createdAt, appVersion, tables, totalRows, bytes, and a projectFiles
 *     summary when the backup carries working trees)
 *   POST /api/restore {backupId}→ validate + stage a restore
 *   POST /api/restore/project-files {backupId}
 *     → validate + immediately restore project working files
 *        (Batch 45-4; the database restore stays staged for reboot)
 *
 * Scope, stated plainly: the backup covers the factory DATABASE — the
 * single SQLite file (DB_PATH) that is the server's system of record
 * for projects, tasks, evidence, approvals, the audit chain, memory,
 * requirements, run records, step intents, operations and checkpoints —
 * PLUS (Batch 45-4) each active project's working files on disk,
 * including the per-project `.ai/` config directories. What is NOT
 * backed up, and why, lives in project-files-backup.ts and
 * docs/KNOWN_LIMITATIONS.md: archived projects, symlinks (never
 * followed), dependency/build/VCS directories (node_modules, dist,
 * .git, …), files over the size caps.
 *
 * Backup shape: a self-contained DIRECTORY under the backup dir
 * (env FACTORY_BACKUP_DIR, default <db dir>/backups):
 *   <backupId>/factory.db    — VACUUM INTO snapshot (committed state
 *                              only; never a raw copy of the live file)
 *   <backupId>/projects/<pid>/… — project working files (Batch 45-4),
 *                              manifest entry names
 *                              `projects/<pid>/<relpath>`
 *   <backupId>/manifest.json — createdAt, app version, source DB file
 *                              name, per-file bytes+sha256, per-table
 *                              row counts (counted FROM the snapshot,
 *                              so the manifest describes the backup
 *                              itself, not the live DB beside it),
 *                              plus the project-files section
 *                              (per-project file lists, hashes, and
 *                              the skip records for excluded/over-cap
 *                              files — skipped files are RECORDED,
 *                              never silently dropped).
 * The zero-dependency convention rules out zip; a directory + manifest
 * hashes gives the same integrity story with only node: builtins.
 *
 * Restore semantics — honest staging, no fake hot swap:
 * The process holds a web of stores/managers constructed over one
 * connection; swapping the file under them is not safe. So DATABASE
 * restore is:
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
 * PROJECT-FILES restore (POST /api/restore/project-files, Batch 45-4)
 * is deliberately NOT staged: unlike the database, no long-lived
 * process handle pins the project trees, so the restore applies
 * immediately — but only after (1) every project file's size + sha256
 * validates and (2) a pre-restore copy of the CURRENT project files is
 * taken into the backup dir. ANY validation failure → 422 and nothing
 * is touched. The asymmetry (DB staged, files immediate) is stated
 * here so nobody mistakes it for an oversight.
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

export interface BackupManifestProject {
  projectId: string;
  name: string;
  path: string;
  fileCount: number;
  bytes: number;
  skipped: SkippedProjectFile[];
}

export interface BackupManifest {
  format: string;
  backupId: string;
  kind: 'manual' | 'pre-restore' | 'scheduled';
  createdAt: string;
  appVersion: string;
  sourceDbFile: string;
  /** 'factory-database' for DB-only backups; '+project-files' when at least one project's tree was actually collected. */
  scope: 'factory-database' | 'factory-database+project-files';
  files: BackupManifestFile[];
  tables: Record<string, number>;
  /** Present when scope is 'factory-database+project-files'. */
  projectFiles?: {
    projects: BackupManifestProject[];
    maxFileBytes: number;
    maxTotalBytes: number;
    excludeDirs: string[];
  };
}

export interface BackupServiceConfig {
  /** Absolute path of the live database file (DB_PATH resolved). */
  dbPath: string;
  /** Absolute path of the directory holding backup directories. */
  backupDir: string;
  appVersion: string;
  /** Project working-files collection (Batch 45-4). */
  projectFiles: ProjectFilesConfig;
}

let config: BackupServiceConfig | null = null;

/** Coordinator wiring (index.ts), before the server takes traffic. */
export function initBackupService(
  cfg: Omit<BackupServiceConfig, 'projectFiles'> & {
    projectFiles?: ProjectFilesConfig;
  },
): void {
  config = {
    ...cfg,
    projectFiles: cfg.projectFiles ?? resolveProjectFilesConfig(),
  };
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
  return {
    dbPath: absDb,
    backupDir,
    appVersion: appVersion(),
    projectFiles: resolveProjectFilesConfig(),
  };
}

// ------------------------------------------------------------- internals --

function newBackupId(kind: 'manual' | 'pre-restore' | 'scheduled'): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  const prefix =
    kind === 'pre-restore' ? 'pre-restore' : kind === 'scheduled' ? 'scheduled' : 'backup';
  return `${prefix}-${ts}-${rand}`;
}

function sha256File(file: string): { bytes: number; sha256: string } {
  const data = fs.readFileSync(file);
  return {
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

// ------------------------------------------- project working files ------
// Batch 45-4: the database backup above is extended to each active
// project's working directory (including `.ai/`). Boundaries, stated
// plainly (also in docs/KNOWN_LIMITATIONS.md):
//  - archived projects are skipped (listProjects() excludes them);
//  - symlinks are NEVER followed (a symlink could point anywhere on the
//    host) — recorded as skipped, not copied;
//  - size caps (env-overridable): per-file and per-backup totals; over-cap
//    files are recorded as skipped, never silently dropped;
//  - default excludes: dependency/build/VCS dirs (node_modules, dist,
//    build, .git, .hg, .svn, coverage, __pycache__, .venv/venv, .next,
//    .nuxt) and junk suffixes (.log, .tmp, .DS_Store) — regenerable or
//    machine-local, zero restore value per byte.
// Kept in this file (not a sibling module) so this route module's value
// imports stay node-builtins-only — retention.test.ts imports it straight
// from src under node type-stripping (dual-mode rule).

export interface ProjectFilesConfig {
  /** Master switch. Default true. */
  enabled: boolean;
  /** Files larger than this are skipped (recorded, not copied). Default 25 MiB. */
  maxFileBytes: number;
  /** Stop collecting once a single backup exceeds this (rest recorded as skipped). Default 512 MiB. */
  maxTotalBytes: number;
  /** Directory basenames never descended into. */
  excludeDirs: string[];
  /** Filename suffixes never collected. */
  excludeSuffixes: string[];
}

export const DEFAULT_PROJECT_EXCLUDE_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  '.git',
  '.hg',
  '.svn',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
];

export const DEFAULT_PROJECT_EXCLUDE_SUFFIXES: readonly string[] = [
  '.log',
  '.tmp',
  '.DS_Store',
];

const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Resolve from env (index.ts passes the real process.env). */
export function resolveProjectFilesConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProjectFilesConfig {
  return {
    enabled: env['FACTORY_BACKUP_PROJECT_FILES'] !== '0',
    maxFileBytes: parsePositiveInt(
      env['FACTORY_BACKUP_MAX_FILE_BYTES'],
      DEFAULT_MAX_FILE_BYTES,
    ),
    maxTotalBytes: parsePositiveInt(
      env['FACTORY_BACKUP_MAX_TOTAL_BYTES'],
      DEFAULT_MAX_TOTAL_BYTES,
    ),
    excludeDirs: [
      ...DEFAULT_PROJECT_EXCLUDE_DIRS,
      ...parseList(env['FACTORY_BACKUP_EXCLUDE_DIRS']),
    ],
    excludeSuffixes: [
      ...DEFAULT_PROJECT_EXCLUDE_SUFFIXES,
      ...parseList(env['FACTORY_BACKUP_EXCLUDE_SUFFIXES']),
    ],
  };
}

export interface CollectedProjectFile {
  /** posix-style path relative to the project directory */
  rel: string;
  bytes: number;
  sha256: string;
}

export type ProjectFileSkipReason =
  | 'symlink'
  | 'excluded-dir'
  | 'excluded-suffix'
  | 'over-file-limit'
  | 'over-total-limit'
  | 'unreadable';

export interface SkippedProjectFile {
  rel: string;
  reason: ProjectFileSkipReason;
}

export interface ProjectFilesCollectResult {
  files: CollectedProjectFile[];
  skipped: SkippedProjectFile[];
  totalBytes: number;
}

function toPosixRel(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Walk a project directory and record every collectible file.
 * Deterministic order (sorted). Never follows symlinks. Never throws
 * for unreadable files — they are recorded as skipped.
 */
export function collectProjectFiles(
  projectDir: string,
  cfg: ProjectFilesConfig,
  excludePaths: string[] = [],
): ProjectFilesCollectResult {
  const root = path.resolve(projectDir);
  const excluded = excludePaths.map((p) => path.resolve(p));
  const files: CollectedProjectFile[] = [];
  const skipped: SkippedProjectFile[] = [];
  let totalBytes = 0;
  let overTotal = false;

  const underExcludedPath = (full: string): boolean =>
    excluded.some((ep) => full === ep || full.startsWith(ep + path.sep));

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped.push({
        rel: toPosixRel(path.relative(root, dir)) || '.',
        reason: 'unreadable',
      });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = toPosixRel(path.relative(root, full));
      if (underExcludedPath(full)) continue;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        skipped.push({ rel, reason: 'unreadable' });
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped.push({ rel, reason: 'symlink' });
        continue;
      }
      if (st.isDirectory()) {
        if (cfg.excludeDirs.includes(entry.name)) {
          skipped.push({ rel, reason: 'excluded-dir' });
          continue;
        }
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (cfg.excludeSuffixes.some((s) => entry.name.endsWith(s))) {
        skipped.push({ rel, reason: 'excluded-suffix' });
        continue;
      }
      if (overTotal) {
        skipped.push({ rel, reason: 'over-total-limit' });
        continue;
      }
      if (st.size > cfg.maxFileBytes) {
        skipped.push({ rel, reason: 'over-file-limit' });
        continue;
      }
      if (totalBytes + st.size > cfg.maxTotalBytes) {
        overTotal = true;
        skipped.push({ rel, reason: 'over-total-limit' });
        continue;
      }
      let hashed: { bytes: number; sha256: string };
      try {
        hashed = sha256File(full);
      } catch {
        skipped.push({ rel, reason: 'unreadable' });
        continue;
      }
      totalBytes += hashed.bytes;
      files.push({ rel, bytes: hashed.bytes, sha256: hashed.sha256 });
    }
  };

  walk(root);
  return { files, skipped, totalBytes };
}

/** Manifest-safe directory name for a project id. */
export function safeProjectId(projectId: string): string {
  const safe = projectId.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe.length > 0 ? safe : '_';
}

/** Manifest entry name for a project file: `projects/<safeId>/<rel>`. */
export function projectFileEntryName(projectId: string, rel: string): string {
  return `projects/${safeProjectId(projectId)}/${rel}`;
}

/** Validate a manifest file entry that lives under projects/. */
export function isProjectFileEntry(name: string): boolean {
  if (!name.startsWith('projects/')) return false;
  const rest = name.slice('projects/'.length);
  if (!rest || rest.includes('\\')) return false;
  const segs = rest.split('/');
  return (
    segs.length >= 2 && segs.every((s) => s.length > 0 && s !== '.' && s !== '..')
  );
}

/**
 * Copy collected files into <destRoot>/<safeId>/, preserving relative
 * paths. `rel` values come from our own walker, but the traversal guard
 * stays — restore paths reuse this shape with manifest-supplied rels.
 */
export function copyProjectFiles(
  projectDir: string,
  destRoot: string,
  projectId: string,
  files: CollectedProjectFile[],
): void {
  const root = path.resolve(projectDir);
  const dest = path.join(path.resolve(destRoot), safeProjectId(projectId));
  for (const f of files) {
    const src = path.join(root, ...f.rel.split('/'));
    const target = path.join(dest, ...f.rel.split('/'));
    if (path.relative(dest, target).startsWith('..')) {
      throw new Error(`refusing to write outside destination: ${f.rel}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(src, target);
  }
}

/**
 * Restore project files from a backup into the live project directory.
 * A pre-restore copy of the CURRENT files is taken first into
 * preRestoreDir (the rollback stays roll-backable); every restored file
 * is re-hashed after copy and a mismatch throws, aborting the restore.
 */
export function restoreProjectFiles(
  backupProjectsDir: string,
  projectId: string,
  projectDir: string,
  files: CollectedProjectFile[],
  preRestoreDir: string,
): { restored: number; preRestoreDir: string } {
  const src = path.join(
    path.resolve(backupProjectsDir),
    safeProjectId(projectId),
  );
  const dest = path.resolve(projectDir);
  if (!fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) {
    throw new Error(`project directory not found: ${dest}`);
  }
  const preDir = path.join(path.resolve(preRestoreDir), safeProjectId(projectId));
  fs.mkdirSync(preDir, { recursive: true });
  for (const f of files) {
    const current = path.join(dest, ...f.rel.split('/'));
    if (fs.existsSync(current) && fs.statSync(current).isFile()) {
      const target = path.join(preDir, ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(current, target);
    }
  }
  let restored = 0;
  for (const f of files) {
    const from = path.join(src, ...f.rel.split('/'));
    const to = path.join(dest, ...f.rel.split('/'));
    if (path.relative(dest, to).startsWith('..')) {
      throw new Error(`refusing to write outside project dir: ${f.rel}`);
    }
    if (!fs.existsSync(from)) {
      throw new Error(`backup is missing file: projects/${projectId}/${f.rel}`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    const actual = sha256File(to);
    if (actual.sha256 !== f.sha256) {
      throw new Error(`hash mismatch after restore: projects/${projectId}/${f.rel}`);
    }
    restored++;
  }
  return { restored, preRestoreDir: preDir };
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

/**
 * Create a backup of the live database. Used by the manual route, the
 * restore safety net, and the Batch 20 backup scheduler ('scheduled').
 *
 * Batch 45-4: when the project-files collection is enabled, every
 * active project with a working directory on disk rides along under
 * <backupId>/projects/<projectId>/. Skipped files (excluded dirs,
 * symlinks, over-cap) are RECORDED in the manifest, never silently
 * dropped — a backup whose tree was half-skipped says so.
 */
export function createBackup(
  fdb: FactoryDatabase,
  kind: 'manual' | 'pre-restore' | 'scheduled',
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
  const files: BackupManifestFile[] = [
    { name: BACKUP_DB_FILE, bytes: fileInfo.bytes, sha256: fileInfo.sha256 },
  ];

  // ---- project working files (Batch 45-4) -------------------------
  const backedProjects: BackupManifestProject[] = [];
  if (cfg.projectFiles.enabled) {
    const projectsRoot = path.join(dir, 'projects');
    // listProjects() excludes archived projects by default — archived
    // trees are the operator's to keep, not the backup service's.
    for (const p of fdb.listProjects()) {
      const projectDir = (p.path ?? '').trim();
      if (!projectDir) continue;
      const abs = path.resolve(projectDir);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
      const collected = collectProjectFiles(abs, cfg.projectFiles, [
        cfg.backupDir,
      ]);
      copyProjectFiles(abs, projectsRoot, p.id, collected.files);
      for (const f of collected.files) {
        files.push({
          name: projectFileEntryName(p.id, f.rel),
          bytes: f.bytes,
          sha256: f.sha256,
        });
      }
      backedProjects.push({
        projectId: p.id,
        name: p.name,
        path: abs,
        fileCount: collected.files.length,
        bytes: collected.totalBytes,
        skipped: collected.skipped,
      });
    }
  }
  // The scope names what the backup ACTUALLY contains: '+project-files'
  // only when at least one project's tree was collected.
  const scope: BackupManifest['scope'] =
    backedProjects.length > 0 ? 'factory-database+project-files' : 'factory-database';

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    backupId,
    kind,
    createdAt: new Date().toISOString(),
    appVersion: cfg.appVersion,
    sourceDbFile: path.basename(cfg.dbPath),
    scope,
    files,
    tables,
    ...(scope === 'factory-database+project-files'
      ? {
          projectFiles: {
            projects: backedProjects,
            maxFileBytes: cfg.projectFiles.maxFileBytes,
            maxTotalBytes: cfg.projectFiles.maxTotalBytes,
            excludeDirs: cfg.projectFiles.excludeDirs,
          },
        }
      : {}),
  };
  // manifest lands last (tmp + rename): a directory without a complete
  // manifest is visibly not a finished backup.
  const tmp = path.join(dir, 'manifest.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, path.join(dir, 'manifest.json'));
  return { backupId, dir, manifest };
}

/**
 * Validate every file listed in a backup manifest against the files on
 * disk (size + sha256). The database snapshot additionally gets
 * PRAGMA integrity_check. Returns the list of problems (empty = valid).
 * Batch 45-4: project-file entries (`projects/<id>/<rel>`) validate the
 * same way — a tampered working tree is refused exactly like a tampered
 * database snapshot.
 */
export function validateBackupFiles(
  dir: string,
  manifest: BackupManifest,
): string[] {
  const problems: string[] = [];
  for (const f of manifest.files) {
    const isDb = f.name === BACKUP_DB_FILE;
    const isProjectFile = isProjectFileEntry(f.name);
    if (!isDb && !isProjectFile) {
      problems.push(`unexpected file entry in manifest: ${f.name}`);
      continue;
    }
    const file = path.join(dir, ...f.name.split('/'));
    if (path.relative(dir, file).startsWith('..')) {
      problems.push(`file entry escapes backup dir: ${f.name}`);
      continue;
    }
    if (!fs.existsSync(file)) {
      problems.push(`missing file: ${f.name}`);
      continue;
    }
    const actual = sha256File(file);
    if (actual.bytes !== f.bytes) {
      problems.push(
        `${f.name}: size mismatch (manifest ${f.bytes}, actual ${actual.bytes})`,
      );
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
  return problems;
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

/** Read accessors for the retention module (§47, Batch 14) — the
 * retention routes age/delete backup directories against the same
 * manifests and pending-restore state this module owns. */
export function backupDirPath(): string {
  return svc().backupDir;
}

export function listBackupManifests(): BackupManifest[] {
  return listBackups();
}

/** Backup id staged for restore at next boot, if any — retention must
 * never delete the snapshot a pending restore will boot from. */
export function stagedRestoreBackupId(): string | null {
  return readPendingInfo(svc().dbPath)?.backupId ?? null;
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

// ------------------------------------------------- project files restore --
// Batch 45-4. Unlike the database restore (staged for the next boot
// because the process holds the DB open), project working files are
// restored immediately: no long-lived handle pins them. Safety still
// comes first — every file validates BEFORE anything is written, and a
// pre-restore copy of the current files is taken so the restore itself
// can be rolled back.

export class ProjectFilesRestoreError extends Error {
  status: 400 | 404 | 422 | 500;
  problems?: string[];
  constructor(status: 400 | 404 | 422 | 500, message: string, problems?: string[]) {
    super(message);
    this.status = status;
    this.problems = problems;
  }
}

export interface ProjectFilesRestoreResult {
  backupId: string;
  projects: Array<{
    projectId: string;
    name: string;
    path: string;
    restored: number;
    bytes: number;
  }>;
  skipped: Array<{ projectId: string; name: string; reason: string }>;
  preRestoreDir: string;
}

/**
 * Restore project working files from a backup into the live project
 * directories. Throws ProjectFilesRestoreError (404 unknown backup,
 * 422 validation failure, 500 restore failure). On 422 nothing is
 * touched; on success the pre-restore copy lets the operator roll back.
 */
export function restoreProjectFilesFromBackup(
  fdb: FactoryDatabase,
  backupId: string,
): ProjectFilesRestoreResult {
  const cfg = svc();
  const dir = path.join(cfg.backupDir, backupId);
  const manifest = fs.existsSync(dir) ? readManifest(dir) : null;
  if (!manifest) {
    throw new ProjectFilesRestoreError(404, `unknown backup: ${backupId}`);
  }
  const pf = manifest.projectFiles;
  if (manifest.scope !== 'factory-database+project-files' || !pf) {
    throw new ProjectFilesRestoreError(
      422,
      `backup ${backupId} carries no project files (scope: ${manifest.scope})`,
    );
  }
  const problems = validateBackupFiles(dir, manifest);
  if (problems.length > 0) {
    throw new ProjectFilesRestoreError(
      422,
      `backup ${backupId} failed validation; project files untouched`,
      problems,
    );
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  const preRestoreDir = path.join(cfg.backupDir, `pre-restore-pf-${ts}-${rand}`);
  fs.mkdirSync(preRestoreDir, { recursive: true });

  const backupProjectsDir = path.join(dir, 'projects');
  const result: ProjectFilesRestoreResult = {
    backupId,
    projects: [],
    skipped: [],
    preRestoreDir,
  };
  try {
    for (const proj of pf.projects) {
      // Prefer the project's CURRENT directory (it may have moved since
      // the backup); fall back to the path recorded in the manifest.
      const live = fdb.getProject(proj.projectId);
      const projectDir = (live?.path ?? '').trim() || proj.path;
      if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
        result.skipped.push({
          projectId: proj.projectId,
          name: proj.name,
          reason: 'project-dir-missing',
        });
        continue;
      }
      const prefix = `projects/${safeProjectId(proj.projectId)}/`;
      const files: CollectedProjectFile[] = [];
      for (const f of manifest.files) {
        if (!f.name.startsWith(prefix)) continue;
        files.push({
          rel: f.name.slice(prefix.length),
          bytes: f.bytes,
          sha256: f.sha256,
        });
      }
      const { restored } = restoreProjectFiles(
        backupProjectsDir,
        proj.projectId,
        projectDir,
        files,
        preRestoreDir,
      );
      result.projects.push({
        projectId: proj.projectId,
        name: proj.name,
        path: projectDir,
        restored,
        bytes: files.reduce((a, f) => a + f.bytes, 0),
      });
    }
  } catch (e) {
    throw new ProjectFilesRestoreError(
      500,
      `project-files restore failed: ${(e as Error).message}`,
    );
  }
  fs.writeFileSync(
    path.join(preRestoreDir, 'pre-restore.json'),
    JSON.stringify(
      {
        backupId,
        createdAt: new Date().toISOString(),
        projects: result.projects,
        skipped: result.skipped,
      },
      null,
      2,
    ),
  );
  return result;
}

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
      const pf = manifest.projectFiles;
      audit.record('human', 'BACKUP_CREATED', 'backup', backupId, {
        dir,
        tables: manifest.tables,
        bytes: manifest.files[0]?.bytes ?? 0,
        scope: manifest.scope,
        ...(pf
          ? {
              projectFiles: {
                projects: pf.projects.map((pr) => ({
                  projectId: pr.projectId,
                  fileCount: pr.fileCount,
                  bytes: pr.bytes,
                  skipped: pr.skipped.length,
                })),
                fileCount: pf.projects.reduce((a, pr) => a + pr.fileCount, 0),
              },
            }
          : {}),
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
      scope: m.scope,
      tables: m.tables,
      totalRows: Object.values(m.tables).reduce((a, b) => a + b, 0),
      bytes: m.files.reduce((a, f) => a + f.bytes, 0),
      ...(m.projectFiles
        ? {
            projectFiles: {
              projects: m.projectFiles.projects.map((pr) => ({
                projectId: pr.projectId,
                name: pr.name,
                fileCount: pr.fileCount,
                bytes: pr.bytes,
                skipped: pr.skipped.length,
              })),
            },
          }
        : {}),
    }));
    const info = readPendingInfo(svc().dbPath);
    json(res, 200, {
      backups,
      pendingRestore: info ? { ...info, restartRequired: true } : null,
    });
    return true;
  }

  if (p === '/api/restore/project-files' && method === 'POST') {
    const b = await readBody(req);
    const backupId = b['backupId'];
    if (!isValidBackupId(backupId)) {
      json(res, 400, { error: 'backupId (a backup directory name) is required' });
      return true;
    }
    try {
      const result = restoreProjectFilesFromBackup(fdb, backupId);
      audit.record('human', 'PROJECT_FILES_RESTORED', 'backup', backupId, {
        projects: result.projects.map((pr) => ({
          projectId: pr.projectId,
          restored: pr.restored,
          bytes: pr.bytes,
        })),
        skipped: result.skipped,
        preRestoreDir: result.preRestoreDir,
        note: 'project files restore immediately; the database restore (if any) stays staged for reboot',
      });
      json(res, 200, { ok: true, ...result });
      return true;
    } catch (e) {
      if (e instanceof ProjectFilesRestoreError) {
        if (e.status === 422 && e.problems) {
          audit.record('human', 'RESTORE_REJECTED', 'backup', backupId, {
            problems: e.problems,
            scope: 'project-files',
          });
        }
        json(
          res,
          e.status,
          e.problems
            ? { error: e.message, problems: e.problems }
            : { error: e.message },
        );
        return true;
      }
      json(res, 500, { error: `project-files restore failed: ${(e as Error).message}` });
      return true;
    }
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
    // (Batch 45-4: project-file entries validate the same way as the DB)
    const problems = validateBackupFiles(dir, manifest);
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

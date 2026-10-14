/**
 * Project working-files backup — Batch 45-4 (routes/backup.ts).
 *
 * Pins: the collector's include/skip rules (excluded dirs, suffixes,
 * symlinks never followed, size caps, skipped files RECORDED not
 * dropped); createBackup carrying project trees + .ai/ with per-file
 * sha256 in the manifest; validateBackupFiles refusing a tampered
 * project file; restoreProjectFilesFromBackup restoring with a
 * pre-restore copy; archived projects skipped; env config overrides.
 *
 * The route module is imported from src (like retention.test.ts): its
 * value imports are node builtins only, so node type-stripping works.
 * FactoryDatabase is the real compiled package against a temp file.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactoryDatabase } from '@ai-factory/db';
import {
  collectProjectFiles,
  createBackup,
  initBackupService,
  isProjectFileEntry,
  restoreProjectFilesFromBackup,
  resolveProjectFilesConfig,
  safeProjectId,
  validateBackupFiles,
  type BackupManifest,
} from '../src/routes/backup.ts';

const sha256 = (s: string | Buffer): string =>
  createHash('sha256').update(s).digest('hex');

function makeProjectTree(root: string): void {
  const w = (rel: string, content: string): void => {
    const full = join(root, ...rel.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  };
  w('.ai/config.yaml', 'name: demo\n');
  w('.ai/skills/skill.md', '# skill\n');
  w('src/index.ts', 'export const x = 1;\n');
  w('node_modules/dep/index.js', 'module.exports = {};\n');
  w('dist/out.js', 'console.log(1);\n');
  w('.git/HEAD', 'ref: refs/heads/main\n');
  w('debug.log', 'noise\n');
  // symlink: must be recorded as skipped, never followed
  try {
    symlinkSync(join(root, 'src', 'index.ts'), join(root, 'link.ts'));
  } catch {
    // Windows CI without developer mode — the skip assertion below is
    // then vacuous; the symlink test degrades gracefully.
  }
}

function smallCaps() {
  return {
    ...resolveProjectFilesConfig({} as NodeJS.ProcessEnv),
    maxFileBytes: 100,
    maxTotalBytes: 10 * 1024 * 1024,
  };
}

describe('collectProjectFiles', () => {
  let dir = '';
  beforeEach(() => {
    dir = join(tmpdir(), `pfb-collect-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(dir, { recursive: true });
    makeProjectTree(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('includes working files and .ai/, skips excluded/symlink/over-cap with reasons', () => {
    const cfg = smallCaps();
    // big.bin (200 bytes) exceeds the 100-byte test cap
    writeFileSync(join(dir, 'big.bin'), 'x'.repeat(200));
    const { files, skipped } = collectProjectFiles(dir, cfg);
    const rels = files.map((f) => f.rel);
    assert.deepEqual(rels, [
      '.ai/config.yaml',
      '.ai/skills/skill.md',
      'src/index.ts',
    ]);
    const f = files.find((x) => x.rel === 'src/index.ts');
    assert.equal(f?.sha256, sha256('export const x = 1;\n'));
    const skipMap = new Map(skipped.map((s) => [s.rel, s.reason]));
    assert.equal(skipMap.get('node_modules'), 'excluded-dir');
    assert.equal(skipMap.get('dist'), 'excluded-dir');
    assert.equal(skipMap.get('.git'), 'excluded-dir');
    assert.equal(skipMap.get('debug.log'), 'excluded-suffix');
    assert.equal(skipMap.get('big.bin'), 'over-file-limit');
    if (existsSync(join(dir, 'link.ts'))) {
      assert.equal(skipMap.get('link.ts'), 'symlink');
    }
  });

  it('records over-total-limit for the tail once the budget is spent', () => {
    const cfg = { ...smallCaps(), maxTotalBytes: 10 };
    const { files, skipped } = collectProjectFiles(dir, cfg);
    // '.ai/config.yaml' is 11 bytes > 10 total: everything lands skipped
    assert.equal(files.length, 0);
    assert.ok(
      skipped.some((s) => s.reason === 'over-total-limit'),
      JSON.stringify(skipped),
    );
  });

  it('never descends into excluded backup paths', () => {
    const cfg = smallCaps();
    const inner = join(dir, 'backups');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'should-not-appear.txt'), 'x');
    const { files } = collectProjectFiles(dir, cfg, [inner]);
    assert.ok(!files.some((f) => f.rel.includes('should-not-appear')));
  });

  it('isProjectFileEntry accepts only safe projects/ paths', () => {
    assert.ok(isProjectFileEntry('projects/p1/.ai/config.yaml'));
    assert.ok(!isProjectFileEntry('factory.db'));
    assert.ok(!isProjectFileEntry('projects/../evil'));
    assert.ok(!isProjectFileEntry('projects/p1'));
    assert.ok(!isProjectFileEntry('projects//x'));
  });

  it('safeProjectId sanitizes hostile ids', () => {
    assert.equal(safeProjectId('abc-123'), 'abc-123');
    assert.equal(safeProjectId('../../etc'), '.._.._etc');
    assert.ok(!safeProjectId('../x').includes('/'));
    assert.equal(safeProjectId(''), '_');
  });
});

describe('resolveProjectFilesConfig', () => {
  it('honors env overrides', () => {
    const cfg = resolveProjectFilesConfig({
      FACTORY_BACKUP_PROJECT_FILES: '0',
      FACTORY_BACKUP_MAX_FILE_BYTES: '1024',
      FACTORY_BACKUP_EXCLUDE_DIRS: 'vendor,tmp',
    } as NodeJS.ProcessEnv);
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.maxFileBytes, 1024);
    assert.ok(cfg.excludeDirs.includes('vendor'));
    assert.ok(cfg.excludeDirs.includes('node_modules'));
  });

  it('defaults to enabled with sane caps', () => {
    const cfg = resolveProjectFilesConfig({} as NodeJS.ProcessEnv);
    assert.equal(cfg.enabled, true);
    assert.ok(cfg.maxFileBytes > 0 && cfg.maxTotalBytes > cfg.maxFileBytes);
  });
});

describe('createBackup with project files', () => {
  let dir = '';
  let fdb: FactoryDatabase;
  let backupDir = '';
  let projDir = '';
  beforeEach(() => {
    dir = join(tmpdir(), `pfb-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(dir, { recursive: true });
    fdb = new FactoryDatabase(join(dir, 'factory.db'));
    backupDir = join(dir, 'backups');
    projDir = join(dir, 'proj');
    mkdirSync(projDir, { recursive: true });
    makeProjectTree(projDir);
    fdb.createProject({ id: 'p1', name: 'P1', description: '', path: projDir });
    fdb.createProject({ id: 'p2', name: 'P2-archived', description: '', path: projDir });
    fdb.setProjectStatus('p2', 'archived');
    fdb.createProject({ id: 'p3', name: 'P3-nodir', description: '', path: join(dir, 'nope') });
    initBackupService({ dbPath: join(dir, 'factory.db'), backupDir, appVersion: 'test', projectFiles: smallCaps(), projectsRoot: dir });
  });
  afterEach(() => {
    fdb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries project trees with hashes; archived/missing projects skipped', () => {
    const { backupId, dir: bdir, manifest } = createBackup(fdb, 'manual');
    assert.equal(manifest.scope, 'factory-database+project-files');
    const names = manifest.files.map((f) => f.name);
    assert.ok(names.includes('factory.db'));
    assert.ok(names.includes('projects/p1/.ai/config.yaml'));
    assert.ok(names.includes('projects/p1/.ai/skills/skill.md'));
    assert.ok(names.includes('projects/p1/src/index.ts'));
    assert.ok(!names.some((n) => n.includes('node_modules')));
    assert.ok(!names.some((n) => n.startsWith('projects/p2/')), 'archived project skipped');
    assert.ok(!names.some((n) => n.startsWith('projects/p3/')), 'missing dir skipped');
    const entry = manifest.files.find((f) => f.name === 'projects/p1/src/index.ts');
    assert.equal(entry?.sha256, sha256('export const x = 1;\n'));
    // on-disk copy matches the manifest hash
    const onDisk = readFileSync(join(bdir, 'projects', 'p1', 'src', 'index.ts'), 'utf8');
    assert.equal(sha256(onDisk), entry?.sha256);
    // skipped files are RECORDED with reasons, not silently dropped
    const pf = manifest.projectFiles?.projects.find((p) => p.projectId === 'p1');
    assert.ok(pf);
    const reasons = new Map(pf.skipped.map((s) => [s.rel, s.reason]));
    assert.equal(reasons.get('node_modules'), 'excluded-dir');
    assert.equal(manifest.projectFiles?.projects.length, 1);
    assert.equal(validateBackupFiles(bdir, manifest).length, 0);
    void backupId;
  });

  it('refuses a backup whose project file was tampered with', () => {
    const { dir: bdir, manifest } = createBackup(fdb, 'manual');
    // same byte length (20) as the original: trips the sha256 check, not size
    writeFileSync(join(bdir, 'projects', 'p1', 'src', 'index.ts'), 'export const x = 2;\n');
    const problems = validateBackupFiles(bdir, manifest);
    assert.ok(problems.some((p) => p.includes('sha256 mismatch')), JSON.stringify(problems));
  });

  it('restores project files with a pre-restore copy of the current state', () => {
    const { backupId, manifest } = createBackup(fdb, 'manual');
    // mutate after backup
    writeFileSync(join(projDir, 'src', 'index.ts'), 'MUTATED\n');
    writeFileSync(join(projDir, '.ai', 'config.yaml'), 'name: mutated\n');
    const result = restoreProjectFilesFromBackup(fdb, backupId);
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0]?.restored, 3);
    assert.equal(readFileSync(join(projDir, 'src', 'index.ts'), 'utf8'), 'export const x = 1;\n');
    assert.equal(readFileSync(join(projDir, '.ai', 'config.yaml'), 'utf8'), 'name: demo\n');
    // pre-restore copy holds the MUTATED content — the way back exists
    const pre = readFileSync(join(result.preRestoreDir, 'p1', 'src', 'index.ts'), 'utf8');
    assert.equal(pre, 'MUTATED\n');
    assert.ok(existsSync(join(result.preRestoreDir, 'pre-restore.json')));
    void manifest;
  });

  it('refuses project-files restore when the backup was tampered with (422)', () => {
    const { backupId } = createBackup(fdb, 'manual');
    writeFileSync(join(backupDir, backupId, 'projects', 'p1', '.ai', 'config.yaml'), 'TAMPERED\n');
    assert.throws(
      () => restoreProjectFilesFromBackup(fdb, backupId),
      (e: unknown) =>
        (e as { status?: number }).status === 422 &&
        /failed validation/.test((e as Error).message),
    );
    // live tree untouched
    assert.equal(readFileSync(join(projDir, '.ai', 'config.yaml'), 'utf8'), 'name: demo\n');
  });

  it('resolves manifest scope for pre-Batch-45 database-only backups', () => {
    initBackupService({
      dbPath: join(dir, 'factory.db'),
      backupDir,
      appVersion: 'test',
      projectFiles: { ...smallCaps(), enabled: false },
    });
    const { manifest } = createBackup(fdb, 'manual');
    assert.equal(manifest.scope, 'factory-database');
    assert.equal(manifest.projectFiles, undefined);
    assert.throws(
      () => restoreProjectFilesFromBackup(fdb, manifest.backupId),
      (e: unknown) => (e as { status?: number }).status === 422,
    );
  });
});

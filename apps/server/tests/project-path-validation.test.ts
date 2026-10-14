/**
 * Project working-directory path policy — Batch 47-2 (finding F22).
 *
 * Pins three layers over pure HTTP against the real built server plus
 * direct module tests:
 *
 *  1. Record-creation gate: POST /api/projects refuses a non-empty
 *     `path` that is relative (PROJECT_PATH_NOT_ABSOLUTE), missing
 *     (PROJECT_PATH_NOT_FOUND), not a directory
 *     (PROJECT_PATH_NOT_DIRECTORY), or outside the operator-configured
 *     root (PROJECT_PATH_OUTSIDE_ROOT — including `..` escapes).
 *     Empty path stays legal (no local working directory).
 *  2. Collector defense in depth: a row planted straight into the DB
 *     (bypassing HTTP validation) pointing at /etc is NOT walked —
 *     createBackup records it in manifest.skippedProjects with reason
 *     'path-outside-root', never silently.
 *  3. Restore defense in depth: restoreProjectFilesFromBackup refuses
 *     to write into a live directory outside the root (same reason).
 *
 * Requires the workspace build (root `npm run build`). Hermetic: temp
 * DB + temp FACTORY_SECRETS_DIR + temp FACTORY_PROJECTS_ROOT, so the
 * developer's local vault and project tree are never touched. The
 * backup route module is imported from src (like
 * backup-project-files.test.ts): its value imports are node builtins
 * only, so node type-stripping works.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { FactoryDatabase } from '@ai-factory/db';
import {
  createBackup,
  initBackupService,
  isPathInsideProjectsRoot,
  resolveProjectsRoot,
  resolveProjectFilesConfig,
  restoreProjectFilesFromBackup,
  validateProjectPath,
} from '../src/routes/backup.ts';

// ---------------------------------------------------------------- helpers --

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

const children: ChildProcess[] = [];
after(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      // already dead
    }
  }
});

async function bootServer(
  dbFile: string,
  projectsRoot: string,
): Promise<number> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_PROJECTS_ROOT: projectsRoot,
    // Hermetic secrets vault (fail-closed without it on stale local data).
    FACTORY_SECRETS_DIR: join(tmpdir(), `factory-pathpol-secrets-${port}`),
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  children.push(child);
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return port;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function postProject(
  port: number,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ------------------------------------------------- unit: the validators --

describe('validateProjectPath / resolveProjectsRoot / isPathInsideProjectsRoot', () => {
  it('resolves the root from env, defaulting to <db dir>/projects', () => {
    assert.equal(
      resolveProjectsRoot({ FACTORY_PROJECTS_ROOT: '/srv/projects' } as NodeJS.ProcessEnv, '/x/factory.db'),
      resolve('/srv/projects'),
    );
    assert.equal(
      resolveProjectsRoot({} as NodeJS.ProcessEnv, '/x/data/factory.db'),
      join(resolve('/x/data'), 'projects'),
    );
    // blank env falls back to the default
    assert.equal(
      resolveProjectsRoot({ FACTORY_PROJECTS_ROOT: '   ' } as NodeJS.ProcessEnv, '/x/data/factory.db'),
      join(resolve('/x/data'), 'projects'),
    );
  });

  it('rejects relative, missing, non-dir and escaping paths with distinct codes', () => {
    const base = mkdtempSync(join(tmpdir(), 'factory-pathpol-unit-'));
    try {
      const root = join(base, 'root');
      const good = join(root, 'proj');
      mkdirSync(good, { recursive: true });
      const aFile = join(root, 'f.txt');
      writeFileSync(aFile, 'x');

      assert.equal(validateProjectPath('rel/path', root).ok, false);
      const rel = validateProjectPath('rel/path', root);
      assert.equal(!rel.ok && rel.problem.code, 'PROJECT_PATH_NOT_ABSOLUTE');

      const missing = validateProjectPath(join(root, 'nope'), root);
      assert.equal(!missing.ok && missing.problem.code, 'PROJECT_PATH_NOT_FOUND');

      const notDir = validateProjectPath(aFile, root);
      assert.equal(!notDir.ok && notDir.problem.code, 'PROJECT_PATH_NOT_DIRECTORY');

      const etc = validateProjectPath('/etc', root);
      assert.equal(!etc.ok && etc.problem.code, 'PROJECT_PATH_OUTSIDE_ROOT');

      const dotdot = validateProjectPath(join(root, '..', 'evil'), root);
      assert.equal(!dotdot.ok && dotdot.problem.code, 'PROJECT_PATH_OUTSIDE_ROOT');

      const okRoot = validateProjectPath(root, root);
      assert.equal(okRoot.ok, true);

      const okSub = validateProjectPath(join(root, 'proj', '..', 'proj'), root);
      assert.equal(okSub.ok, true, '.. that stays inside normalizes fine');

      assert.equal(isPathInsideProjectsRoot(good, root), true);
      assert.equal(isPathInsideProjectsRoot('/etc', root), false);
      assert.equal(isPathInsideProjectsRoot(join(root, '..', 'evil'), root), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('catches a symlink inside the root pointing elsewhere', () => {
    const base = mkdtempSync(join(tmpdir(), 'factory-pathpol-link-'));
    try {
      const root = join(base, 'root');
      const outside = join(base, 'outside');
      mkdirSync(root, { recursive: true });
      mkdirSync(outside, { recursive: true });
      const link = join(root, 'linkdir');
      try {
        symlinkSync(outside, link);
      } catch {
        return; // Windows CI without developer mode — symlink untestable
      }
      assert.ok(existsSync(link), 'link created');
      const v = validateProjectPath(link, root);
      assert.equal(!v.ok && v.problem.code, 'PROJECT_PATH_OUTSIDE_ROOT');
      assert.equal(isPathInsideProjectsRoot(link, root), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------- HTTP: record-creation gate --

describe('POST /api/projects working-dir path gate (F22)', () => {
  it('refuses planted /etc, relative, missing, non-dir and ..-escape paths; accepts in-root and empty', { timeout: 90_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-pathpol-http-'));
    try {
      const root = join(dir, 'projects-root');
      const good = join(root, 'good');
      mkdirSync(good, { recursive: true });
      const aFile = join(root, 'f.txt');
      writeFileSync(aFile, 'x');
      const port = await bootServer(join(dir, 'factory.db'), root);

      // 1. the F22 attack: plant a record pointing at /etc
      const planted = await postProject(port, { name: 'planted', path: '/etc' });
      assert.equal(planted.status, 400);
      assert.equal(planted.json['code'], 'PROJECT_PATH_OUTSIDE_ROOT');

      // 2. .. escape out of the root
      const escaped = await postProject(port, {
        name: 'escaped',
        path: join(root, '..', 'evil'),
      });
      assert.equal(escaped.status, 400);
      assert.equal(escaped.json['code'], 'PROJECT_PATH_OUTSIDE_ROOT');

      // 3. relative path
      const rel = await postProject(port, { name: 'rel', path: 'some/rel' });
      assert.equal(rel.status, 400);
      assert.equal(rel.json['code'], 'PROJECT_PATH_NOT_ABSOLUTE');

      // 4. nonexistent directory
      const missing = await postProject(port, {
        name: 'missing',
        path: join(root, 'nope'),
      });
      assert.equal(missing.status, 400);
      assert.equal(missing.json['code'], 'PROJECT_PATH_NOT_FOUND');

      // 5. not a directory
      const notDir = await postProject(port, { name: 'notdir', path: aFile });
      assert.equal(notDir.status, 400);
      assert.equal(notDir.json['code'], 'PROJECT_PATH_NOT_DIRECTORY');

      // 6. a real project dir under the root passes
      const ok = await postProject(port, { name: 'good', path: good });
      assert.equal(ok.status, 201);

      // 7. no path at all stays legal (no local working directory)
      const bare = await postProject(port, { name: 'bare' });
      assert.equal(bare.status, 201);

      // 8. refused records were never written: only good+bare (plus the
      // seeded demo project) exist; none of the refused names do
      const list = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json() as Array<{ name: string }>;
      const names = list.map((p) => p.name);
      assert.ok(names.includes('good'), 'good recorded');
      assert.ok(names.includes('bare'), 'bare recorded');
      for (const refused of ['planted', 'escaped', 'rel', 'missing', 'notdir']) {
        assert.ok(!names.includes(refused), `${refused} must not be recorded`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------- collector + restore guards --

describe('backup collector / restore refuse out-of-root project dirs (F22 defense in depth)', () => {
  it('skips a DB-planted /etc row in createBackup and records the skip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-pathpol-collect-'));
    let fdb: FactoryDatabase | undefined;
    try {
      const dbFile = join(dir, 'factory.db');
      fdb = new FactoryDatabase(dbFile);
      const root = join(dir, 'root');
      const goodDir = join(root, 'good');
      mkdirSync(goodDir, { recursive: true });
      writeFileSync(join(goodDir, 'a.txt'), 'hello\n');
      // planted straight into the DB, bypassing the HTTP gate
      fdb.createProject({ id: 'evil', name: 'Evil', description: '', path: '/etc' });
      fdb.createProject({ id: 'good', name: 'Good', description: '', path: goodDir });
      initBackupService({
        dbPath: dbFile,
        backupDir: join(dir, 'backups'),
        appVersion: 'test',
        projectFiles: resolveProjectFilesConfig({} as NodeJS.ProcessEnv),
        projectsRoot: root,
      });
      const { manifest } = createBackup(fdb, 'manual');
      // /etc was never walked: no entries, honest scope, recorded skip
      assert.ok(
        !manifest.files.some((f) => f.name.startsWith('projects/evil/')),
        'no /etc content in the backup',
      );
      assert.ok(
        manifest.files.some((f) => f.name === 'projects/good/a.txt'),
        'in-root project still collected',
      );
      assert.equal(manifest.scope, 'factory-database+project-files');
      const skipped = manifest.skippedProjects ?? [];
      assert.equal(skipped.length, 1);
      assert.equal(skipped[0]?.projectId, 'evil');
      assert.equal(skipped[0]?.reason, 'path-outside-root');
    } finally {
      fdb?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to restore into a live directory outside the root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-pathpol-restore-'));
    let fdb: FactoryDatabase | undefined;
    try {
      const dbFile = join(dir, 'factory.db');
      fdb = new FactoryDatabase(dbFile);
      const root = join(dir, 'root');
      const goodDir = join(root, 'good');
      mkdirSync(goodDir, { recursive: true });
      writeFileSync(join(goodDir, 'a.txt'), 'hello\n');
      fdb.createProject({ id: 'good', name: 'Good', description: '', path: goodDir });
      initBackupService({
        dbPath: dbFile,
        backupDir: join(dir, 'backups'),
        appVersion: 'test',
        projectFiles: resolveProjectFilesConfig({} as NodeJS.ProcessEnv),
        projectsRoot: root,
      });
      const { backupId } = createBackup(fdb, 'manual');
      // simulate a row planted AFTER the backup: live path now points at /etc
      const raw = new DatabaseSync(dbFile);
      try {
        raw.exec(`UPDATE projects SET path = '/etc' WHERE id = 'good'`);
      } finally {
        raw.close();
      }
      const result = restoreProjectFilesFromBackup(fdb, backupId);
      assert.equal(result.projects.length, 0, 'nothing written outside the root');
      const skip = result.skipped.find((s) => s.projectId === 'good');
      assert.ok(skip, 'skip recorded');
      assert.equal(skip?.reason, 'path-outside-root');
    } finally {
      fdb?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

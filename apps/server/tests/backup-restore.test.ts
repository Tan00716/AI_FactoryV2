/**
 * Backup / restore end-to-end — Batch 13-3 (routes/backup.ts).
 *
 * Pins the whole contract over real HTTP against the compiled server,
 * two boots over ONE temp DB file, with FACTORY_API_TOKEN set:
 *
 *   Boot A — 401 without the token (both endpoints ride the standard
 *   gate); create project P1 + a task; POST /api/backup; the manifest
 *   on disk hashes to the snapshot beside it and its table counts match
 *   the snapshot's own counts. Mutate: create P2. Tamper: a second
 *   backup with ONE byte flipped in its snapshot is refused by
 *   POST /api/restore (422) and the live DB still serves P2. Then the
 *   good backup is staged: 200 + restartRequired, a pre-restore backup
 *   exists, a staging file sits next to the DB — and the RUNNING server
 *   still serves P2 (no fake hot swap).
 *   Boot B — the staged restore is applied at startup: P1 present, P2
 *   gone; project/task counts equal the manifest's table counts;
 *   RESTORE_APPLIED is in the audit trail; the outgoing database was
 *   kept as a .superseded file (with its WAL sidecars); the
 *   pre-restore backup's manifest shows the pre-restore state (P2's
 *   project counted), so the way back exists.
 *
 * Requires the workspace build (root `npm run build`): the server
 * under test is dist/index.js — same precondition as
 * first-run-walkthrough.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'backup-test-token-0123456789';

// ---------------------------------------------------------------- helpers --

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  token: string | null = TOKEN,
): Promise<{ status: number; body: Record<string, never> }> {
  const headers: Record<string, string> = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, never> = {};
  try {
    parsed = JSON.parse(text) as Record<string, never>;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: parsed };
}

interface BootedServer {
  child: ChildProcess;
  port: number;
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(dbFile: string, backupDir: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKEN: TOKEN,
    FACTORY_BACKUP_DIR: backupDir,
  };
  delete env['FACTORY_RUNTIME_TOOLS'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function stopServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((r) => s.child.once('exit', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    s.child.kill('SIGKILL');
    await new Promise((r) => s.child.once('exit', r));
  }
}

interface Manifest {
  format: string;
  backupId: string;
  kind: string;
  appVersion: string;
  scope: string;
  files: { name: string; bytes: number; sha256: string }[];
  tables: Record<string, number>;
}

// ------------------------------------------------------------------- test --

describe('backup / restore (Batch 13-3)', () => {
  it('backup → mutate → tampered restore refused → staged restore → restart applies it', { timeout: 90_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-backup-'));
    const dbFile = join(dir, 'factory.db');
    const backupDir = join(dir, 'backups');
    let server: BootedServer | undefined;
    try {
      // ---------------------------------------------------------- boot A --
      server = await bootServer(dbFile, backupDir);

      // Auth: both endpoints are behind the standard token gate.
      const noAuthBackup = await api(server.port, 'POST', '/api/backup', undefined, null);
      assert.equal(noAuthBackup.status, 401);
      const noAuthRestore = await api(
        server.port, 'POST', '/api/restore', { backupId: 'whatever' }, null,
      );
      assert.equal(noAuthRestore.status, 401);

      // Seed state worth backing up: project + task.
      const p1 = await api(server.port, 'POST', '/api/projects', { name: 'BackupP1' });
      assert.equal(p1.status, 201);
      const p1Id = (p1.body as { id: string }).id;
      const t1 = await api(server.port, 'POST', '/api/tasks', {
        projectId: p1Id,
        title: 'task at backup time',
      });
      assert.equal(t1.status, 201);

      // Backup.
      const bk = await api(server.port, 'POST', '/api/backup');
      assert.equal(bk.status, 201);
      const backupId = (bk.body as { backupId: string }).backupId;
      assert.ok(backupId.startsWith('backup-'));
      const manifest = JSON.parse(
        readFileSync(join(backupDir, backupId, 'manifest.json'), 'utf8'),
      ) as Manifest;
      assert.equal(manifest.format, 'ai-factory-backup/1');
      assert.equal(manifest.kind, 'manual');
      assert.equal(manifest.scope, 'factory-database');
      assert.equal(manifest.appVersion, '0.1.0');
      // Manifest integrity: hash + size describe the snapshot beside it.
      const snapshotBytes = readFileSync(join(backupDir, backupId, 'factory.db'));
      assert.equal(manifest.files[0].bytes, snapshotBytes.length);
      assert.equal(
        manifest.files[0].sha256,
        createHash('sha256').update(snapshotBytes).digest('hex'),
      );
      // Manifest counts describe the backup point: P1 exists, P2 not yet.
      assert.equal(manifest.tables['projects'], 2); // seed project + BackupP1
      assert.ok((manifest.tables['tasks'] ?? 0) >= 1);

      // Listing sees it; nothing pending.
      const list1 = await api(server.port, 'GET', '/api/backups');
      assert.equal(list1.status, 200);
      const listed = (list1.body as { backups: { backupId: string }[] }).backups;
      assert.ok(listed.some((b) => b.backupId === backupId));
      assert.equal((list1.body as { pendingRestore: unknown }).pendingRestore, null);

      // Mutate AFTER the backup: P2 must vanish on restore.
      const p2 = await api(server.port, 'POST', '/api/projects', { name: 'BackupP2' });
      assert.equal(p2.status, 201);

      // Tampered backup → restore refused, live DB untouched.
      const bk2 = await api(server.port, 'POST', '/api/backup');
      assert.equal(bk2.status, 201);
      const tamperedId = (bk2.body as { backupId: string }).backupId;
      const tamperedFile = join(backupDir, tamperedId, 'factory.db');
      const bytes = readFileSync(tamperedFile);
      // Flip a byte in the middle AND append nothing: size stays equal,
      // so the refusal must come from the sha256 check itself.
      bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      writeFileSync(tamperedFile, bytes);
      const refused = await api(server.port, 'POST', '/api/restore', { backupId: tamperedId });
      assert.equal(refused.status, 422);
      assert.match(String((refused.body as { error: string }).error), /validation/);
      assert.equal(existsSync(dbFile + '.restore-pending'), false);
      const afterRefusal = await api(server.port, 'GET', '/api/projects');
      const namesAfterRefusal = (afterRefusal.body as unknown as { name: string }[]).map((p) => p.name);
      assert.ok(namesAfterRefusal.includes('BackupP2'), 'live DB untouched by refused restore');

      // Unknown backup → 404; garbage id → 400.
      const unknown = await api(server.port, 'POST', '/api/restore', { backupId: 'backup-nope' });
      assert.equal(unknown.status, 404);
      const garbage = await api(server.port, 'POST', '/api/restore', { backupId: '../etc' });
      assert.equal(garbage.status, 400);

      // Stage the good restore.
      const staged = await api(server.port, 'POST', '/api/restore', { backupId });
      assert.equal(staged.status, 200);
      assert.equal((staged.body as { restartRequired: boolean }).restartRequired, true);
      const preRestoreId = (staged.body as { preRestoreBackupId: string }).preRestoreBackupId;
      assert.ok(preRestoreId.startsWith('pre-restore-'));
      assert.equal(existsSync(dbFile + '.restore-pending'), true);
      assert.equal(existsSync(join(backupDir, preRestoreId, 'manifest.json')), true);
      // The pre-restore backup captured the CURRENT (post-P2) state.
      const preManifest = JSON.parse(
        readFileSync(join(backupDir, preRestoreId, 'manifest.json'), 'utf8'),
      ) as Manifest;
      assert.equal(preManifest.kind, 'pre-restore');
      assert.equal(preManifest.tables['projects'], 3); // seed + P1 + P2

      // Honest staging: the RUNNING server still serves the old data.
      const stillOld = await api(server.port, 'GET', '/api/projects');
      const namesStillOld = (stillOld.body as unknown as { name: string }[]).map((p) => p.name);
      assert.ok(namesStillOld.includes('BackupP2'), 'no hot swap: P2 still served before restart');

      // A second staging while one is pending → 409.
      const again = await api(server.port, 'POST', '/api/restore', { backupId });
      assert.equal(again.status, 409);

      await stopServer(server);
      server = undefined;

      // ---------------------------------------------------------- boot B --
      server = await bootServer(dbFile, backupDir);
      const projects = await api(server.port, 'GET', '/api/projects');
      const names = (projects.body as unknown as { name: string }[]).map((p) => p.name);
      assert.ok(names.includes('BackupP1'));
      assert.ok(!names.includes('BackupP2'), 'restore rolled the DB back to the backup point');
      // Table-count reconciliation against the backup manifest.
      assert.equal(names.length, manifest.tables['projects']);
      const tasks = await api(server.port, 'GET', '/api/tasks');
      assert.equal((tasks.body as unknown as unknown[]).length, manifest.tables['tasks']);
      // The applied restore is on the audit record of the restored DB.
      const auditRes = await api(server.port, 'GET', '/api/audit?limit=300');
      const actions = (auditRes.body as unknown as { action: string }[]).map((r) => r.action);
      assert.ok(actions.includes('RESTORE_APPLIED'));
      // The outgoing database was kept, sidecars and all.
      const siblings = readdirSync(dir);
      assert.ok(
        siblings.some((f) => f.startsWith('factory.db.superseded-')),
        'superseded database file kept next to the DB',
      );
      assert.equal(existsSync(dbFile + '.restore-pending'), false);
      // No restore pending anymore.
      const list2 = await api(server.port, 'GET', '/api/backups');
      assert.equal((list2.body as { pendingRestore: unknown }).pendingRestore, null);

      await stopServer(server);
      server = undefined;
    } finally {
      if (server) await stopServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

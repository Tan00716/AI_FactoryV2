/**
 * First-run walkthrough, eighth edition — B47 chains (Batch 48-2).
 *
 * Walks the Batch 47 links against the real compiled server over fresh
 * temp SQLite files, pure HTTP, zero mocks. Two boots:
 *
 *   Server A (FACTORY_MERGE_DRAIN=0, FACTORY_PROJECTS_ROOT set):
 *     P1 — project path policy (Batch 47, finding F22), three legs:
 *        (a) record-creation gate: planting '/etc' → 400 +
 *            PROJECT_PATH_OUTSIDE_ROOT; '..' escape → same code;
 *            relative path → PROJECT_PATH_NOT_ABSOLUTE; in-root but
 *            missing path → PROJECT_PATH_NOT_FOUND; none of them writes
 *            a record. (b) a real in-root tree → 201. (c) defense in
 *            depth: live-plant an out-of-root path on a second project
 *            row (direct DB write while the server runs — the threat
 *            model is a row that predates the gate or was written
 *            straight to the DB, bypassing HTTP validation) →
 *            POST /api/backup → 201: the planted row is NOT walked
 *            (no manifest entry under `projects/<planted>/`), it is
 *            recorded in manifest.skippedProjects with
 *            reason 'path-outside-root', and the good project's files
 *            are still collected (scope stays
 *            'factory-database+project-files').
 *     M1-on — merge-queue single-writer switch (Batch 47):
 *            POST /api/git/merge-queue → 202 + drainPending: true,
 *            entry stays QUEUED (drain never ran), and a
 *            MERGE_QUEUE_ENQUEUED audit record carries the deferral.
 *   Server B (default env, no FACTORY_MERGE_DRAIN):
 *     M1-off — same git setup → 201, no drainPending field, entry
 *            MERGED (the old synchronous behavior is untouched).
 *
 * Findings are pinned in docs/FIRST_RUN_WALKTHROUGH.md (Batch 48 section,
 * F24+). v4 remains the authority for the B31–B36 governance chains, v5
 * for the B37–B40 chains, v6 for the B41–B42 §81 chains, v7 for the
 * B43–B45 chains; v8 covers B47 only.
 *
 * Requires the workspace build (root `npm run build`); run with
 * `npm run demo:e2e-v8`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------- helpers --

type Json = Record<string, unknown>;

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: parsed };
}

interface BootedServer {
  child: ChildProcess;
  port: number;
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(
  dbFile: string,
  extraEnv: Record<string, string> = {},
): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    PORT: String(port),
    DB_PATH: dbFile,
    // Hermetic secrets: point the file vault at a temp dir so the walk
    // never inherits the developer's local (git-ignored) vault.
    FACTORY_SECRETS_DIR: join(tmpdir(), `factory-walk-b48-secrets-${port}`),
  };
  delete env['FACTORY_API_TOKEN'];
  if (!('FACTORY_RUNTIME_TOOLS' in env)) delete env['FACTORY_RUNTIME_TOOLS'];
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
    new Promise((r) => s.child.once('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    s.child.kill('SIGKILL');
    await new Promise((r) => s.child.once('exit', r));
  }
}

async function killServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGKILL');
  await new Promise((r) => s.child.once('exit', r));
}

async function listProjects(port: number): Promise<Array<Json>> {
  const r = await api(port, 'GET', '/api/projects');
  assert.equal(r.status, 200);
  const body = r.body;
  if (Array.isArray(body)) return body as Array<Json>;
  return ((body['projects'] ?? body['items'] ?? []) as Array<Json>);
}

/** A repo with one branch that merges cleanly onto main (drain path). */
function makeSimpleRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'walk-b48-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });
  execFileSync('git', ['checkout', '-qb', 'feat'], { cwd: dir });
  writeFileSync(join(dir, 'g.txt'), 'new\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'feat'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir });
  return dir;
}

async function makePr(port: number, repo: string): Promise<string> {
  const project = await api(port, 'POST', '/api/projects', {
    name: 'walk-b48-mq',
    description: 'batch 48',
  });
  assert.equal(project.status, 201);
  const task = await api(port, 'POST', '/api/tasks', {
    projectId: String(project.body['id']),
    title: 'm1 switch task',
    goal: 'walk the merge-queue switch',
  });
  assert.equal(task.status, 201);
  const pr = await api(port, 'POST', '/api/git/pr', {
    taskId: String(task.body['id']),
    sourceBranch: 'feat',
    targetBranch: 'main',
    title: 'walk-b48 pr',
    repo,
  });
  assert.equal(pr.status, 201);
  return String(pr.body['id']);
}

// ------------------------------------------------------------------ the run --

describe('first-run walkthrough, eighth edition — B47 chains (Batch 48-2)', () => {
  it('project path policy → merge-queue single-writer switch (on/off)', { timeout: 600_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-walk-b48-'));
    const projectsRoot = mkdtempSync(join(tmpdir(), 'factory-walk-b48-root-'));
    let repoOn = '';
    let repoOff = '';
    let serverA: BootedServer | undefined;
    let serverB: BootedServer | undefined;
    try {
      // ============================================ Server A: DRAIN=0 ====
      serverA = await bootServer(join(dir, 'a.db'), {
        FACTORY_MERGE_DRAIN: '0',
        FACTORY_PROJECTS_ROOT: projectsRoot,
      });
      const portA = serverA.port;

      // ------------------------------------------------------------ P1a --
      // Record-creation gate (Batch 47, F22 layer 1): each refusal
      // carries its own explicit code, and containment is checked
      // before existence so the code never serves as an oracle.
      const refused = async (path: string, code: string) => {
        const before = (await listProjects(portA)).length;
        const r = await api(portA, 'POST', '/api/projects', {
          name: 'walk-b48-evil',
          path,
        });
        assert.equal(r.status, 400, `planting ${path} → 400`);
        assert.equal(String(r.body['code']), code, `code for ${path}`);
        const after = (await listProjects(portA)).length;
        assert.equal(after, before, `refused record for ${path} is never written`);
      };
      await refused('/etc', 'PROJECT_PATH_OUTSIDE_ROOT');
      await refused(join(projectsRoot, '..', 'etc'), 'PROJECT_PATH_OUTSIDE_ROOT');
      await refused('relative/path', 'PROJECT_PATH_NOT_ABSOLUTE');
      await refused(join(projectsRoot, 'does-not-exist-b48'), 'PROJECT_PATH_NOT_FOUND');
      t.diagnostic('P1(a) gate: /etc, ..-escape, relative, missing-in-root all refused with own codes, nothing written');

      // ------------------------------------------------------------ P1b --
      // A real in-root tree is accepted: the gate is a policy, not a
      // blockade.
      const goodDir = mkdtempSync(join(projectsRoot, 'good-'));
      mkdirSync(join(goodDir, 'src'), { recursive: true });
      writeFileSync(join(goodDir, 'src', 'index.ts'), 'export const walk = 48;\n');
      writeFileSync(join(goodDir, '.ai-note.md'), 'operator notes\n');
      const good = await api(portA, 'POST', '/api/projects', {
        name: 'walk-b48-good',
        path: goodDir,
      });
      assert.equal(good.status, 201, 'in-root working dir → 201');
      const goodId = String(good.body['id']);

      // ------------------------------------------------------------ P1c --
      // Defense in depth (F22 layer 2): a row that predates the gate —
      // planted straight into the DB while the server runs, bypassing
      // HTTP validation — must not pull an unrelated tree into the
      // backup. The planted row is recorded in manifest.skippedProjects,
      // never silent.
      const planted = await api(portA, 'POST', '/api/projects', {
        name: 'walk-b48-planted',
        path: goodDir, // passes the gate; the plant comes next
      });
      assert.equal(planted.status, 201);
      const plantedId = String(planted.body['id']);
      const raw = new DatabaseSync(join(dir, 'a.db'));
      try {
        // The threat model, verbatim: a row written straight to the DB.
        // node:sqlite autocommit write; the live server holds no open
        // transaction between HTTP calls, so no lock contention.
        raw.exec(`UPDATE projects SET path = '/etc' WHERE id = '${plantedId}'`);
      } finally {
        raw.close();
      }
      const afterPlant = await api(portA, 'GET', '/api/projects');
      const plantedRow = listProjectsRows(afterPlant).find((p) => String(p['id']) === plantedId);
      assert.equal(String(plantedRow?.['path']), '/etc', 'the plant took effect');

      const bk = await api(portA, 'POST', '/api/backup');
      assert.equal(bk.status, 201, 'backup created');
      const manifest = bk.body['manifest'] as Json;
      assert.equal(
        manifest['scope'],
        'factory-database+project-files',
        'scope is honest: the good project was actually collected',
      );
      const files = (manifest['files'] ?? []) as Array<Json>;
      const names = files.map((f) => String(f['name']));
      assert.ok(
        names.includes(`projects/${goodId}/src/index.ts`),
        'the good project tree is collected',
      );
      assert.ok(
        !names.some((n) => n.startsWith(`projects/${plantedId}/`)),
        '/etc was never walked: no manifest entry under the planted project',
      );
      const skipped = (manifest['skippedProjects'] ?? []) as Array<Json>;
      const skipHit = skipped.find((s) => String(s['projectId']) === plantedId);
      assert.ok(skipHit, 'the planted row is recorded in manifest.skippedProjects');
      assert.equal(skipHit?.['reason'], 'path-outside-root');
      t.diagnostic(`P1(c) backup ${String(bk.body['backupId']).slice(0, 8)}…: /etc row skipped+recorded, good tree collected`);

      // ------------------------------------------------------------ M1 --
      // Switch ON (Batch 47): enqueue-only, 202 + drainPending, the
      // entry stays QUEUED — drain never ran on this instance.
      repoOn = makeSimpleRepo();
      const prOn = await makePr(portA, repoOn);
      const q = await api(portA, 'POST', '/api/git/merge-queue', { repo: repoOn, prId: prOn });
      assert.equal(q.status, 202, 'FACTORY_MERGE_DRAIN=0 → 202, not 201');
      assert.equal(q.body['drainPending'], true);
      const entryOn = q.body['entry'] as Json;
      assert.equal(entryOn['status'], 'QUEUED');
      assert.equal(String(entryOn['prId']), prOn);
      const got = await api(portA, 'GET', `/api/git/merge-queue/${String(entryOn['id'])}`);
      assert.equal(got.status, 200);
      assert.equal(got.body['status'], 'QUEUED', 'durable entry still QUEUED: drain never ran');
      const audit = await api(portA, 'GET', '/api/audit?limit=80');
      assert.equal(audit.status, 200);
      const rows = Array.isArray(audit.body) ? (audit.body as Array<Json>) : [];
      const hit = rows.find(
        (r) =>
          r['action'] === 'MERGE_QUEUE_ENQUEUED' &&
          String((r['details'] as Json)?.['entryId']) === String(entryOn['id']),
      );
      assert.ok(hit, 'MERGE_QUEUE_ENQUEUED audit record lands for the deferred drain');
      assert.equal((hit?.['details'] as Json)?.['drainPending'], true);
      assert.equal((hit?.['details'] as Json)?.['reason'], 'FACTORY_MERGE_DRAIN=0');
      t.diagnostic(`M1(on) enqueue-only: 202 + drainPending, entry ${String(entryOn['id']).slice(0, 8)}… QUEUED`);

      await stopServer(serverA);
      serverA = undefined;

      // ======================================== Server B: switch off =====
      serverB = await bootServer(join(dir, 'b.db'), {
        FACTORY_PROJECTS_ROOT: projectsRoot,
      });
      const portB = serverB.port;

      // Switch OFF (default): the old synchronous drain is untouched —
      // same setup drains inline and returns 201 with a MERGED entry,
      // and no drainPending field grows on the default path.
      repoOff = makeSimpleRepo();
      const prOff = await makePr(portB, repoOff);
      const q2 = await api(portB, 'POST', '/api/git/merge-queue', { repo: repoOff, prId: prOff });
      assert.equal(q2.status, 201, 'default → 201');
      assert.ok(!('drainPending' in q2.body), 'default path must not grow a drainPending field');
      const entryOff = q2.body['entry'] as Json;
      assert.equal(entryOff['status'], 'MERGED', 'default drains synchronously');
      t.diagnostic(`M1(off) default: 201, entry ${String(entryOff['id']).slice(0, 8)}… MERGED`);

      await stopServer(serverB);
      serverB = undefined;
    } finally {
      if (serverA) await killServer(serverA);
      if (serverB) await killServer(serverB);
      rmSync(dir, { recursive: true, force: true });
      rmSync(projectsRoot, { recursive: true, force: true });
      if (repoOn) rmSync(repoOn, { recursive: true, force: true });
      if (repoOff) rmSync(repoOff, { recursive: true, force: true });
    }
  });
});

function listProjectsRows(r: { status: number; body: Json }): Array<Json> {
  const body = r.body;
  if (Array.isArray(body)) return body as Array<Json>;
  return ((body['projects'] ?? body['items'] ?? []) as Array<Json>);
}

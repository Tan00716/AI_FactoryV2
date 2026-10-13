/**
 * Batch 31 — /api/builds read surface (§40).
 *
 * Closes the B30 walkthrough F9 read-surface gap: after a background
 * build lands, an HTTP-only consumer previously had no endpoint to
 * observe it (the walkthrough read the DB file directly). These tests
 * pin the read-only contract on a REAL server (compiled dist) + a REAL
 * git repo:
 *
 *   GET  /api/builds        list (filters: status/prId/revision; pagination)
 *   GET  /api/builds/:id    single record
 *
 *   - merge triggers a REAL build; the e2e polls GET /api/builds/:id
 *     over HTTP until the record reaches SUCCEEDED (no DB-direct reads);
 *   - without FACTORY_BUILD_COMMAND the record stays NOT_EXECUTED and
 *     reads back with honest nulls + notes;
 *   - list filters / pagination / 400s / 404 / 405 (non-GET refused);
 *   - RBAC: requiredRoleFor wires GET /api/builds[/:id] to viewer.
 *
 * Dual-mode note: imports only ../src/auth.ts (node builtins only),
 * so Node type-stripping resolves it like the other src-importing
 * tests; the server itself is booted from compiled dist.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredRoleFor } from '../src/auth.ts';

const TOKEN = 'builds-read-31-test-token-0123456789';

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: parsed };
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(
  dbFile: string,
  secretsDir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ child: ChildProcess; port: number }> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  // Scrub potentially inherited build-runner env first (a caller's
  // FACTORY_BUILD_COMMAND must never leak into a server that is meant
  // to run without it), then let the explicit extraEnv win.
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  delete baseEnv['FACTORY_BUILD_COMMAND'];
  delete baseEnv['FACTORY_GIT_BROKER_ACTIONS'];
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKEN: TOKEN,
    FACTORY_SECRETS_DIR: secretsDir,
    ...extraEnv,
  };
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return { child, port };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('server did not boot');
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** Real repo with a lockfile carrying real package entries. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-buildsread-'));
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'user.name', 'audit']);
  git(dir, ['config', 'user.email', 'audit@example.com']);
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        '': { name: 'demo', version: '1.0.0' },
        'node_modules/left-pad': { version: '1.3.0' },
      },
    }),
  );
  writeFileSync(join(dir, 'a.txt'), 'line1\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'root']);
  git(dir, ['checkout', '-qb', 'feat']);
  writeFileSync(join(dir, 'f.txt'), 'f\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'feat']);
  git(dir, ['checkout', '-q', 'main']);
  return dir;
}

async function mergeOne(
  port: number,
  repo: string,
  branch: string,
): Promise<{ prId: string; candidate: string }> {
  const project = await api(port, 'POST', '/api/projects', { name: 'BUILDSREAD' });
  assert.equal(project.status, 201);
  const task = await api(port, 'POST', '/api/tasks', {
    projectId: project.body['id'],
    title: 'builds read task',
    goal: 'observe a real build over HTTP',
  });
  assert.equal(task.status, 201);
  const pr = await api(port, 'POST', '/api/git/pr', {
    repo,
    taskId: task.body['id'],
    sourceBranch: branch,
    targetBranch: 'main',
    title: `Merge ${branch}`,
  });
  assert.equal(pr.status, 201);
  const prId = pr.body['id'] as string;
  const candidate = git(repo, ['rev-parse', branch]);
  const m = await api(port, 'POST', `/api/git/pr/${prId}/merge`, { repo, actor: 'human' });
  assert.equal(m.status, 200);
  return { prId, candidate };
}

/** Poll the HTTP read endpoint (not the DB file) until the build is terminal. */
async function waitForTerminalOverHttp(
  port: number,
  buildId: string,
  timeoutMs = 90_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const r = await api(port, 'GET', `/api/builds/${buildId}`);
    assert.equal(r.status, 200, `GET /api/builds/:id → ${r.status}: ${JSON.stringify(r.body)}`);
    last = r.body['build'];
    if (last && last.status !== 'NOT_EXECUTED') return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`build ${buildId} never reached a terminal state (last=${JSON.stringify(last)})`);
}

function cleanupServer(s: { child: ChildProcess; port: number }): void {
  try {
    s.child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

describe('GET /api/builds RBAC wiring', () => {
  it('GET /api/builds and /api/builds/:id are viewer', () => {
    assert.equal(requiredRoleFor('GET', '/api/builds'), 'viewer');
    assert.equal(requiredRoleFor('GET', '/api/builds/some-id'), 'viewer');
  });

  it('non-GET on /api/builds requires admin (nothing writable exists there)', () => {
    assert.equal(requiredRoleFor('POST', '/api/builds'), 'admin');
    assert.equal(requiredRoleFor('DELETE', '/api/builds/some-id'), 'admin');
  });
});

describe('GET /api/builds read surface (real server, real build)', () => {
  it('merge → real build → observable over HTTP until SUCCEEDED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildsread-e2e-'));
    const repo = makeRepo();
    let s: { child: ChildProcess; port: number } | null = null;
    try {
      s = await bootServer(join(dir, 'factory.db'), join(dir, 'secrets'), {
        FACTORY_BUILD_COMMAND: `node -e "require('fs').writeFileSync('built.txt','ok')"`,
        FACTORY_BUILD_WORK_ROOT: mkdtempSync(join(tmpdir(), 'buildwork-')),
        FACTORY_BUILD_TIMEOUT_MS: '30000',
        FACTORY_BUILD_CONFIG_FILES: 'package-lock.json',
      });
      const { prId, candidate } = await mergeOne(s.port, repo, 'feat');

      // The build record exists before the build finishes — a pure
      // HTTP consumer can find it via the list endpoint, not the DB.
      let buildId: string | null = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !buildId) {
        const l = await api(s.port, 'GET', `/api/builds?prId=${prId}`);
        assert.equal(l.status, 200);
        const items = l.body['items'] as any[];
        if (items.length > 0) buildId = items[0]['id'] as string;
        else await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(buildId, 'build record appeared via GET /api/builds');

      const build = await waitForTerminalOverHttp(s.port, buildId!);
      assert.equal(build.status, 'SUCCEEDED', `failureReason=${build.failureReason}`);
      assert.equal(build.revision, candidate, 'record binds the merged candidate SHA');
      assert.ok(typeof build.digest === 'string' && build.digest.length === 64, 'real digest');
      assert.ok(typeof build.definition === 'string', 'definition locked from real inputs');
      assert.equal(build.exitCode, 0);
      assert.match(build.completedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
      // sbomNote is ALWAYS set — '' when an SBOM was recorded, a named
      // reason when not. Nothing fabricated.
      assert.ok('sbomNote' in build, 'sbomNote present on the record');
      if (build.sbomRef === null) {
        assert.ok(typeof build.sbomNote === 'string' && build.sbomNote.length > 0, 'sbomNote names the absence');
      } else {
        assert.equal(build.sbomNote, '', 'recorded SBOM carries an empty note');
      }
      assert.ok('attestationRef' in build, 'attestationRef present (null without a signing key)');
      assert.ok('digestNote' in build && 'definitionNote' in build, 'notes present');

      // Single GET returns the same record the list returned.
      const one = await api(s.port, 'GET', `/api/builds/${buildId}`);
      assert.equal(one.status, 200);
      assert.deepEqual(one.body['build'], build);
    } finally {
      if (s) cleanupServer(s);
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('no build command → NOT_EXECUTED with honest nulls, list filters and pagination', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildsread-list-'));
    const repo = makeRepo();
    let s: { child: ChildProcess; port: number } | null = null;
    try {
      // No FACTORY_BUILD_COMMAND: the build surface is off; the record
      // honestly stays NOT_EXECUTED — and the read endpoint shows it.
      s = await bootServer(join(dir, 'factory.db'), join(dir, 'secrets'), {});
      const { prId } = await mergeOne(s.port, repo, 'feat');

      let buildId: string | null = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !buildId) {
        const l = await api(s.port, 'GET', `/api/builds?prId=${prId}`);
        assert.equal(l.status, 200);
        const items = l.body['items'] as any[];
        if (items.length > 0) buildId = items[0]['id'] as string;
        else await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(buildId, 'build record appeared via GET /api/builds');
      const one = await api(s.port, 'GET', `/api/builds/${buildId}`);
      assert.equal(one.status, 200);
      const b = one.body['build'];
      assert.equal(b.status, 'NOT_EXECUTED');
      assert.equal(b.digest, null);
      assert.ok(typeof b.digestNote === 'string' && b.digestNote.length > 0, 'digestNote names the absence');
      assert.equal(b.sbomRef, null);
      assert.ok(typeof b.sbomNote === 'string' && b.sbomNote.length > 0, 'sbomNote names the absence');

      // Filters: status + prId narrow; a wrong status empties.
      const byStatus = await api(s.port, 'GET', '/api/builds?status=NOT_EXECUTED');
      assert.equal(byStatus.status, 200);
      assert.ok((byStatus.body['items'] as any[]).every((i) => i.status === 'NOT_EXECUTED'));
      assert.ok((byStatus.body['items'] as any[]).some((i) => i.id === buildId));

      const byPrAndStatus = await api(s.port, 'GET', `/api/builds?prId=${prId}&status=NOT_EXECUTED`);
      assert.equal(byPrAndStatus.status, 200);
      assert.equal((byPrAndStatus.body['items'] as any[]).length, 1);

      const empty = await api(s.port, 'GET', '/api/builds?status=SUCCEEDED');
      assert.equal(empty.status, 200);
      assert.equal((empty.body['items'] as any[]).length, 0);
      assert.equal(empty.body['total'], 0);

      const byRevision = await api(s.port, 'GET', `/api/builds?revision=${b.revision}`);
      assert.equal(byRevision.status, 200);
      assert.ok((byRevision.body['items'] as any[]).some((i) => i.id === buildId));

      // Pagination: limit=0 returns nothing but reports the total;
      // offset beyond the end returns nothing.
      const p0 = await api(s.port, 'GET', '/api/builds?limit=0');
      assert.equal(p0.status, 200);
      assert.equal((p0.body['items'] as any[]).length, 0);
      assert.equal(p0.body['total'], 1);
      assert.equal(p0.body['limit'], 0);

      const p1 = await api(s.port, 'GET', '/api/builds?limit=1&offset=0');
      assert.equal(p1.status, 200);
      assert.equal((p1.body['items'] as any[]).length, 1);

      const p2 = await api(s.port, 'GET', '/api/builds?limit=1&offset=99');
      assert.equal(p2.status, 200);
      assert.equal((p2.body['items'] as any[]).length, 0);
      assert.equal(p2.body['total'], 1);

      // 400s: bad status, bad limit, bad offset.
      const badStatus = await api(s.port, 'GET', '/api/builds?status=RUNNING');
      assert.equal(badStatus.status, 400);
      const badLimit = await api(s.port, 'GET', '/api/builds?limit=nope');
      assert.equal(badLimit.status, 400);
      const bigLimit = await api(s.port, 'GET', '/api/builds?limit=1000');
      assert.equal(bigLimit.status, 400);
      const badOffset = await api(s.port, 'GET', '/api/builds?offset=-1');
      assert.equal(badOffset.status, 400);

      // 404 for an unknown id; 405 for a write-like method.
      const missing = await api(s.port, 'GET', '/api/builds/does-not-exist');
      assert.equal(missing.status, 404);
      const post = await api(s.port, 'POST', '/api/builds', {});
      assert.equal(post.status, 405);
    } finally {
      if (s) cleanupServer(s);
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

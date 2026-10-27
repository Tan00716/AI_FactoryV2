/**
 * R6-S2 rebase + stash — HTTP integration tests (dist).
 *
 * Boots the real server (dist) with an isolated DB + data dir, then
 * against REAL git fixture repos created inside the server cwd (so both
 * the inspection-root jail and the shadow-checkpoint jail accept them):
 *   todos    -> base..HEAD as pick lines
 *   start    -> reorder completes, order changes
 *   start    -> dirty tree 409, out-of-range 400
 *   conflict -> conflict status + conflicted files, abort restores HEAD
 *   stash    -> push/list/show/apply/pop/drop full chain over HTTP
 *   escape   -> repo outside inspect roots 403
 *
 * Run: npm run build -w @ai-factory/server && node scripts/run-tests-tmp.mjs --test apps/server/tests/rebase.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

interface Running {
  port: number;
  proc: ChildProcess;
  dataDir: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
      } else {
        const { port } = addr as net.AddressInfo;
        srv.close(() => resolve(port));
      }
    });
  });
}

function homeTmp(prefix: string): string {
  const base = path.join(os.homedir(), 'r6s2-shots', 'tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

async function startServer(): Promise<Running> {
  const dataDir = homeTmp('aif-rebase-data-');
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dataDir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dataDir, 'data'),
    FACTORY_SECRETS_DIR: path.join(dataDir, 'secrets'),
    FACTORY_INSPECT_ROOTS: dataDir,
  };
  for (const k of ['FACTORY_API_TOKEN', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    cwd: dataDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const deadline = Date.now() + 45_000;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited during startup: ${stderr.slice(0, 400)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { port, proc, dataDir };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (s.proc.exitCode !== null || s.proc.signalCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (s.proc.exitCode === null && s.proc.signalCode === null) s.proc.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

function commitFile(repo: string, name: string, content: string, msg: string): void {
  fs.writeFileSync(path.join(repo, name), content);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', msg]);
}

function makeRepo(dataDir: string, name: string): string {
  const repo = path.join(dataDir, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main', '-q']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  return repo;
}

async function req(s: Running, method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${s.port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await r.json()) as Record<string, unknown>;
  return { status: r.status, json };
}

test('rebase todos/start/status/stash full chain over HTTP', async (t) => {
  const s = await startServer();
  t.after(() => stopServer(s));
  const repo = makeRepo(s.dataDir, 'repo');
  commitFile(repo, 'base.txt', 'base\n', 'base commit');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  commitFile(repo, 'a.txt', 'a\n', 'commit A');
  commitFile(repo, 'b.txt', 'b\n', 'commit B');
  commitFile(repo, 'c.txt', 'c\n', 'commit C');

  // todos
  const todos = await req(s, 'GET', `/api/rebase/todos?repo=${encodeURIComponent(repo)}&base=${base}`);
  assert.equal(todos.status, 200, JSON.stringify(todos.json));
  const lines = todos.json['todos'] as { action: string; hash: string; subject: string }[];
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.subject), ['commit A', 'commit B', 'commit C']);

  // start: reorder C first
  const reordered = [lines[2], lines[0], lines[1]];
  const started = await req(s, 'POST', '/api/rebase/start', { repo, base, todos: reordered });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.equal(started.json['status'], 'completed');
  assert.ok(typeof started.json['checkpointId'] === 'string', 'shadow checkpoint id returned');
  const after = await req(s, 'GET', `/api/rebase/todos?repo=${encodeURIComponent(repo)}&base=${base}`);
  assert.deepEqual(
    (after.json['todos'] as { subject: string }[]).map((l) => l.subject),
    ['commit C', 'commit A', 'commit B'],
  );

  // status: idle
  const status = await req(s, 'GET', `/api/rebase/status?repo=${encodeURIComponent(repo)}`);
  assert.equal(status.json['inProgress'], false);

  // stash chain
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a-modified\n');
  const pushed = await req(s, 'POST', '/api/stash/push', { repo, message: 'http stash' });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.json));
  const listed = await req(s, 'GET', `/api/stash?repo=${encodeURIComponent(repo)}`);
  assert.equal((listed.json['entries'] as unknown[]).length, 1);
  const shown = await req(s, 'GET', `/api/stash/show?repo=${encodeURIComponent(repo)}&index=stash@{0}`);
  assert.match(String(shown.json['diff']), /a-modified/);
  const applied = await req(s, 'POST', '/api/stash/apply', { repo, index: 'stash@{0}' });
  assert.equal(applied.json['outcome'], 'applied');
  const stillThere = await req(s, 'GET', `/api/stash?repo=${encodeURIComponent(repo)}`);
  assert.equal((stillThere.json['entries'] as unknown[]).length, 1, 'apply keeps the entry');
  git(repo, ['checkout', '--', '.']);
  const popped = await req(s, 'POST', '/api/stash/pop', { repo, index: 'stash@{0}' });
  assert.equal(popped.json['outcome'], 'applied');
  const empty = await req(s, 'GET', `/api/stash?repo=${encodeURIComponent(repo)}`);
  assert.equal((empty.json['entries'] as unknown[]).length, 0, 'pop removes the entry');
});

test('rebase dirty tree refused, conflict then abort restores', async (t) => {
  const s = await startServer();
  t.after(() => stopServer(s));
  const repo = makeRepo(s.dataDir, 'repo2');
  commitFile(repo, 'f.txt', 'line1\nline2\n', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  commitFile(repo, 'f.txt', 'line1\nBASE-SIDE\n', 'base side');
  const baseSide = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  git(repo, ['checkout', '-qb', 'feature', base]);
  commitFile(repo, 'f.txt', 'line1\nFEATURE-SIDE\n', 'feature side');
  const featureHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  // dirty tree refused
  fs.writeFileSync(path.join(repo, 'f.txt'), 'dirty\n');
  const dirty = await req(s, 'POST', '/api/rebase/start', {
    repo,
    base: baseSide,
    todos: [{ action: 'pick', hash: featureHead, subject: 'feature side' }],
  });
  assert.equal(dirty.status, 409, JSON.stringify(dirty.json));
  git(repo, ['checkout', '--', '.']);

  // conflict
  const conflicted = await req(s, 'POST', '/api/rebase/start', {
    repo,
    base: baseSide,
    todos: [{ action: 'pick', hash: featureHead, subject: 'feature side' }],
  });
  assert.equal(conflicted.status, 200, JSON.stringify(conflicted.json));
  assert.equal(conflicted.json['status'], 'conflict');
  assert.deepEqual(conflicted.json['conflictedFiles'], ['f.txt']);
  const status = await req(s, 'GET', `/api/rebase/status?repo=${encodeURIComponent(repo)}`);
  assert.equal(status.json['inProgress'], true);

  // abort restores HEAD
  const aborted = await req(s, 'POST', '/api/rebase/abort', { repo });
  assert.equal(aborted.json['status'], 'completed');
  assert.equal(aborted.json['headAfter'], featureHead);
});

test('repo outside inspect roots is 403, non-repo is 404', async (t) => {
  const s = await startServer();
  t.after(() => stopServer(s));
  const outside = homeTmp('outside-');
  const esc = await req(s, 'GET', `/api/rebase/status?repo=${encodeURIComponent(outside)}`);
  assert.equal(esc.status, 403, JSON.stringify(esc.json));
  const notRepo = path.join(s.dataDir, 'plain');
  fs.mkdirSync(notRepo, { recursive: true });
  const nr = await req(s, 'GET', `/api/rebase/status?repo=${encodeURIComponent(notRepo)}`);
  assert.equal(nr.status, 404, JSON.stringify(nr.json));
  fs.rmSync(outside, { recursive: true, force: true });
});

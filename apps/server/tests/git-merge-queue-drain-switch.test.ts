/**
 * Merge queue M1 single-writer switch (Batch 47, FACTORY_MERGE_DRAIN=0).
 *
 * Real compiled server (dist/index.js) over a temp DB, zero src imports
 * (dual-mode iron law). Pins:
 *  - switch ON: POST /api/git/merge-queue -> 202 + drainPending: true,
 *    entry stays QUEUED, PR stays OPEN, and a MERGE_QUEUE_ENQUEUED audit
 *    record lands (drain was never attempted).
 *  - switch OFF (default, env unset): old behavior is untouched — the
 *    same POST drains synchronously and returns 201 with a MERGED entry.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'git-merge-drain-switch-token-0123456789';

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: parsed };
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

const children: ChildProcess[] = [];
after(() => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
});

async function bootServer(
  dbFile: string,
  extraEnv: Record<string, string> = {},
): Promise<number> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKEN: TOKEN,
    FACTORY_SECRETS_DIR: mkdtempSync(join(tmpdir(), 'git-mq-drain-secrets-')),
    ...extraEnv,
  };
  delete env['FACTORY_GIT_BROKER_ACTIONS'];
  if (!('FACTORY_MERGE_DRAIN' in extraEnv)) delete env['FACTORY_MERGE_DRAIN'];
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
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** A repo with one branch that merges cleanly onto main (for the drain path). */
function makeSimpleRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-mq-drain-repo-'));
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
    name: 'MQ drain switch',
    description: 'batch 47',
  });
  assert.equal(project.status, 201);
  const task = await api(port, 'POST', '/api/tasks', {
    projectId: project.body['id'] as unknown as string,
    title: 'drain switch task',
    goal: 'm1',
  });
  assert.equal(task.status, 201);
  const pr = await api(port, 'POST', '/api/git/pr', {
    taskId: task.body['id'] as unknown as string,
    sourceBranch: 'feat',
    targetBranch: 'main',
    title: 'drain switch pr',
    repo,
  });
  assert.equal(pr.status, 201);
  return pr.body['id'] as unknown as string;
}

describe('merge queue M1 single-writer switch (FACTORY_MERGE_DRAIN)', () => {
  it('switch ON: enqueue-only, 202 + drainPending, entry stays QUEUED', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-mq-drain-db-'));
    const repo = makeSimpleRepo();
    const port = await bootServer(join(dir, 'factory.db'), { FACTORY_MERGE_DRAIN: '0' });
    const prId = await makePr(port, repo);

    const q = await api(port, 'POST', '/api/git/merge-queue', { repo, prId });
    assert.equal(q.status, 202);
    assert.equal(q.body['drainPending'], true);
    const entry = q.body['entry'] as unknown as { id: string; status: string; prId: string };
    assert.equal(entry.status, 'QUEUED');
    assert.equal(entry.prId, prId);

    // Drain never ran: the durable entry is still QUEUED, and the queue
    // list agrees (the drain would have flipped it to MERGED/FAILED).
    const got = await api(port, 'GET', `/api/git/merge-queue/${entry.id}`);
    assert.equal(got.status, 200);
    assert.equal((got.body as unknown as { status: string })['status'], 'QUEUED');
    const list = await api(port, 'GET', `/api/git/merge-queue?repo=${encodeURIComponent(repo)}`);
    assert.equal(list.status, 200);
    const entries = (list.body as unknown as { entries: Array<{ id: string; status: string }> })[
      'entries'
    ];
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'QUEUED');

    // The deferral is audited (details is an object over HTTP).
    const audit = await api(port, 'GET', '/api/audit?limit=50');
    assert.equal(audit.status, 200);
    const rows = audit.body as unknown as Array<{
      action: string;
      details: Record<string, unknown>;
    }>;
    assert.ok(Array.isArray(rows));
    const hit = rows.find(
      (r) => r.action === 'MERGE_QUEUE_ENQUEUED' && r.details['entryId'] === entry.id,
    );
    assert.ok(hit, 'expected a MERGE_QUEUE_ENQUEUED audit record for the deferred drain');
    assert.equal(hit.details['drainPending'], true);
    assert.equal(hit.details['reason'], 'FACTORY_MERGE_DRAIN=0');

    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('switch OFF (default): drain still runs synchronously, 201', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-mq-drain-db-'));
    const repo = makeSimpleRepo();
    const port = await bootServer(join(dir, 'factory.db'));
    const prId = await makePr(port, repo);

    const q = await api(port, 'POST', '/api/git/merge-queue', { repo, prId });
    assert.equal(q.status, 201);
    assert.ok(!('drainPending' in q.body), 'default path must not grow a drainPending field');
    const entry = q.body['entry'] as unknown as { id: string; status: string };
    assert.equal(entry.status, 'MERGED');

    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });
});

/**
 * Walkthrough: merge-queue git execution goes through the same broker gate
 * (Batch 64, G2 / INV-05).
 *
 * SPEC_V2 INV-05: "权限由独立 Capability Enforcement 执行，权限校验覆盖
 * Shell、Git、MCP、API 及子进程所有路径。"
 *
 * The Git path's enforcement is the GitBroker (packages/git/src/broker.ts):
 * every HTTP git write route passes brokerBlocked() before any repository
 * is touched. The merge queue's git subprocesses (candidate verification
 * via `git merge-tree`, the actual merge) only run as the mechanical
 * execution of a merge action the broker already authorized at enqueue
 * time — there is no second, unbrokered door into the queue's git path.
 *
 * What this pins, end to end (real compiled server process, pure HTTP,
 * zero mocks, fresh temp SQLite + real temp git repo):
 *
 *   A. With the broker allowlist narrowed to exclude 'merge'
 *      (FACTORY_GIT_BROKER_ACTIONS=read,branch,commit), POST
 *      /api/git/merge-queue is refused with 403 GIT_BROKER_DENIED —
 *      the merge queue's git execution path is behind the same broker
 *      gate as every other git write.
 *   B. The refusal has zero side effects: no queue entry is created
 *      (GET /api/git/merge-queue?repo= is empty), the target branch tip
 *      is byte-identical before/after (no git subprocess ran), and a
 *      GIT_BROKER_DENIED audit record exists.
 *   C. Control: with the default allowlist and the drain switched off
 *      (FACTORY_MERGE_DRAIN=0, enqueue-only), the same request is
 *      accepted (202, drainPending) — the test is not vacuously green.
 *
 * Honest boundary (assessed, not changed): the build-runner's git
 * subprocesses (apps/server/src/build-runner.ts worktreeAddDetached)
 * are internal system mechanics downstream of the broker-authorized
 * merge decision — the runner acts as 'system', there is no principal
 * to gate, and the build record only exists because a merge landed.
 * Re-gating the same decision at the mechanics point would double-gate
 * it and couple the system worker to the user-facing action allowlist.
 * The user-facing 'worktree' action itself goes through the broker
 * (routes/worktrees.ts). The runner's *shell* subprocesses (the build
 * command) go through the same execution policy as /api/exec
 * (checkCommandPolicy + control-plane dir guard).
 *
 * Requires the workspace build (root `npm run build`): boots
 * ../dist/index.js. Hermetic: temp DB_PATH + temp FACTORY_SECRETS_DIR
 * + temp FACTORY_PROJECTS_ROOT per leg, no API tokens. Dual-mode: node
 * builtins + fetch + a real git binary, zero src imports.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  spawn,
  execFileSync,
  type ChildProcess,
} from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  dir: string,
  dbFile: string,
  extraEnv: Record<string, string> = {},
): Promise<{ child: ChildProcess; port: number }> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
    FACTORY_PROJECTS_ROOT: join(dir, 'projects'),
    ...extraEnv,
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
  delete env['NODE_TEST_CONTEXT'];
  delete env['NODE_TEST_WORKER_ID'];
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
      if (res.ok) return { child, port };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function stopServer(child: ChildProcess): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (Date.now() > deadline) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already dead
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function api(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, json };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A real repo: main + a feature branch (trivially mergeable). */
function makeRepo(): { dir: string; tipBefore: string } {
  const dir = mkdtempSync(join(homedir(), 'g2-mq-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'g2@example.com']);
  git(dir, ['config', 'user.name', 'g2']);
  execFileSync('sh', ['-c', `echo base > ${dir}/f.txt`]);
  git(dir, ['add', 'f.txt']);
  git(dir, ['commit', '-q', '-m', 'base']);
  git(dir, ['checkout', '-q', '-b', 'feat']);
  execFileSync('sh', ['-c', `echo feat > ${dir}/g.txt`]);
  git(dir, ['add', 'g.txt']);
  git(dir, ['commit', '-q', '-m', 'feat']);
  git(dir, ['checkout', '-q', 'main']);
  return { dir, tipBefore: git(dir, ['rev-parse', 'main']) };
}

async function makePr(port: number, repo: string): Promise<string> {
  const project = await api(port, 'POST', '/api/projects', { name: 'g2-mq' });
  assert.equal(project.status, 201);
  const task = await api(port, 'POST', '/api/tasks', {
    projectId: project.json['id'],
    title: 'merge feat',
  });
  assert.equal(task.status, 201);
  const pr = await api(port, 'POST', '/api/git/pr', {
    repo,
    taskId: task.json['id'],
    sourceBranch: 'feat',
    targetBranch: 'main',
    title: 'feat PR',
  });
  assert.equal(pr.status, 201, 'PR record created');
  return pr.json['id'] as string;
}

interface AuditRecord {
  action: string;
  actor: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}

async function auditRecords(port: number): Promise<AuditRecord[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/audit?limit=300`);
  assert.equal(res.status, 200);
  return (await res.json()) as AuditRecord[];
}

describe('merge-queue git execution goes through the same broker gate (G2 / INV-05)', () => {
  it('A+B: without the merge grant, enqueue is refused 403 with zero side effects', async () => {
    const dir = mkdtempSync(join(homedir(), 'g2-mq-deny-'));
    const { dir: repo, tipBefore } = makeRepo();
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'), {
      // 'merge' deliberately absent: the queue's action is not granted.
      FACTORY_GIT_BROKER_ACTIONS: 'read,branch,commit',
    });
    try {
      const prId = await makePr(port, repo);
      const r = await api(port, 'POST', '/api/git/merge-queue', {
        repo,
        prId,
        actor: 'human',
      });
      assert.equal(r.status, 403, 'merge-queue without merge grant must be 403');
      assert.equal(r.json['code'], 'GIT_BROKER_DENIED');
      assert.equal(r.json['action'], 'merge');

      // B: zero side effects — no entry, no git subprocess ran.
      const list = await api(port, 'GET', `/api/git/merge-queue?repo=${encodeURIComponent(repo)}`);
      assert.equal(list.status, 200);
      assert.deepEqual(
        (list.json['entries'] as unknown[]) ?? list.json,
        [],
        'no queue entry was created',
      );
      assert.equal(
        git(repo, ['rev-parse', 'main']),
        tipBefore,
        'target tip unchanged — no git subprocess ran',
      );
      const records = await auditRecords(port);
      const denied = records.find(
        (rec) =>
          rec.action === 'GIT_BROKER_DENIED' &&
          rec.details?.['action'] === 'merge',
      );
      assert.ok(denied, 'the broker denial is audited as GIT_BROKER_DENIED');
    } finally {
      await stopServer(child);
    }
  });

  it('C: control — with the grant, the same request is accepted (enqueue-only drain)', async () => {
    const dir = mkdtempSync(join(homedir(), 'g2-mq-allow-'));
    const { dir: repo } = makeRepo();
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'), {
      // Default allowlist (merge granted); drain switched off so the
      // test pins the gate, not a real merge.
      FACTORY_MERGE_DRAIN: '0',
    });
    try {
      const prId = await makePr(port, repo);
      const r = await api(port, 'POST', '/api/git/merge-queue', {
        repo,
        prId,
        actor: 'human',
      });
      assert.equal(r.status, 202, 'enqueue must be accepted with the grant');
      assert.equal(r.json['drainPending'], true);
      const entry = r.json['entry'] as Record<string, unknown>;
      assert.equal(entry['status'], 'QUEUED');
    } finally {
      await stopServer(child);
    }
  });
});

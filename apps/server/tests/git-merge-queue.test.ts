/**
 * Git Broker + Merge Queue over HTTP — Batch 16 (spec §36).
 *
 * Real compiled server (dist/index.js) over a temp DB, plus a real
 * temp git repository with the classic queue fixture: featA and featB
 * both rewrite the same line — each merges cleanly alone, B conflicts
 * once A has landed; featC is unrelated.
 *
 * Pins:
 *  - POST /api/git/merge-queue verifies the candidate against the
 *    CURRENT target tip: A lands (201, entry MERGED, §36 fields,
 *    merge evidence on the task), B is refused at candidate stage
 *    (409, entry FAILED with conflicts, PR stays OPEN, repo clean),
 *    C still lands — a failed entry never swallows the queue.
 *  - GET /api/git/merge-queue?repo= and /api/git/merge-queue/:id.
 *  - The archived-project guard refuses enqueue before an entry
 *    exists (409 PROJECT_ARCHIVED), like the direct merge.
 *  - The Git Broker gate: with FACTORY_GIT_BROKER_ACTIONS narrowed to
 *    exclude 'commit', POST /api/git/commit is 403 GIT_BROKER_DENIED
 *    with zero side effects and a GIT_BROKER_DENIED audit record,
 *    while an allowed action ('branch') still works.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'git-merge-queue-test-token-0123456789';

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, never> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body) headers['content-type'] = 'application/json';
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

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

interface BootedServer {
  child: ChildProcess;
  port: number;
}

async function bootServer(
  dbFile: string,
  extraEnv: Record<string, string> = {},
): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKEN: TOKEN,
    ...extraEnv,
  };
  if (!('FACTORY_GIT_BROKER_ACTIONS' in extraEnv)) delete env['FACTORY_GIT_BROKER_ACTIONS'];
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** main: f.txt="line1\nline2"; featA/featB rewrite line1; featC adds g.txt. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-mq-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'f.txt'), 'line1\nline2\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'base']);
  git(dir, ['checkout', '-qb', 'featA']);
  writeFileSync(join(dir, 'f.txt'), 'line1-A\nline2\n');
  git(dir, ['commit', '-qam', 'A']);
  git(dir, ['checkout', '-q', 'main']);
  git(dir, ['checkout', '-qb', 'featB']);
  writeFileSync(join(dir, 'f.txt'), 'line1-B\nline2\n');
  git(dir, ['commit', '-qam', 'B']);
  git(dir, ['checkout', '-q', 'main']);
  git(dir, ['checkout', '-qb', 'featC']);
  writeFileSync(join(dir, 'g.txt'), 'unrelated\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'C']);
  git(dir, ['checkout', '-q', 'main']);
  return dir;
}

type Entry = {
  id: string;
  prId: string;
  status: string;
  position: number;
  baseSha: string | null;
  candidateSha: string | null;
  targetSha: string | null;
  diffHash: string | null;
  artifactDigest: string | null;
  failureReason: string | null;
  mergeCommitSha: string | null;
  verification: { conflicts: string[] } | null;
};

describe('git merge queue (§36)', () => {
  it('verifies candidates against the current target, lands A and C, fails B at candidate stage', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-mq-db-'));
    const repo = makeRepo();
    const s = await bootServer(join(dir, 'factory.db'));
    try {
      const project = await api(s.port, 'POST', '/api/projects', {
        name: 'MQ Demo',
        description: 'batch 16',
      });
      assert.equal(project.status, 201);
      const pid = project.body['id'] as unknown as string;
      const task = await api(s.port, 'POST', '/api/tasks', {
        projectId: pid,
        title: 'Queue task',
        goal: 'merge via queue',
      });
      assert.equal(task.status, 201);
      const tid = task.body['id'] as unknown as string;

      const mkPr = async (sourceBranch: string, title: string): Promise<string> => {
        const pr = await api(s.port, 'POST', '/api/git/pr', {
          taskId: tid,
          sourceBranch,
          targetBranch: 'main',
          title,
          repo,
        });
        assert.equal(pr.status, 201);
        return pr.body['id'] as unknown as string;
      };
      const prA = await mkPr('featA', 'A');
      const prB = await mkPr('featB', 'B');
      const prC = await mkPr('featC', 'C');

      const evidenceTotal = async (): Promise<number> => {
        const rep = await api(s.port, 'GET', `/api/projects/${pid}/final-report`);
        const report = rep.body['report'] as unknown as {
          extensions: { evidence: { total: number } };
        };
        return report.extensions.evidence.total;
      };
      const ev0 = await evidenceTotal();

      // --- A lands through the queue ---
      const qa = await api(s.port, 'POST', '/api/git/merge-queue', { repo, prId: prA });
      assert.equal(qa.status, 201);
      const ea = qa.body['entry'] as unknown as Entry;
      assert.equal(ea.status, 'MERGED');
      assert.equal(ea.prId, prA);
      assert.equal(ea.position, 1);
      assert.ok(ea.baseSha && ea.candidateSha && ea.targetSha);
      assert.match(ea.diffHash ?? '', /^[0-9a-f]{64}$/);
      assert.equal(ea.artifactDigest, null);
      assert.equal(ea.mergeCommitSha, ea.targetSha);
      assert.ok((await evidenceTotal()) > ev0, 'merge evidence hung on the task');

      // --- B now conflicts with the UPDATED main: candidate-stage refusal ---
      const qb = await api(s.port, 'POST', '/api/git/merge-queue', { repo, prId: prB });
      assert.equal(qb.status, 409);
      const eb = qb.body['entry'] as unknown as Entry;
      assert.equal(eb.status, 'FAILED');
      assert.deepEqual(qb.body['conflicts'], ['f.txt']);
      assert.deepEqual(eb.verification?.conflicts, ['f.txt']);
      assert.equal(eb.baseSha, ea.mergeCommitSha, 'candidate assembled against the updated target');
      assert.ok(!existsSync(join(repo, '.git', 'MERGE_HEAD')), 'repo not left mid-merge');
      assert.equal(git(repo, ['rev-parse', 'main']).trim(), ea.mergeCommitSha);

      // --- C is not swallowed by B's failure ---
      const qc = await api(s.port, 'POST', '/api/git/merge-queue', { repo, prId: prC });
      assert.equal(qc.status, 201);
      const ec = qc.body['entry'] as unknown as Entry;
      assert.equal(ec.status, 'MERGED');
      assert.equal(ec.position, 3);

      // --- query surfaces ---
      const list = await api(
        s.port,
        'GET',
        `/api/git/merge-queue?repo=${encodeURIComponent(repo)}`,
      );
      assert.equal(list.status, 200);
      const entries = list.body['entries'] as unknown as Entry[];
      assert.equal(entries.length, 3);
      assert.deepEqual(
        entries.map((e) => e.status),
        ['MERGED', 'FAILED', 'MERGED'],
      );
      const one = await api(s.port, 'GET', `/api/git/merge-queue/${eb.id}`);
      assert.equal(one.status, 200);
      assert.equal((one.body as unknown as Entry).id, eb.id);
      const missing = await api(s.port, 'GET', '/api/git/merge-queue/nope');
      assert.equal(missing.status, 404);
      const noRepo = await api(s.port, 'GET', '/api/git/merge-queue');
      assert.equal(noRepo.status, 400);

      // --- validation + state errors ---
      const unknownPr = await api(s.port, 'POST', '/api/git/merge-queue', {
        repo,
        prId: 'no-such-pr',
      });
      assert.equal(unknownPr.status, 404);
      const requeue = await api(s.port, 'POST', '/api/git/merge-queue', { repo, prId: prA });
      assert.equal(requeue.status, 409, 'an already-merged PR cannot be re-queued');

      // --- archive guard: refused before an entry exists ---
      const prD = await mkPr('featC', 'D');
      const arch = await api(s.port, 'POST', `/api/projects/${pid}/archive`, {});
      assert.equal(arch.status, 200);
      const qd = await api(s.port, 'POST', '/api/git/merge-queue', { repo, prId: prD });
      assert.equal(qd.status, 409);
      assert.equal(qd.body['code'], 'PROJECT_ARCHIVED');
      assert.equal(qd.body['projectId'], pid);
      const listAfter = await api(
        s.port,
        'GET',
        `/api/git/merge-queue?repo=${encodeURIComponent(repo)}`,
      );
      assert.equal(
        (listAfter.body['entries'] as unknown as Entry[]).length,
        3,
        'no queue entry was created by the refused enqueue',
      );
      const un = await api(s.port, 'POST', `/api/projects/${pid}/unarchive`, {});
      assert.equal(un.status, 200);
    } finally {
      await stopServer(s);
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('broker gate: an action removed from the allowlist is denied with zero side effects', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-mq-db2-'));
    const repo = makeRepo();
    const s = await bootServer(join(dir, 'factory.db'), {
      FACTORY_GIT_BROKER_ACTIONS: 'branch,merge',
    });
    try {
      const logCount = async (): Promise<number> => {
        const r = await api(
          s.port,
          'GET',
          `/api/git/log?repo=${encodeURIComponent(repo)}&limit=50`,
        );
        assert.equal(r.status, 200);
        return (r.body as unknown as unknown[]).length;
      };
      const before = await logCount();

      // Stage a change, then try to commit it — 'commit' is not in
      // this server's broker allowlist.
      writeFileSync(join(repo, 'f.txt'), 'line1\nline2\nline3\n');
      execFileSync('git', ['add', '.'], { cwd: repo });
      const denied = await api(s.port, 'POST', '/api/git/commit', {
        repo,
        message: 'should not land',
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.body['code'], 'GIT_BROKER_DENIED');
      assert.equal(denied.body['action'], 'commit');
      assert.equal(await logCount(), before, 'no commit was created');

      // An allowed action still works in the same boot.
      const branch = await api(s.port, 'POST', '/api/git/branch', {
        repo,
        name: 'topic/allowed',
      });
      assert.equal(branch.status, 201);

      // The denial is in the audit trail.
      const audit = await api(s.port, 'GET', '/api/audit?limit=200');
      assert.equal(audit.status, 200);
      assert.ok(
        JSON.stringify(audit.body).includes('GIT_BROKER_DENIED'),
        'GIT_BROKER_DENIED missing from audit',
      );
    } finally {
      await stopServer(s);
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

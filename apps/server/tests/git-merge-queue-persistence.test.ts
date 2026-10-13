/**
 * Merge Queue + PR durability across a real SIGKILL — SPEC v2 §36
 * (Batch 20).
 *
 * The REAL server (boot → SIGKILL → reboot on the same DB file), with
 * a real temp git repository (featA lands, featB conflicts with it,
 * featC is unrelated):
 *  - boot 1: A enqueues and MERGES (201), B enqueues and FAILS at the
 *    candidate stage (409, PR stays OPEN); both decisions carry a
 *    decisionAuditRef;
 *  - SIGKILL, reboot on the same DB;
 *  - the queue rebuilds honestly: A is still MERGED with its §36
 *    fields, B is still FAILED with its conflicts (not reprocessed,
 *    not lost);
 *  - re-enqueueing B re-verifies from a freshly assembled candidate
 *    (409 again — the stored verdict is not trusted);
 *  - C enqueues after the restart and genuinely merges (201): the
 *    re-verification path truly completes work post-restart.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'git-mq-persist-test-token-0123456789';

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

async function bootServer(dbFile: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKEN: TOKEN,
  };
  delete env['FACTORY_GIT_BROKER_ACTIONS'];
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

async function killServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGKILL');
  await new Promise((r) => s.child.once('exit', r));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** main: f.txt="line1\nline2"; featA/featB rewrite line1; featC adds g.txt. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-mq-persist-repo-'));
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
  mergeCommitSha: string | null;
  failureReason: string | null;
  decisionAuditRef: string | null;
  verification: { conflicts: string[] } | null;
};

describe('merge queue durability across SIGKILL (§36, Batch 20)', () => {
  it(
    'queued work survives a kill: MERGED/FAILED history rebuilds, re-verify truly merges',
    { timeout: 120_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'git-mq-persist-db-'));
      const repo = makeRepo();
      const dbFile = join(dir, 'factory.db');
      let prA = '';
      let prB = '';
      let prC = '';
      try {
        // ------------------------------------------------ boot 1 ----
        const s1 = await bootServer(dbFile);
        try {
          const project = await api(s1.port, 'POST', '/api/projects', {
            name: 'MQ Persist',
            description: 'batch 20',
          });
          assert.equal(project.status, 201);
          const pid = project.body['id'] as unknown as string;
          const task = await api(s1.port, 'POST', '/api/tasks', {
            projectId: pid,
            title: 'Queue task',
            goal: 'merge via queue',
          });
          assert.equal(task.status, 201);
          const tid = task.body['id'] as unknown as string;
          const mkPr = async (sourceBranch: string, title: string): Promise<string> => {
            const pr = await api(s1.port, 'POST', '/api/git/pr', {
              taskId: tid,
              sourceBranch,
              targetBranch: 'main',
              title,
              repo,
            });
            assert.equal(pr.status, 201);
            return pr.body['id'] as unknown as string;
          };
          prA = await mkPr('featA', 'A');
          prB = await mkPr('featB', 'B');
          prC = await mkPr('featC', 'C');

          const qa = await api(s1.port, 'POST', '/api/git/merge-queue', {
            repo,
            prId: prA,
          });
          assert.equal(qa.status, 201);
          const ea = qa.body['entry'] as unknown as Entry;
          assert.equal(ea.status, 'MERGED');
          assert.ok(ea.decisionAuditRef, 'MERGED decision keeps its audit reference');

          const qb = await api(s1.port, 'POST', '/api/git/merge-queue', {
            repo,
            prId: prB,
          });
          assert.equal(qb.status, 409);
          const eb = qb.body['entry'] as unknown as Entry;
          assert.equal(eb.status, 'FAILED');
          assert.ok((eb.verification?.conflicts.length ?? 0) > 0);
          assert.ok(eb.decisionAuditRef, 'FAILED decision keeps its audit reference');
        } finally {
          await killServer(s1);
        }

        // ------------------------------------------------ boot 2 ----
        const s2 = await bootServer(dbFile);
        try {
          const listed = await api(
            s2.port,
            'GET',
            `/api/git/merge-queue?repo=${encodeURIComponent(repo)}`,
          );
          assert.equal(listed.status, 200);
          const entries = listed.body['entries'] as unknown as Entry[];
          assert.equal(entries.length, 2);
          const byPr = new Map(entries.map((e) => [e.prId, e]));
          const ra = byPr.get(prA);
          const rb = byPr.get(prB);
          assert.ok(ra && rb);
          // MERGED history is intact: the §36 fields survived the kill.
          assert.equal(ra.status, 'MERGED');
          assert.ok(ra.baseSha && ra.candidateSha && ra.targetSha);
          assert.match(ra.diffHash ?? '', /^[0-9a-f]{64}$/);
          assert.equal(ra.mergeCommitSha, ra.targetSha);
          assert.ok(ra.decisionAuditRef);
          // FAILED history is intact and queryable: not lost, not re-run.
          assert.equal(rb.status, 'FAILED');
          assert.ok((rb.verification?.conflicts.length ?? 0) > 0);
          assert.ok(rb.failureReason?.includes('conflict'));
          assert.ok(rb.decisionAuditRef);

          // Re-enqueueing B re-verifies from a FRESH candidate assembly
          // (the stored verdict is not trusted): still 409, and the
          // entry row is a new QUEUED→FAILED lifecycle.
          const qb2 = await api(s2.port, 'POST', '/api/git/merge-queue', {
            repo,
            prId: prB,
          });
          assert.equal(qb2.status, 409);
          const eb2 = qb2.body['entry'] as unknown as Entry;
          assert.equal(eb2.status, 'FAILED');
          assert.notEqual(eb2.id, rb.id, 'a re-enqueue is a new entry, not the old row');

          // C enqueues after the restart and genuinely merges: the
          // re-verification path truly completes work post-restart.
          const qc = await api(s2.port, 'POST', '/api/git/merge-queue', {
            repo,
            prId: prC,
          });
          assert.equal(qc.status, 201);
          const ec = qc.body['entry'] as unknown as Entry;
          assert.equal(ec.status, 'MERGED');
          assert.equal(ec.position, 4, 'positions continue past the restored history');
          const log = git(repo, ['log', '--oneline', '-1', 'main']);
          assert.ok(log.includes('C'), `main tip should be the C merge, got: ${log}`);
        } finally {
          await killServer(s2);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});

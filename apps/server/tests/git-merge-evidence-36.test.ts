/**
 * Batch 21-3 — §36 git evidence five fields reach the task evidence record.
 *
 * Re-audit finding: GitRepo.merge() computed the five §36 fields and the
 * merge queue persisted them on its entries, but the evidence RECORDS hung
 * on the task (via mergeEvidencePayload) dropped all five. This test pins
 * the full HTTP path for both the direct PR merge and the queue merge:
 * the merge evidence record on the task must carry genuine baseSha /
 * candidateSha / targetSha (40-hex SHAs), diffHash (64-hex sha256 of the
 * landed diff), and artifactDigest null with an honest 'no artifact' note.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'git-evidence-36-test-token-0123456789';

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

async function bootServer(dbFile: string): Promise<{ child: ChildProcess; port: number }> {
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

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-ev-http-36-'));
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'user.name', 'audit']);
  git(dir, ['config', 'user.email', 'audit@example.com']);
  writeFileSync(join(dir, 'a.txt'), 'line1\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'root']);
  git(dir, ['checkout', '-qb', 'feat-a']);
  writeFileSync(join(dir, 'fa.txt'), 'a\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'feat a']);
  git(dir, ['checkout', '-q', 'main']);
  git(dir, ['checkout', '-qb', 'feat-b']);
  writeFileSync(join(dir, 'fb.txt'), 'b\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'feat b']);
  git(dir, ['checkout', '-q', 'main']);
  return dir;
}

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;

function assertFiveFields(payload: any, label: string): void {
  assert.match(String(payload.baseSha), SHA40, `${label}: baseSha must be a real 40-hex SHA`);
  assert.match(String(payload.candidateSha), SHA40, `${label}: candidateSha must be a real 40-hex SHA`);
  assert.match(String(payload.targetSha), SHA40, `${label}: targetSha must be a real 40-hex SHA`);
  assert.match(String(payload.diffHash), SHA64, `${label}: diffHash must be a 64-hex sha256`);
  assert.equal(payload.artifactDigest, null, `${label}: no artifact is produced by a merge — null, not invented`);
  assert.equal(payload.artifactNote, 'no artifact', `${label}: honest missing-artifact note`);
  assert.notEqual(payload.baseSha, payload.targetSha, `${label}: base and target must differ after a real merge`);
}

describe('§36 merge evidence records carry the five fields (Batch 21-3)', () => {
  it('direct PR merge + queue merge both hang complete merge evidence on the task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-ev-http-'));
    const repo = makeRepo();
    let s: { child: ChildProcess; port: number } | null = null;
    try {
      s = await bootServer(join(dir, 'factory.db'));
      const project = await api(s.port, 'POST', '/api/projects', { name: 'EV36', description: 'batch 21-3' });
      assert.equal(project.status, 201);
      const task = await api(s.port, 'POST', '/api/tasks', {
        projectId: project.body['id'],
        title: 'Merge evidence task',
        goal: 'pin the five §36 fields',
      });
      assert.equal(task.status, 201);
      const tid = task.body['id'] as string;

      const mkPr = async (sourceBranch: string): Promise<string> => {
        const pr = await api(s.port, 'POST', '/api/git/pr', {
          repo,
          taskId: tid,
          sourceBranch,
          targetBranch: 'main',
          title: `Merge ${sourceBranch}`,
        });
        assert.equal(pr.status, 201);
        return pr.body['id'] as string;
      };
      const mergeEvidences = async (): Promise<any[]> => {
        const ev = await api(s.port, 'GET', `/api/evidence?taskId=${tid}`);
        assert.equal(ev.status, 200);
        return (ev.body as any[]).filter((e) => e.type === 'merge');
      };

      // --- direct PR merge ---
      const prA = await mkPr('feat-a');
      const m = await api(s.port, 'POST', `/api/git/pr/${prA}/merge`, { repo });
      assert.equal(m.status, 200);
      assertFiveFields(m.body['evidence']['payload'], 'direct merge inline evidence');
      let recs = await mergeEvidences();
      assert.equal(recs.length, 1, 'one merge evidence record on the task');
      assertFiveFields(recs[0].payload, 'direct merge persisted evidence');

      // --- queue merge ---
      const prB = await mkPr('feat-b');
      const q = await api(s.port, 'POST', '/api/git/merge-queue', { repo, prId: prB });
      assert.equal(q.status, 201);
      assert.equal(q.body['entry']['status'], 'MERGED');
      recs = await mergeEvidences();
      assert.equal(recs.length, 2, 'queue merge hangs its own merge evidence');
      assertFiveFields(recs[1].payload, 'queue merge persisted evidence');
    } finally {
      s?.child.kill();
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

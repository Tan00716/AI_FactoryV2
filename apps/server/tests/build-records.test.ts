/**
 * Batch 23 — §40 build records: every landed merge writes one build
 * record, and the record is honestly NOT a build.
 *
 * Full HTTP path on a real server (dist) + real git repo, for both the
 * direct PR merge and the merge-queue merge: after the merges land, the
 * server is killed and the DB file is opened directly — the builds
 * table must hold one row per merge with:
 *  - revision = the real candidate SHA (40-hex), targetSha/baseSha
 *    40-hex, diffHash 64-hex, prId/taskId/branches/actor all real;
 *  - status NOT_EXECUTED, digest/definition/sbomRef/attestationRef
 *    null, each null carrying its pinned reason note (absence, not a
 *    placeholder — no fabricated digest).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactoryDatabase, NO_BUILD_DIGEST_NOTE, NO_BUILD_DEFINITION_NOTE } from '@ai-factory/db';
// NOTE: git.ts value-imports sibling route modules extensionless, which
// tsc resolves but node type-stripping cannot — so the unit test below
// imports the compiled dist (repo dual-mode rule, Batch 21 closeout).
import { buildRecordInputForMerge } from '../dist/routes/git.js';

const TOKEN = 'build-records-23-test-token-0123456789';

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

async function bootServer(dbFile: string, secretsDir: string): Promise<{ child: ChildProcess; port: number }> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKEN: TOKEN,
    // Hermetic secrets (Batch 21 closeout lesson): never inherit the
    // developer's local data/secrets/ vault.
    FACTORY_SECRETS_DIR: secretsDir,
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
  const dir = mkdtempSync(join(tmpdir(), 'git-buildrec-'));
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

describe('buildRecordInputForMerge honesty contract (unit)', () => {
  const base = {
    repo: '/repo/a',
    prId: 'pr-1',
    taskId: 'task-1',
    sourceBranch: 'feat',
    targetBranch: 'main',
    baseSha: 'c'.repeat(40),
    candidateSha: 'a'.repeat(40),
    targetSha: 'b'.repeat(40),
    diffHash: 'd'.repeat(64),
    builtBy: 'human',
  };
  it('passes real merge fields through untouched', () => {
    const input = buildRecordInputForMerge(base);
    assert.ok(input, 'input built');
    assert.equal(input.revision, base.candidateSha, 'revision is the candidate SHA, not the merge commit');
    assert.equal(input.prId, 'pr-1');
    assert.equal(input.builtBy, 'human');
  });
  it('returns null (never a fabricated revision) when candidateSha is missing', () => {
    const input = buildRecordInputForMerge({ ...base, candidateSha: null });
    assert.equal(input, null, 'no revision → no record; the caller audits BUILD_RECORD_SKIPPED');
    // ...and it must NOT silently fall back to targetSha.
    const fallback = buildRecordInputForMerge({ ...base, candidateSha: null, targetSha: 'b'.repeat(40) });
    assert.equal(fallback, null, 'targetSha is not an acceptable substitute for revision');
  });
});

describe('§40 build records are written on merge — honestly not builds (Batch 23)', () => {
  it('direct merge and queue merge each leave one honest NOT_EXECUTED build record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildrec-http-'));
    const repo = makeRepo();
    const dbFile = join(dir, 'factory.db');
    let s: { child: ChildProcess; port: number } | null = null;
    try {
      s = await bootServer(dbFile, join(dir, 'secrets'));
      const project = await api(s.port, 'POST', '/api/projects', { name: 'BUILDREC', description: 'batch 23' });
      assert.equal(project.status, 201);
      const task = await api(s.port, 'POST', '/api/tasks', {
        projectId: project.body['id'],
        title: 'Build record task',
        goal: 'pin the honest build record',
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

      // --- direct PR merge ---
      const prA = await mkPr('feat-a');
      const candidateA = git(repo, ['rev-parse', 'feat-a']);
      const m = await api(s.port, 'POST', `/api/git/pr/${prA}/merge`, { repo, actor: 'human' });
      assert.equal(m.status, 200);

      // --- queue merge ---
      const prB = await mkPr('feat-b');
      const candidateB = git(repo, ['rev-parse', 'feat-b']);
      const q = await api(s.port, 'POST', '/api/git/merge-queue', { repo, prId: prB, actor: 'human' });
      assert.equal(q.status, 201);
      assert.equal(q.body['entry']['status'], 'MERGED');

      // Kill the server, then read the builds table straight from the file.
      s.child.kill('SIGKILL');
      await new Promise((r) => s!.child.once('exit', r));
      s = null;

      const fdb = new FactoryDatabase(dbFile);
      try {
        const rowsA = fdb.builds.listByPr(prA);
        const rowsB = fdb.builds.listByPr(prB);
        assert.equal(rowsA.length, 1, 'direct merge wrote exactly one build record');
        assert.equal(rowsB.length, 1, 'queue merge wrote exactly one build record');

        const check = (row: (typeof rowsA)[number], prId: string, candidate: string, label: string) => {
          assert.equal(row.prId, prId);
          assert.equal(row.taskId, tid);
          assert.equal(row.revision, candidate, `${label}: revision is the real candidate SHA`);
          assert.match(row.revision, SHA40);
          assert.match(String(row.targetSha), SHA40, `${label}: targetSha is a real SHA`);
          assert.match(String(row.baseSha), SHA40, `${label}: baseSha is a real SHA`);
          assert.match(String(row.diffHash), SHA64, `${label}: diffHash is a real sha256`);
          assert.equal(row.repo, repo);
          assert.equal(row.builtBy, 'human');
          // The honest core: this is a merge marker, not a build.
          assert.equal(row.status, 'NOT_EXECUTED', `${label}: no build was executed`);
          assert.equal(row.digest, null, `${label}: digest null — not invented`);
          assert.equal(row.digestNote, NO_BUILD_DIGEST_NOTE, `${label}: absence carries its reason`);
          assert.equal(row.definition, null, `${label}: no definition assembled`);
          assert.equal(row.definitionNote, NO_BUILD_DEFINITION_NOTE);
          assert.equal(row.sbomRef, null, `${label}: no SBOM without a build`);
          assert.equal(row.attestationRef, null, `${label}: no attestation without a build`);
        };
        check(rowsA[0], prA, candidateA, 'direct merge');
        check(rowsB[0], prB, candidateB, 'queue merge');
        assert.notEqual(rowsA[0].id, rowsB[0].id, 'one row per merge');
        assert.equal(fdb.builds.list().length, 2);
      } finally {
        fdb.close();
      }
    } finally {
      s?.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

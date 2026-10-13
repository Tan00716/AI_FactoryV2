/**
 * Batch 24 — §40 post-merge build execution.
 *
 * Full HTTP path on a real server (dist) + real git repo. The server is
 * booted with FACTORY_BUILD_COMMAND configured, so a landed merge must
 * trigger a REAL background build:
 *  - success: the builds record moves NOT_EXECUTED → SUCCEEDED with a
 *    real §40 digest (independently recomputed via lockBuild over the
 *    same definition — pinned, not trusted), and the merge evidence
 *    record gets artifactDigest bound (the 'no artifact' note is gone);
 *  - failing command → FAILED with the reason recorded, digest null;
 *  - policy-refused command → FAILED, never executed;
 *  - no FACTORY_BUILD_COMMAND → the record honestly stays NOT_EXECUTED.
 *
 * NOTE (dual-mode rule, Batch 21 closeout): build-runner.ts
 * value-imports './routes/exec' extensionless, so tests import the
 * compiled dist here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { FactoryDatabase } from '@ai-factory/db';
import { lockBuild, verifyDevAttestation } from '@ai-factory/cicd';
import {
  buildRunnerConfigFromEnv,
  DEFAULT_BUILD_TIMEOUT_MS,
} from '../dist/build-runner.js';

const TOKEN = 'build-runner-24-test-token-0123456789';

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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKEN: TOKEN,
    FACTORY_SECRETS_DIR: secretsDir,
    ...extraEnv,
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

/** Real repo with a lockfile, so the §40 definition is fully lockable. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-buildrun-'));
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'user.name', 'audit']);
  git(dir, ['config', 'user.email', 'audit@example.com']);
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"name":"demo"}');
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

/** Real repo whose lockfile carries real package entries (for SBOM tests). */
function makeRepoWithDeps(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-buildsbom-'));
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
        'node_modules/@scope/right-pad': { version: '2.0.1' },
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

/** Real repo with no lockfile at all. */
function makeRepoNoLockfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-buildnolock-'));
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'user.name', 'audit']);
  git(dir, ['config', 'user.email', 'audit@example.com']);
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
): Promise<{ prId: string; taskId: string; candidate: string }> {
  const project = await api(port, 'POST', '/api/projects', { name: 'BUILDRUN' });
  assert.equal(project.status, 201);
  const task = await api(port, 'POST', '/api/tasks', {
    projectId: project.body['id'],
    title: 'build runner task',
    goal: 'run a real build',
  });
  assert.equal(task.status, 201);
  const taskId = task.body['id'] as string;
  const pr = await api(port, 'POST', '/api/git/pr', {
    repo,
    taskId,
    sourceBranch: branch,
    targetBranch: 'main',
    title: `Merge ${branch}`,
  });
  assert.equal(pr.status, 201);
  const prId = pr.body['id'] as string;
  const candidate = git(repo, ['rev-parse', branch]);
  const m = await api(port, 'POST', `/api/git/pr/${prId}/merge`, { repo, actor: 'human' });
  assert.equal(m.status, 200);
  return { prId, taskId, candidate };
}

/** Poll the DB file directly until the build record leaves NOT_EXECUTED. */
async function waitForTerminal(
  dbFile: string,
  prId: string,
  timeoutMs = 60_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    let fdb: FactoryDatabase | null = null;
    try {
      fdb = new FactoryDatabase(dbFile);
      const rows = fdb.builds.listByPr(prId);
      last = rows[0] ?? null;
      if (last && last.status !== 'NOT_EXECUTED') return last;
    } catch {
      /* transient lock contention — retry */
    } finally {
      try {
        fdb?.close();
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

const SHA64 = /^[0-9a-f]{64}$/;

describe('buildRunnerConfigFromEnv', () => {
  it('is null when the command is unset — the feature is off', () => {
    assert.equal(buildRunnerConfigFromEnv({}), null);
    assert.equal(buildRunnerConfigFromEnv({ FACTORY_BUILD_COMMAND: '   ' }), null);
  });
  it('parses the command, timeout, toolchain and config files', () => {
    const cfg = buildRunnerConfigFromEnv({
      FACTORY_BUILD_COMMAND: 'npm run build',
      FACTORY_BUILD_TIMEOUT_MS: '5000',
      FACTORY_BUILD_TOOLCHAIN: 'node v24',
      FACTORY_BUILD_CONFIG_FILES: 'tsconfig.json, package.json',
      FACTORY_BUILD_WORK_ROOT: '/tmp/br',
    });
    assert.ok(cfg);
    assert.equal(cfg.command, 'npm run build');
    assert.equal(cfg.timeoutMs, 5000);
    assert.equal(cfg.toolchain, 'node v24');
    assert.deepEqual(cfg.configFiles, ['tsconfig.json', 'package.json']);
    assert.equal(cfg.workRoot, '/tmp/br');
  });
  it('defaults the timeout when unset or invalid', () => {
    assert.equal(
      buildRunnerConfigFromEnv({ FACTORY_BUILD_COMMAND: 'x' })?.timeoutMs,
      DEFAULT_BUILD_TIMEOUT_MS,
    );
    assert.equal(
      buildRunnerConfigFromEnv({ FACTORY_BUILD_COMMAND: 'x', FACTORY_BUILD_TIMEOUT_MS: 'nope' })
        ?.timeoutMs,
      DEFAULT_BUILD_TIMEOUT_MS,
    );
  });
});

describe('§40 post-merge build execution (Batch 24)', () => {
  it('a landed merge triggers a real build: SUCCEEDED with a real digest, evidence bound', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildrun-ok-'));
    const repo = makeRepo();
    const dbFile = join(dir, 'factory.db');
    // NB: the work root must live OUTSIDE the DB directory — the
    // control-plane guard (correctly) refuses build workspaces inside
    // dirname(DB_PATH).
    const workRoot = mkdtempSync(join(tmpdir(), 'buildwork-'));
    const buildCmd = `node -e "require('fs').writeFileSync('built.txt','ok')"`;
    let s: { child: ChildProcess; port: number } | null = null;
    try {
      s = await bootServer(dbFile, join(dir, 'secrets'), {
        FACTORY_BUILD_COMMAND: buildCmd,
        FACTORY_BUILD_WORK_ROOT: workRoot,
        FACTORY_BUILD_TIMEOUT_MS: '30000',
        // package-lock.json really exists in the worktree, so the
        // §40 definition is fully lockable in this test.
        FACTORY_BUILD_CONFIG_FILES: 'package-lock.json',
      });
      const { prId, taskId, candidate } = await mergeOne(s.port, repo, 'feat');

      const row = await waitForTerminal(dbFile, prId);
      assert.ok(row, 'build record reached a terminal state');
      assert.equal(row.status, 'SUCCEEDED', `build really ran; failureReason=${row.failureReason}`);
      assert.equal(row.exitCode, 0);
      assert.equal(row.revision, candidate);
      assert.match(row.completedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

      // The digest is REAL: the stored definition recomputes to the
      // same digest via an independent lockBuild call.
      assert.ok(row.definition, 'definition was locked from real inputs');
      const def = JSON.parse(row.definition as string);
      assert.equal(def.revision, candidate, 'revision is the merged candidate SHA');
      assert.equal(
        def.lockfileHash,
        createHash('sha256').update('{"lockfileVersion":3,"name":"demo"}', 'utf8').digest('hex'),
        'lockfileHash is the real lockfile bytes',
      );
      assert.equal(def.buildDefinitionHash, createHash('sha256').update(buildCmd, 'utf8').digest('hex'));
      assert.deepEqual(def.dependencySources, ['package-lock.json']);
      const recomputed = lockBuild(
        {
          revision: def.revision,
          lockfileHash: def.lockfileHash,
          toolchain: def.toolchain,
          buildDefinitionHash: def.buildDefinitionHash,
          configHash: def.configHash,
          dependencySources: def.dependencySources,
        },
        'independent-recomputation',
      );
      assert.equal(row.digest, recomputed.digest, 'stored digest == independent recomputation');
      assert.match(row.digest as string, SHA64);

      // The merge evidence now carries the real artifactDigest —
      // the honest 'no artifact' note is gone.
      const ev = await api(s.port, 'GET', `/api/evidence?taskId=${taskId}`);
      assert.equal(ev.status, 200);
      const list = ev.body as Array<any>;
      assert.ok(Array.isArray(list), 'evidence endpoint returns an array');
      const mergeEv = list.find(
        (e) => e.type === 'merge' && e.payload?.['prId'] === prId,
      );
      assert.ok(mergeEv, 'merge evidence found');
      assert.equal(
        mergeEv.payload['artifactDigest'],
        row.digest,
        'evidence bound to the real build digest',
      );
      assert.ok(
        !('artifactNote' in (mergeEv.payload as Record<string, unknown>)),
        "'no artifact' note removed once the artifact exists",
      );

      // No build worktree left behind.
      let leftovers: string[] = [];
      try {
        leftovers = readdirSync(workRoot, { recursive: true } as any) as string[];
      } catch {
        leftovers = [];
      }
      assert.deepEqual(
        leftovers.filter((p) => !p.startsWith('.')),
        [],
        'worktree cleaned up after the build',
      );
    } finally {
      s?.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a failing build command records FAILED with the reason, digest stays null', async () => {

  it('a successful build records a lockfile-derived SBOM on disk (Batch 25)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildrun-sbom-'));
    const repo = makeRepoWithDeps();
    const dbFile = join(dir, 'factory.db');
    const workRoot = mkdtempSync(join(tmpdir(), 'buildwork-'));
    const sbomDir = join(dir, 'sboms');
    const buildCmd = `node -e "require('fs').writeFileSync('built.txt','ok')"`;
    let s: { child: ChildProcess; port: number } | null = null;
    try {
      s = await bootServer(dbFile, join(dir, 'secrets'), {
        FACTORY_BUILD_COMMAND: buildCmd,
        FACTORY_BUILD_WORK_ROOT: workRoot,
        FACTORY_BUILD_TIMEOUT_MS: '30000',
        FACTORY_SBOM_DIR: sbomDir,
        FACTORY_BUILD_CONFIG_FILES: 'package-lock.json',
      });
      const { prId } = await mergeOne(s.port, repo, 'feat');
      const row = await waitForTerminal(dbFile, prId);
      assert.ok(row, 'build record reached a terminal state');
      assert.equal(row.status, 'SUCCEEDED');
      // The record points at a real SBOM file under the configured dir.
      assert.ok(row.sbomRef, 'sbomRef set on success with a lockfile');
      assert.equal(row.sbomNote, '', 'clean SBOM generation leaves no note');
      assert.ok(
        (row.sbomRef as string).startsWith(sbomDir),
        `sbomRef under FACTORY_SBOM_DIR, got ${row.sbomRef}`,
      );
      assert.ok(existsSync(row.sbomRef as string), 'SBOM file really on disk');
      const doc = JSON.parse(readFileSync(row.sbomRef as string, 'utf8'));
      assert.equal(doc.bomFormat, 'CycloneDX');
      assert.equal(doc.specVersion, '1.5');
      const names = (doc.components as Array<any>).map((c) => `${c.name}@${c.version}`);
      assert.ok(names.includes('left-pad@1.3.0'), `left-pad in SBOM: ${names.join(',')}`);
      assert.ok(names.includes('@scope/right-pad@2.0.1'), `scoped dep in SBOM: ${names.join(',')}`);
      const prov = (doc.metadata.properties as Array<any>).find(
        (p) => p.name === 'ai-factory:sbom:provenance',
      );
      assert.ok(prov, 'SBOM says what it is (declared deps, not an installed-tree scan)');
    } finally {
      s?.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a successful build with FACTORY_ATTESTATION_KEY records a verifiable dev attestation (Batch 38)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildrun-attest-'));
    const repo = makeRepoWithDeps();
    const dbFile = join(dir, 'factory.db');
    const workRoot = mkdtempSync(join(tmpdir(), 'buildwork-'));
    const sbomDir = join(dir, 'sboms');
    const buildCmd = `node -e "require('fs').writeFileSync('built.txt','ok')"`;
    const seed = randomBytes(32).toString('hex');
    let s: { child: ChildProcess; port: number } | null = null;
    try {
      s = await bootServer(dbFile, join(dir, 'secrets'), {
        FACTORY_BUILD_COMMAND: buildCmd,
        FACTORY_BUILD_WORK_ROOT: workRoot,
        FACTORY_BUILD_TIMEOUT_MS: '30000',
        FACTORY_SBOM_DIR: sbomDir,
        FACTORY_BUILD_CONFIG_FILES: 'package-lock.json',
        FACTORY_ATTESTATION_KEY: seed,
      });
      const { prId } = await mergeOne(s.port, repo, 'feat');
      const row = await waitForTerminal(dbFile, prId);
      assert.ok(row, 'build record reached a terminal state');
      assert.equal(row.status, 'SUCCEEDED');
      assert.ok(row.digest, 'digest locked — attestation has a subject');
      // The record points at a real attestation file under the SBOM dir.
      assert.ok(row.attestationRef, 'attestationRef set when key configured');
      assert.ok(
        (row.attestationRef as string).startsWith(sbomDir),
        `attestationRef under FACTORY_SBOM_DIR, got ${row.attestationRef}`,
      );
      assert.match(
        (row.attestationRef as string).split('/').pop() ?? '',
        /^attestation-[0-9a-f-]{36}\.json$/,
        'attestation filename shape pinned',
      );
      assert.ok(existsSync(row.attestationRef as string), 'attestation file really on disk');
      const envelope = JSON.parse(readFileSync(row.attestationRef as string, 'utf8'));
      // The envelope verifies with its own embedded key, is plaintext
      // dev-only, and its subject is the row's real §40 digest.
      assert.equal(verifyDevAttestation(envelope), true, 'dev attestation verifies');
      assert.equal(
        envelope.statement.predicate.devOnly,
        true,
        'dev-only label is plaintext in the statement',
      );
      assert.equal(envelope.statement.predicate.signer, 'dev-only');
      assert.deepEqual(
        envelope.statement.subject,
        [{ name: 'build-digest', digest: { sha256: row.digest } }],
        'attestation subject is the real §40 digest',
      );
    } finally {
      s?.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('without FACTORY_ATTESTATION_KEY the record honestly keeps attestationRef null (Batch 38)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildrun-attestnone-'));
    const repo = makeRepoWithDeps();
    const dbFile = join(dir, 'factory.db');
    const workRoot = mkdtempSync(join(tmpdir(), 'buildwork-'));
    const buildCmd = `node -e "require('fs').writeFileSync('built.txt','ok')"`;
    let s: { child: ChildProcess; port: number } | null = null;
    try {
      s = await bootServer(dbFile, join(dir, 'secrets'), {
        FACTORY_BUILD_COMMAND: buildCmd,
        FACTORY_BUILD_WORK_ROOT: workRoot,
        FACTORY_BUILD_TIMEOUT_MS: '30000',
        FACTORY_BUILD_CONFIG_FILES: 'package-lock.json',
        // No FACTORY_ATTESTATION_KEY on purpose.
      });
      const { prId } = await mergeOne(s.port, repo, 'feat');
      const row = await waitForTerminal(dbFile, prId);
      assert.ok(row, 'build record reached a terminal state');
      assert.equal(row.status, 'SUCCEEDED');
      assert.equal(
        row.attestationRef,
        null,
        'no key → attestationRef null (absence, not a placeholder)',
      );
    } finally {
      s?.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a successful build with no lockfile keeps sbomRef null with the reason named', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildrun-sbomnone-'));
    const repo = makeRepoNoLockfile();
    const dbFile = join(dir, 'factory.db');
    const workRoot = mkdtempSync(join(tmpdir(), 'buildwork-'));
    const sbomDir = join(dir, 'sboms');
    let s: { child: ChildProcess; port: number } | null = null;
    try {
      s = await bootServer(dbFile, join(dir, 'secrets'), {
        FACTORY_BUILD_COMMAND: `node -e "require('fs').writeFileSync('built.txt','ok')"`,
        FACTORY_BUILD_WORK_ROOT: workRoot,
        FACTORY_BUILD_TIMEOUT_MS: '30000',
        FACTORY_SBOM_DIR: sbomDir,
      });
      const { prId } = await mergeOne(s.port, repo, 'feat');
      const row = await waitForTerminal(dbFile, prId);
      assert.ok(row, 'build record reached a terminal state');
      assert.equal(row.status, 'SUCCEEDED', 'the build still stands — SBOM absence is not failure');
      assert.equal(row.sbomRef, null, 'no lockfile → no SBOM, not invented');
      assert.ok(
        (row.sbomNote as string).includes('no lockfile') ||
          (row.sbomNote as string).includes('no parsable lockfile'),
        `gap named, got: ${row.sbomNote}`,
      );
      assert.ok(!existsSync(sbomDir), 'no SBOM directory created when there is nothing to write');
    } finally {
      s?.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });    const dir = mkdtempSync(join(tmpdir(), 'buildrun-fail-'));
    const repo = makeRepo();
    const dbFile = join(dir, 'factory.db');
    let s: { child: ChildProcess; port: number } | null = null;
    const workRoot2 = mkdtempSync(join(tmpdir(), 'buildwork-'));
    try {
      s = await bootServer(dbFile, join(dir, 'secrets'), {
        FACTORY_BUILD_COMMAND: `node -e "process.exit(3)"`,
        FACTORY_BUILD_WORK_ROOT: workRoot2,
        FACTORY_BUILD_TIMEOUT_MS: '30000',
      });
      const { prId } = await mergeOne(s.port, repo, 'feat');
      const row = await waitForTerminal(dbFile, prId);
      assert.ok(row, 'build record reached a terminal state');
      assert.equal(row.status, 'FAILED');
      assert.equal(row.exitCode, 3);
      assert.match(row.failureReason ?? '', /code 3/);
      assert.equal(row.digest, null, 'failed builds carry no digest — not invented');
    } finally {
      s?.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
      rmSync(workRoot2, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a policy-refused command is a FAILED build — it never executes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildrun-deny-'));
    const repo = makeRepo();
    const dbFile = join(dir, 'factory.db');
    let s: { child: ChildProcess; port: number } | null = null;
    const workRoot3 = mkdtempSync(join(tmpdir(), 'buildwork-'));
    try {
      s = await bootServer(dbFile, join(dir, 'secrets'), {
        FACTORY_BUILD_COMMAND: 'rm -rf /tmp/should-never-run',
        FACTORY_BUILD_WORK_ROOT: workRoot3,
        FACTORY_BUILD_TIMEOUT_MS: '30000',
      });
      const { prId } = await mergeOne(s.port, repo, 'feat');
      const row = await waitForTerminal(dbFile, prId);
      assert.ok(row, 'build record reached a terminal state');
      assert.equal(row.status, 'FAILED');
      assert.match(row.failureReason ?? '', /refused by execution policy/);
      assert.equal(row.digest, null);
    } finally {
      s?.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
      rmSync(workRoot3, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('without FACTORY_BUILD_COMMAND the record honestly stays NOT_EXECUTED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildrun-off-'));
    const repo = makeRepo();
    const dbFile = join(dir, 'factory.db');
    let s: { child: ChildProcess; port: number } | null = null;
    try {
      s = await bootServer(dbFile, join(dir, 'secrets'));
      const { prId } = await mergeOne(s.port, repo, 'feat');
      // Give the (nonexistent) runner a chance to prove it does nothing.
      await new Promise((r) => setTimeout(r, 3000));
      const fdb = new FactoryDatabase(dbFile);
      try {
        const rows = fdb.builds.listByPr(prId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'NOT_EXECUTED', 'feature off → no build, honestly recorded');
        assert.equal(rows[0].digest, null);
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

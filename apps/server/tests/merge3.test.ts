/**
 * R5-S3 merge conflict editor — HTTP integration tests (dist).
 *
 * Boots the real server (dist) with an isolated DB + data dir, builds a
 * real git repo with two UU-conflicted files in home tmp, then:
 *   conflicts -> list (UU x2) / analyze (marker hunks + diff3 chunks) /
 *   resolve drift 409 / resolve take-ours + stage / resolve take-both +
 *   custom / analyze on clean file 409 / non-git repo 404 / path escape 403.
 *
 * Run: npm run build -w @ai-factory/server && node scripts/run-tests-tmp.mjs --test apps/server/tests/merge3.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

function homeTmp(prefix: string): string {
  const base = path.join(os.homedir(), 'r5s3-shots', 'tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

async function startServer(extraRoots: string[] = []): Promise<Running> {
  const dataDir = homeTmp('aif-merge3-data-');
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dataDir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dataDir, 'data'),
    FACTORY_SECRETS_DIR: path.join(dataDir, 'secrets'),
    // The conflict repo lives outside the server cwd: allow it explicitly.
    FACTORY_INSPECT_ROOTS: [dataDir, ...extraRoots].join(path.delimiter),
    // Shadow checkpoints jail workspacePath under FACTORY_SHADOW_ROOTS.
    FACTORY_SHADOW_ROOTS: [dataDir, ...extraRoots].join(path.delimiter),
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
    await new Promise((r) => setTimeout(r, 150));
  }
  if (exited) throw new Error(`server exited during startup: ${stderr.slice(0, 400)}`);
  return { port, proc, dataDir };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

async function api(s: Running, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${s.port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

function git(repo: string, args: string[]): void {
  const r = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
}

/** Build a repo with two UU-conflicted files (a.txt, c.txt). */
function buildConflictRepo(): string {
  const dir = homeTmp('aif-merge3-repo-');
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'same\n');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'alpha\nbeta\ngamma\nmiddle\none\ntwo\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'base']);
  git(dir, ['checkout', '-qb', 'feature']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'alpha\nBETA\nGAMMA\nmiddle\none\nTWO\n');
  git(dir, ['commit', '-qam', 'theirs change']);
  git(dir, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n2\nthree\n');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'alpha\nbeta-ours\ngamma\nmiddle\none\ntwo\ndelta\n');
  git(dir, ['commit', '-qam', 'ours change']);
  const r = spawnSync('git', ['merge', 'feature'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'expected merge conflict');
  return dir;
}

test('merge3 HTTP lifecycle', async () => {
  const repo = buildConflictRepo();
  const plain = homeTmp('aif-merge3-plain-');
  const s = await startServer([repo, plain]);
  try {
    // 1. List conflicted files.
    const list = await api(s, 'GET', `/api/merge/conflicts?repo=${encodeURIComponent(repo)}`);
    assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 300));
    const files = list.body!['files'] as Array<{ path: string; status: string }>;
    assert.equal(files.length, 2);
    assert.deepEqual(
      files.map((f) => f.path).sort(),
      ['a.txt', 'c.txt'],
    );
    assert.ok(files.every((f) => f.status === 'UU'));

    // 2. Analyze a.txt: marker hunks + diff3 chunks + stages.
    const an = await api(s, 'POST', '/api/merge/analyze', { repo, file: 'a.txt' });
    assert.equal(an.status, 200, JSON.stringify(an.body).slice(0, 400));
    const hunks = an.body!['markerHunks'] as Array<Record<string, unknown>>;
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0]['ours'], ['2']);
    assert.deepEqual(hunks[0]['theirs'], ['TWO']);
    assert.deepEqual(an.body!['stages'], { base: true, ours: true, theirs: true });
    const chunks = an.body!['chunks'] as Array<{ kind: string; needsManual: boolean }>;
    assert.ok(chunks.some((c) => c.kind === 'conflict'), 'expected a conflict chunk');
    const sha = an.body!['sha256'] as string;
    assert.match(sha, /^[0-9a-f]{64}$/);

    // 3. Drift: tamper the file, resolve must 409.
    fs.appendFileSync(path.join(repo, 'a.txt'), '# tamper\n');
    const drift = await api(s, 'POST', '/api/merge/resolve', {
      repo,
      file: 'a.txt',
      sha256: sha,
      resolutions: [{ hunk: 0, choice: 'ours' }],
    });
    assert.equal(drift.status, 409);
    assert.equal((drift.body as Record<string, unknown>)['code'], 'MERGE_DRIFT');
    // Restore the conflicted state for the real resolve.
    const an2 = await api(s, 'POST', '/api/merge/analyze', { repo, file: 'a.txt' });
    assert.equal(an2.status, 200);

    // 4. Resolve a.txt: take ours + stage.
    const res = await api(s, 'POST', '/api/merge/resolve', {
      repo,
      file: 'a.txt',
      sha256: an2.body!['sha256'],
      resolutions: [{ hunk: 0, choice: 'ours' }],
      stage: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
    assert.equal(res.body!['resolved'], true);
    assert.equal(res.body!['staged'], true);
    assert.ok((res.body!['checkpointId'] as string).length > 0);
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'one\n2\nthree\n# tamper\n');

    // 5. a.txt no longer conflicted.
    const list2 = await api(s, 'GET', `/api/merge/conflicts?repo=${encodeURIComponent(repo)}`);
    assert.equal((list2.body!['files'] as unknown[]).length, 1);

    // 6. Resolve c.txt: take both (single hunk: ours then theirs).
    const anC = await api(s, 'POST', '/api/merge/analyze', { repo, file: 'c.txt' });
    assert.equal(anC.status, 200);
    const hunksC = anC.body!['markerHunks'] as Array<Record<string, unknown>>;
    assert.equal(hunksC.length, 1);
    const resC = await api(s, 'POST', '/api/merge/resolve', {
      repo,
      file: 'c.txt',
      sha256: anC.body!['sha256'],
      resolutions: [{ hunk: 0, choice: 'both' }],
    });
    assert.equal(resC.status, 200, JSON.stringify(resC.body).slice(0, 400));
    const content = fs.readFileSync(path.join(repo, 'c.txt'), 'utf8');
    assert.equal(
      content,
      'alpha\nbeta-ours\ngamma\nmiddle\none\ntwo\ndelta\nBETA\nGAMMA\nmiddle\none\nTWO\n',
      `both should concat ours+theirs, got: ${JSON.stringify(content)}`,
    );

    // 7. Re-create the conflict and resolve with custom text.
    const redo = spawnSync('git', ['checkout', '-m', '--', 'c.txt'], { cwd: repo, encoding: 'utf8' });
    assert.equal(redo.status, 0, redo.stderr);
    const anC2 = await api(s, 'POST', '/api/merge/analyze', { repo, file: 'c.txt' });
    assert.equal(anC2.status, 200);
    const resC2 = await api(s, 'POST', '/api/merge/resolve', {
      repo,
      file: 'c.txt',
      sha256: anC2.body!['sha256'],
      resolutions: [{ hunk: 0, choice: 'custom', customText: 'HAND\nMADE' }],
    });
    assert.equal(resC2.status, 200, JSON.stringify(resC2.body).slice(0, 400));
    const content2 = fs.readFileSync(path.join(repo, 'c.txt'), 'utf8');
    assert.equal(content2, 'alpha\nHAND\nMADE\n');
    assert.ok(!content2.includes('<<<<<<<'), 'markers must be gone');

    // 8. Analyze on a clean file -> 409 NO_CONFLICT_MARKERS.
    const clean = await api(s, 'POST', '/api/merge/analyze', { repo, file: 'b.txt' });
    assert.equal(clean.status, 409);
    assert.equal((clean.body as Record<string, unknown>)['code'], 'NO_CONFLICT_MARKERS');

    // 9. Non-git repo -> 404.
    const ng = await api(s, 'GET', `/api/merge/conflicts?repo=${encodeURIComponent(plain)}`);
    assert.equal(ng.status, 404);
    assert.equal((ng.body as Record<string, unknown>)['code'], 'not-a-git-repo');

    // 10. Path escape -> 403.
    const evil = await api(s, 'POST', '/api/merge/analyze', { repo, file: '../evil.txt' });
    assert.equal(evil.status, 403);
  } finally {
    await stopServer(s);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

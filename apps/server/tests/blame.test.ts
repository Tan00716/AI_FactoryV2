/**
 * R5-A4 blame + timeline — HTTP integration tests (dist).
 *
 * Boots the real server (dist) with an isolated DB + data dir, then against
 * a REAL git repository (init/commit/uncommitted change created in the test):
 *   blame          -> per-line blame, uncommitted line marked
 *   timeline       -> fused git log x local-history snapshots
 *   timeline/diff  -> unified diff work vs git, snapshot vs snapshot
 *   non-repo dir   -> blame 409 NOT_A_GIT_REPO; timeline noGit:true
 *   path escape    -> 403; missing path -> 400
 *
 * Run: npm run build -w @ai-factory/server && node scripts/run-tests-tmp.mjs --test apps/server/tests/blame.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotOnSave } from '../src/local-history.ts';

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

/** Home-based temp root (the /tmp hygiene rule: /tmp is a 512MB tmpfs). */
function homeTmp(prefix: string): string {
  const base = path.join(os.homedir(), 'r5a4-shots', 'tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

async function startServer(extraRoots: string[]): Promise<Running> {
  const dataDir = homeTmp('aif-blame-data-');
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dataDir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dataDir, 'data'),
    FACTORY_SECRETS_DIR: path.join(dataDir, 'secrets'),
    FACTORY_INSPECT_ROOTS: [dataDir, ...extraRoots].join(path.delimiter),
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

async function api(s: Running, p: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${s.port}${p}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/**
 * R5 closeout: stop the server and WAIT for exit before removing its data
 * dir. The old t.after did kill('SIGTERM') + immediate rmSync, which raced
 * the still-running server's open DB files (flaky ENOTEMPTY in the full
 * suite). SIGKILL fallback after 10s keeps a hung server from wedging CI.
 */
async function stopServer(s: Running, ...dirs: string[]): Promise<void> {
  if (s.proc.exitCode === null) {
    s.proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (s.proc.exitCode !== null) return resolve();
      const to = setTimeout(() => {
        try { s.proc.kill('SIGKILL'); } catch { /* already gone */ }
        resolve();
      }, 10_000);
      s.proc.once('exit', () => { clearTimeout(to); resolve(); });
    });
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

function git(repo: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd: repo,
    stdio: 'pipe',
  });
}

/** Build a real git repo: 2 commits + one uncommitted trailing line. */
function makeRepo(): { repo: string; hash1: string } {
  const repo = homeTmp('aif-blame-repo-');
  git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'line1\nline2\n');
  git(repo, ['add', 'file.txt']);
  git(repo, ['commit', '-q', '-m', 'first commit']);
  const hash1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  fs.appendFileSync(path.join(repo, 'file.txt'), 'line3-uncommitted\n');
  return { repo, hash1 };
}

test('blame returns per-line blame with uncommitted marking', async (t) => {
  const { repo, hash1 } = makeRepo();
  const s = await startServer([repo]);
  t.after(() => stopServer(s, s.dataDir, repo));
  const q = `/api/blame?path=file.txt&root=${encodeURIComponent(repo)}`;
  const { status, body } = await api(s, q);
  assert.equal(status, 200);
  const b = body as { lines: Array<{ line: number; hash: string; author: string; uncommitted: boolean }>; truncated: boolean };
  assert.equal(b.truncated, false);
  assert.equal(b.lines.length, 3);
  assert.equal(b.lines[0].uncommitted, false);
  assert.equal(b.lines[0].hash, hash1);
  assert.equal(b.lines[0].author, 'Test');
  assert.equal(b.lines[1].uncommitted, false);
  const u = b.lines[2];
  assert.equal(u.uncommitted, true);
  assert.equal(u.author, 'uncommitted');
  assert.ok(u.hash.startsWith('0000000'));
});

test('timeline fuses git log and local-history snapshots', async (t) => {
  const { repo } = makeRepo();
  const s = await startServer([repo]);
  t.after(() => stopServer(s, s.dataDir, repo));
  // Record a local-history snapshot through the real helper (data dir = server's).
  process.env.AI_FACTORY_DATA_DIR = path.join(s.dataDir, 'data');
  const rec = snapshotOnSave(repo, 'file.txt', 'line1\nline2\nline3-uncommitted\n', 'save');
  assert.equal(rec.status, 'ok');
  assert.ok(rec.id);

  const q = `/api/timeline?path=file.txt&root=${encodeURIComponent(repo)}`;
  const { status, body } = await api(s, q);
  assert.equal(status, 200);
  const tl = body as { noGit: boolean; entries: Array<{ kind: string }> };
  assert.equal(tl.noGit, false);
  const kinds = tl.entries.map((e) => e.kind);
  assert.ok(kinds.includes('git'), 'git entry present');
  assert.ok(kinds.includes('snapshot'), 'snapshot entry present');
});

test('timeline/diff shows work-vs-git changes', async (t) => {
  const { repo, hash1 } = makeRepo();
  const s = await startServer([repo]);
  t.after(() => stopServer(s, s.dataDir, repo));
  const q =
    `/api/timeline/diff?path=file.txt&root=${encodeURIComponent(repo)}` +
    `&from=work&to=git:${hash1}`;
  const { status, body } = await api(s, q);
  assert.equal(status, 200);
  const d = body as { diff: string; from: string; to: string };
  assert.ok(d.diff.includes('-line3-uncommitted') || d.diff.includes('+line3-uncommitted'));
  assert.ok(d.diff.startsWith('--- '));
});

test('non-git directory: blame 409, timeline snapshots-only', async (t) => {
  const plain = homeTmp('aif-blame-plain-');
  fs.writeFileSync(path.join(plain, 'note.txt'), 'hello\n');
  const s = await startServer([plain]);
  t.after(() => stopServer(s, s.dataDir, plain));
  const root = encodeURIComponent(plain);
  const b = await api(s, `/api/blame?path=note.txt&root=${root}`);
  assert.equal(b.status, 409);
  assert.equal((b.body as { code: string }).code, 'NOT_A_GIT_REPO');
  const tl = await api(s, `/api/timeline?path=note.txt&root=${root}`);
  assert.equal(tl.status, 200);
  assert.equal((tl.body as { noGit: boolean }).noGit, true);
});

test('jail: path escape is 403, missing path is 400', async (t) => {
  const { repo } = makeRepo();
  const s = await startServer([repo]);
  t.after(() => stopServer(s, s.dataDir, repo));
  const root = encodeURIComponent(repo);
  const esc = await api(s, `/api/blame?path=../escape.txt&root=${root}`);
  assert.equal(esc.status, 403);
  const missing = await api(s, `/api/blame?root=${root}`);
  assert.equal(missing.status, 400);
});

/**
 * R5-A5 Trojan Source protection — HTTP integration tests (dist).
 *
 * Boots the real server (dist) with an isolated DB + data dir and
 * FACTORY_INSPECT_ROOTS pointed at a fixture repo, then:
 *   POST /api/trojan/scan {text}  → inline Trojan sample → bidi error hit
 *   POST /api/trojan/scan {path}  → jailed fixture file scan
 *   POST /api/trojan/scan {path:'../x'} → 403 (jail)
 *   POST /api/trojan/scan {text: clean} → zero findings
 * Plus a direct unit check of trojanCheckerProvider (inspection wiring).
 *
 * Run: npm run build -w @ai-factory/server && node scripts/run-tests-tmp.mjs --test apps/server/tests/trojanscan.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trojanCheckerProvider, TROJAN_CHECKER_NAME } from '../dist/routes/trojanscan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

// Classic Trojan Source shape: RLO override hiding code in a comment,
// plus a Cyrillic lookalike identifier.
const EVIL_JS = [
  'function isAdmin(user) {',
  '  // \u2066if (user.admin) return true;\u2069 \u2066',
  '  if (user.name === "admin\u202e") { return true; }',
  '  const p\u0430ssword = readSecret();',
  '  return false;',
  '}',
  '',
].join('\n');

interface Running {
  port: number;
  proc: ChildProcess;
  dataDir: string;
  repoDir: string;
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
  const base = path.join(os.homedir(), 'r5a5-shots', 'tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

function makeRepo(): string {
  const dir = homeTmp('aif-trojan-repo-');
  fs.writeFileSync(path.join(dir, 'evil.js'), EVIL_JS, 'utf8');
  fs.writeFileSync(path.join(dir, 'clean.js'), 'const a = 1;\n// plain\n', 'utf8');
  return dir;
}

async function startServer(): Promise<Running> {
  const dataDir = homeTmp('aif-trojan-data-');
  const repoDir = makeRepo();
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dataDir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dataDir, 'data'),
    FACTORY_SECRETS_DIR: path.join(dataDir, 'secrets'),
    FACTORY_INSPECT_ROOTS: repoDir,
  };
  for (const k of ['FACTORY_API_TOKEN', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    cwd: repoDir,
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
  return { port, proc, dataDir, repoDir };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.dataDir, { recursive: true, force: true });
  fs.rmSync(s.repoDir, { recursive: true, force: true });
}

async function api(s: Running, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${s.port}/api/trojan/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('trojan HTTP: inline scan hits bidi override as error', async () => {
  const s = await startServer();
  try {
    const r = await api(s, { text: EVIL_JS, filename: 'evil.js' });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    const findings = r.body.findings as Array<Record<string, unknown>>;
    assert.ok(findings.length >= 3, `expected >=3 findings, got ${findings.length}`);
    const cps = findings.map((f) => f['codePoint']);
    assert.ok(cps.includes('U+202E'), `RLO missing: ${cps.join(',')}`);
    assert.ok(cps.includes('U+2066'), `LRI missing: ${cps.join(',')}`);
    assert.ok(cps.includes('U+0430'), `Cyrillic-a missing: ${cps.join(',')}`);
    const rlo = findings.find((f) => f['codePoint'] === 'U+202E');
    assert.equal(rlo?.['severity'], 'error');
    assert.equal(rlo?.['kind'], 'bidi-control');
    const conf = findings.find((f) => f['codePoint'] === 'U+0430');
    assert.equal(conf?.['kind'], 'confusable');
    assert.ok(String(rlo?.['message']).includes('U+202E'));
  } finally {
    await stopServer(s);
  }
});

test('trojan HTTP: path scan (jailed) and jail escape refused', async () => {
  const s = await startServer();
  try {
    const r = await api(s, { path: 'evil.js' });
    assert.equal(r.status, 200);
    assert.ok((r.body.findings as unknown[]).length >= 3);
    const clean = await api(s, { path: 'clean.js' });
    assert.equal(clean.status, 200);
    assert.equal((clean.body.findings as unknown[]).length, 0);
    const escape = await api(s, { path: '../outside.js' });
    assert.equal(escape.status, 403);
    const missing = await api(s, { path: 'nope.js' });
    assert.equal(missing.status, 404);
  } finally {
    await stopServer(s);
  }
});

test('trojan HTTP: clean inline text yields zero findings', async () => {
  const s = await startServer();
  try {
    const r = await api(s, { text: 'const a = 1;\n// hello\n', filename: 'ok.js' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.findings, []);
  } finally {
    await stopServer(s);
  }
});

test('trojanCheckerProvider: inspection checker shape and findings', () => {
  const [checker] = trojanCheckerProvider('/tmp');
  assert.equal(checker.name, TROJAN_CHECKER_NAME);
  assert.ok(checker.description.length > 0);
  const findings = checker.run({ file: 'evil.js', lines: EVIL_JS.split('\n') });
  assert.ok(findings.length >= 3);
  assert.ok(findings.every((f) => f.checker === TROJAN_CHECKER_NAME));
  assert.ok(findings.every((f) => f.file === 'evil.js'));
  assert.ok(findings.every((f) => typeof f.id === 'string' && f.id.length === 12));
  const clean = checker.run({ file: 'clean.js', lines: ['const a = 1;'] });
  assert.deepEqual(clean, []);
});

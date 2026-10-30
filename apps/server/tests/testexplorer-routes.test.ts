/**
 * Test explorer HTTP tests — boots the real server (dist) with an
 * isolated DB and exercises the whole feature end to end:
 *
 *   GET  /api/testexplorer/discover   tree with fullName chains
 *   POST /api/testexplorer/run        case / file / package scopes
 *   POST /api/testexplorer/rerun-failed failed cases only
 *   errors: outside allowlist 403, unknown file 404, bad scope 400,
 *           syntax-error file surfaces runError, not invented cases
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/testexplorer-routes.test.ts
 * (requires a server build first — the server boots from dist).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
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
  dir: string;
  proj: string;
}

const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) {
    try {
      p.kill('SIGKILL');
    } catch {
      // already dead
    }
  }
});

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
      const port = (addr as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-tx-http-'));
  const proj = path.join(dir, 'proj');
  const pkgDir = path.join(proj, 'mypkg');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'mypkg' }));
  fs.writeFileSync(path.join(pkgDir, 'a.test.mjs'), [
    "import { test, describe } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "describe('math', () => {",
    "  test('adds', () => { assert.equal(1 + 1, 2); });",
    "  test('fails here', () => { assert.equal(1, 2); });",
    "  test.skip('skipped one', () => {});",
    "});",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(pkgDir, 'bad.test.mjs'), 'test(\n');
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_CODEINDEX_ROOTS: proj,
    FACTORY_ALLOW_OPEN_LOCAL: '1',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: 'ignore' });
  procs.push(proc);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('server did not come up');
    await new Promise((r) => setTimeout(r, 200));
  }
  return { port, proc, dir, proj };
}

async function req(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, any>;
  return { status: r.status, json };
}

test('discover returns the package > file > case tree', async () => {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  try {
    const { status, json } = await req(base, 'GET', `/api/testexplorer/discover?root=${encodeURIComponent(s.proj)}`);
    assert.equal(status, 200);
    assert.equal(json.totals.files, 2);
    assert.equal(json.totals.cases, 3);
    const pkg = (json.packages as Array<Record<string, any>>).find((p) => p['name'] === 'mypkg');
    assert.ok(pkg);
    const file = (pkg['files'] as Array<Record<string, any>>).find((f) => (f['rel'] as string).endsWith('a.test.mjs'));
    assert.deepEqual((file?.['cases'] as Array<Record<string, unknown>>).map((c) => c['fullName']), [
      'math > adds',
      'math > fails here',
      'math > skipped one',
    ]);
  } finally {
    s.proc.kill('SIGKILL');
  }
});

test('run case / file / package scopes and rerun-failed', async () => {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  try {
    const rel = 'mypkg/a.test.mjs';
    const single = await req(base, 'POST', '/api/testexplorer/run', {
      root: s.proj,
      scope: { kind: 'case', file: rel, name: 'adds' },
    });
    assert.equal(single.status, 200);
    assert.deepEqual(single.json.results.map((r: Record<string, unknown>) => r['fullName']), ['math > adds']);
    assert.equal(single.json.results[0]['status'], 'pass');

    const fileRun = await req(base, 'POST', '/api/testexplorer/run', {
      root: s.proj,
      scope: { kind: 'file', file: rel },
    });
    assert.equal(fileRun.status, 200);
    assert.equal(fileRun.json.summary.pass, 1);
    assert.equal(fileRun.json.summary.fail, 1);
    assert.equal(fileRun.json.summary.skip, 1);
    assert.equal(fileRun.json.summary.total, 3);

    const rerun = await req(base, 'POST', '/api/testexplorer/rerun-failed', { root: s.proj });
    assert.equal(rerun.status, 200);
    assert.equal(rerun.json.reran, 1);
    assert.deepEqual(rerun.json.results.map((r: Record<string, unknown>) => r['fullName']), ['math > fails here']);
    assert.equal(rerun.json.results[0]['status'], 'fail');

    const pkgRun = await req(base, 'POST', '/api/testexplorer/run', {
      root: s.proj,
      scope: { kind: 'package', package: 'mypkg' },
    });
    assert.equal(pkgRun.status, 200);
    // a.test.mjs (3 cases) + bad.test.mjs (load failure, no cases)
    assert.equal(pkgRun.json.summary.total, 3);
    assert.match(pkgRun.json.runError as string, /bad\.test\.mjs/);
  } finally {
    s.proc.kill('SIGKILL');
  }
});

test('errors: outside allowlist 403, unknown file 404, bad scope 400, no failed run 409', async () => {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  try {
    const outside = await req(base, 'GET', `/api/testexplorer/discover?root=${encodeURIComponent(os.tmpdir())}`);
    assert.equal(outside.status, 403);
    const unknown = await req(base, 'POST', '/api/testexplorer/run', {
      root: s.proj,
      scope: { kind: 'file', file: 'mypkg/nope.test.mjs' },
    });
    assert.equal(unknown.status, 404);
    const bad = await req(base, 'POST', '/api/testexplorer/run', {
      root: s.proj,
      scope: { kind: 'bogus' },
    });
    assert.equal(bad.status, 400);
    const noFailed = await req(base, 'POST', '/api/testexplorer/rerun-failed', { root: s.proj });
    assert.equal(noFailed.status, 409);
  } finally {
    s.proc.kill('SIGKILL');
  }
});

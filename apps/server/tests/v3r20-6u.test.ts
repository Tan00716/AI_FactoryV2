/**
 * V3R20 #6(u) — content-service walker canonical control-dir exclusion.
 *
 * Two regression tests (test:server count):
 *   1. codesearch: a renamed vault dir (FACTORY_SECRETS_DIR) and the
 *      default-layout data dir (dirname(DB_PATH)) are both unsearchable,
 *      while a legit file still is; a root that IS a control dir
 *      searches nothing (fail-closed).
 *   2. codeindex (real server, viewer search path): the vault files
 *      are never indexed (stats.files counts only the legit file) and
 *      text search returns 0 vault hits even with context; a STALE
 *      on-disk index forged to contain vault records is still filtered
 *      at query time after a server restart.
 *
 * Markers are test-only strings, not real secrets. Assertions compare
 * structured fields (file lists, hit counts), never whole-text
 * substrings — the ambient test env may legally contain credential
 * names in unrelated variables.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/v3r20-6u.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIndex, saveIndex } from '@ai-factory/codeindex';
import {
  handleCodeSearchRoutes,
  setCodeSearchRootResolver,
} from '../src/routes/codesearch.ts';
import type { RouteContext } from '../src/routes/context.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');
const TOKEN = 'r20-6u-probe-token-1234567890';

// ---------------------------------------------------------------- codesearch

const CS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'v3r20-6u-codesearch-'));
const MARKER = 'R20U6U-MARKER-9876';
fs.mkdirSync(path.join(CS_ROOT, 'secure-vault'), { recursive: true });
fs.mkdirSync(path.join(CS_ROOT, 'data', 'secrets'), { recursive: true });
fs.writeFileSync(path.join(CS_ROOT, 'secure-vault', 'vault.key'), `key = ${MARKER}\n`);
fs.writeFileSync(path.join(CS_ROOT, 'secure-vault', 'vault.json'), `{"data": "${MARKER}"}\n`);
fs.writeFileSync(path.join(CS_ROOT, 'data', 'secrets', 'vault.json'), `{"data": "${MARKER}"}\n`);
fs.writeFileSync(
  path.join(CS_ROOT, 'visible.ts'),
  `export const x = '${MARKER}';\n// ${MARKER} visible\n`,
);
setCodeSearchRootResolver(() => CS_ROOT);

function mockCtx(body: unknown): { ctx: RouteContext; calls: Array<{ code: number; body: unknown }> } {
  const calls: Array<{ code: number; body: unknown }> = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body as Record<string, unknown>,
    audit: { record: () => undefined },
  } as unknown as RouteContext;
  return { ctx, calls };
}

async function runCodeSearch(method: string, p: string, body: unknown) {
  const { ctx, calls } = mockCtx(body);
  const handled = await handleCodeSearchRoutes(
    { method } as never,
    {} as never,
    new URL(`http://127.0.0.1${p}`),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0];
}

test('codesearch excludes renamed vault + default data dir, legit search works', async () => {
  // Control: both vault files really exist on disk with the marker —
  // the exclusion below must be the canonical control-dir derivation,
  // not missing content.
  assert.ok(fs.readFileSync(path.join(CS_ROOT, 'secure-vault', 'vault.key'), 'utf8').includes(MARKER));
  assert.ok(fs.readFileSync(path.join(CS_ROOT, 'data', 'secrets', 'vault.json'), 'utf8').includes(MARKER));

  // FACTORY_SECRETS_DIR covers the renamed vault dir; DB_PATH covers
  // the default-layout data dir (dirname(DB_PATH) = CS_ROOT/data).
  const prevSecrets = process.env.FACTORY_SECRETS_DIR;
  const prevDb = process.env.DB_PATH;
  process.env.FACTORY_SECRETS_DIR = path.join(CS_ROOT, 'secure-vault');
  process.env.DB_PATH = path.join(CS_ROOT, 'data', 'factory.db');
  try {
    const { code, body } = await runCodeSearch('POST', '/api/codesearch/search', { query: MARKER });
    assert.equal(code, 200);
    const b = body as { totalMatches: number; groups: Array<{ file: string }> };
    // Only the legit file is returned; both vault dirs contribute zero.
    assert.deepEqual(b.groups.map((g) => g.file), ['visible.ts']);
    assert.equal(b.totalMatches, 2);

    // Fail-closed: a root that IS a control dir searches nothing.
    setCodeSearchRootResolver(() => path.join(CS_ROOT, 'secure-vault'));
    try {
      const root = await runCodeSearch('POST', '/api/codesearch/search', { query: MARKER });
      assert.equal(root.code, 200);
      const rb = root.body as { totalMatches: number; groups: unknown[] };
      assert.deepEqual(rb.groups, []);
      assert.equal(rb.totalMatches, 0);
    } finally {
      setCodeSearchRootResolver(() => CS_ROOT);
    }
  } finally {
    if (prevSecrets === undefined) delete process.env.FACTORY_SECRETS_DIR;
    else process.env.FACTORY_SECRETS_DIR = prevSecrets;
    if (prevDb === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDb;
  }
});

// ---------------------------------------------------------------- codeindex

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

async function startServer(proj: string, dir: string): Promise<{ port: number; proc: ChildProcess }> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    // Default-layout leg: the checked root IS the server workspace, so
    // DB_PATH points inside it and proj/data is the control dir.
    DB_PATH: path.join(proj, 'data', 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_CODEINDEX_ROOTS: proj,
    // Custom-dir leg: the renamed vault dir.
    FACTORY_SECRETS_DIR: path.join(proj, 'secure-vault'),
    FACTORY_API_TOKEN: TOKEN,
    FACTORY_ALLOW_OPEN_LOCAL: '1',
  };
  for (const k of ['FACTORY_RUNTIME_TOOLS', 'JARVIS_TRACE_CONTEXT', 'JARVIS_RUNTIME_CONTEXT_TOKEN']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 20_000;
  let exited = false;
  proc.once('exit', () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) throw new Error('server exited during startup');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (exited) throw new Error('server exited during startup');
  return { port, proc };
}

async function api(port: number, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('codeindex viewer search excludes vault; stale on-disk index still filtered', { timeout: 120_000 }, async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'v3r20-6u-codeindex-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3r20-6u-ciserver-'));
  // No .gitignore on purpose: the default layout must NOT depend on
  // the repo's `data/` ignore entry (R20 N3 — that was accidental).
  fs.mkdirSync(path.join(proj, 'data', 'secrets'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'secure-vault'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'data', 'secrets', 'vault.json'),
    '{\n  "data": "UjIwQTJEQVRBLU1BUktFUi0xYzJkM2U0ZjVhNmI3YzhkOWUwZjEwMjAzMDQwNTA2MDcwODA5MGEwYg=="\n}\n',
  );
  fs.writeFileSync(path.join(proj, 'secure-vault', 'vault.key'), 'UjIwQTJLRVktTUFSS0VSLTc0YjkxYzZkM2I1YTg=\n');
  fs.writeFileSync(path.join(proj, 'hello.txt'), "export const hello = 'HELLO6U';\n// hello world\n");
  const cacheDir = path.join(dir, 'data', 'codeindex');
  const realProj = fs.realpathSync(proj);

  let s = await startServer(proj, dir);
  try {
    const built = await api(s.port, 'POST', '/api/codeindex/index', { root: proj });
    assert.equal(built.status, 200, JSON.stringify(built.body));
    // Only the legit file is indexed; both vault files are pruned at walk.
    assert.equal(built.body.stats.files, 1, JSON.stringify(built.body.stats));

    // Viewer text search: no vault hit, even with context attached.
    const byData = await api(s.port, 'GET', `/api/codeindex/search?root=${encodeURIComponent(proj)}&q=data&mode=text&context=2`);
    assert.equal(byData.status, 200, JSON.stringify(byData.body));
    assert.deepEqual(byData.body.hits, []);
    const byKey = await api(s.port, 'GET', `/api/codeindex/search?root=${encodeURIComponent(proj)}&q=key&mode=text`);
    assert.equal(byKey.status, 200, JSON.stringify(byKey.body));
    assert.deepEqual(byKey.body.hits, []);
    // Legit search still works.
    const byHello = await api(s.port, 'GET', `/api/codeindex/search?root=${encodeURIComponent(proj)}&q=hello&mode=text`);
    assert.equal(byHello.status, 200, JSON.stringify(byHello.body));
    assert.ok(
      (byHello.body.hits as Array<{ file: string }>).some((h) => h.file === 'hello.txt'),
      JSON.stringify(byHello.body.hits),
    );

    // Forge a STALE on-disk index that still contains vault records
    // (as if built before the (u) exclusion landed), then restart so
    // the server loads it from disk with an empty in-memory registry.
    const stale = await loadIndex(cacheDir, realProj);
    assert.ok(stale, 'fresh on-disk index must exist');
    assert.equal(stale.files.length, 1);
    assert.equal(stale.files[0].rel, 'hello.txt');
    stale.files.push(
      { rel: 'data/secrets/vault.json', mtimeMs: Date.now(), size: 200, symbols: [], tokens: { data: 5 } },
      { rel: 'secure-vault/vault.key', mtimeMs: Date.now(), size: 44, symbols: [], tokens: { key: 1 } },
    );
    stale.inverted['data'] = [[1, 5]];
    stale.inverted['key'] = [[2, 1]];
    await saveIndex(cacheDir, stale);

    s.proc.kill('SIGTERM');
    await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
    s = await startServer(proj, dir);

    // The stale vault records must still not be served (query-time filter).
    const staleData = await api(s.port, 'GET', `/api/codeindex/search?root=${encodeURIComponent(proj)}&q=data&mode=text&context=2`);
    assert.equal(staleData.status, 200, JSON.stringify(staleData.body));
    assert.deepEqual(staleData.body.hits, []);
    const staleKey = await api(s.port, 'GET', `/api/codeindex/search?root=${encodeURIComponent(proj)}&q=key&mode=text`);
    assert.equal(staleKey.status, 200, JSON.stringify(staleKey.body));
    assert.deepEqual(staleKey.body.hits, []);
    // And the legit record still survives the filter.
    const staleHello = await api(s.port, 'GET', `/api/codeindex/search?root=${encodeURIComponent(proj)}&q=hello&mode=text`);
    assert.equal(staleHello.status, 200, JSON.stringify(staleHello.body));
    assert.ok(
      (staleHello.body.hits as Array<{ file: string }>).some((h) => h.file === 'hello.txt'),
      JSON.stringify(staleHello.body.hits),
    );
  } finally {
    s.proc.kill('SIGTERM');
    await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(CS_ROOT, { recursive: true, force: true });
  }
});

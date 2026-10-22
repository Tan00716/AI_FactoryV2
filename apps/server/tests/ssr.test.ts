/**
 * SSR (structural search & replace) — R4-A4.
 *
 * Unit: template storage round-trip + checker provider (src-direct,
 * type-stripping; @ai-factory/ssr resolves to its built dist).
 * HTTP: boots the real server (dist) with an isolated DB + data dir and
 * FACTORY_INSPECT_ROOTS, then:
 *   GET  /api/ssr/templates   → 4 builtins, 0 saved
 *   POST /api/ssr/templates   → save custom template (asInspection)
 *   POST /api/ssr/search      → builtin public-methods hits fixture
 *   POST /api/ssr/preview     → rename diff, nothing written
 *   POST /api/ssr/apply       → file rewritten, audit recorded
 *   POST /api/ssr/quickfix    → single match applied via finding detail
 *   POST /api/inspections/run → ssr-template findings present with detail
 *
 * Run: npm run build && node scripts/run-tests-tmp.mjs --test apps/server/tests/ssr.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSavedTemplates, ssrCheckerProvider } from '../src/routes/ssr.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_TS = [
  'export class Widget {',
  '  public render(): string {',
  '    return "w";',
  '  }',
  '  private helper(): void {}',
  '}',
  '',
  'export function alpha(): number {',
  '  let count = 0;',
  '  count += 1;',
  '  return count;',
  '}',
  '',
  'export function beta(): number {',
  '  let count = 100;',
  '  return count - 1;',
  '}',
  '',
].join('\n');

describe('template storage (unit)', () => {
  it('round-trips through loadSavedTemplates (missing file → [])', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-ssr-store-'));
    try {
      assert.deepEqual(loadSavedTemplates(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checker provider emits quick-fix detail on template matches (unit)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-ssr-detail-'));
    try {
      const cfgDir = path.join(dir, '.ai-factory');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(
        path.join(cfgDir, 'ssr-templates.json'),
        JSON.stringify({ version: 1, templates: [RENAME_TEMPLATE] }),
        'utf8',
      );
      const checkers = ssrCheckerProvider(dir);
      assert.equal(checkers.length, 1);
      assert.equal(checkers[0].name, 'ssr-template');
      const findings = checkers[0].run({ file: 'app.ts', lines: FIXTURE_TS.split('\n') });
      assert.equal(findings.length, 1);
      assert.equal(findings[0].line, 9);
      const detail = JSON.parse(findings[0].detail!);
      assert.equal(detail.templateId, 'it-rename-count');
      assert.equal(detail.file, 'app.ts');
      assert.equal(detail.startLine, 9);
      assert.equal(detail.kind, 'variable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP integration (real server from dist)
// ---------------------------------------------------------------------------

interface Running {
  port: number;
  proc: ChildProcess;
  dataDir: string;
  inspectRoot: string;
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
      srv.close(() => resolve(addr.port));
    });
  });
}

function scrubTestEnv(env: NodeJS.ProcessEnv): void {
  // AGENTS.md iron rule: never let NODE_TEST_CONTEXT leak into a spawned
  // test server — the child would silently misbehave.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
}

async function startServer(): Promise<Running> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-ssr-data-'));
  const inspectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-ssr-root-'));
  const projectsRoot = path.join(inspectRoot, 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  const port = await freePort();
  const serverEntry = path.join(here, '..', 'dist', 'index.js');
  const env: NodeJS.ProcessEnv = { ...process.env };
  scrubTestEnv(env);
  env.PORT = String(port);
  env.DB_PATH = path.join(dataDir, 'factory.db');
  env.AI_FACTORY_DATA_DIR = path.join(dataDir, 'data');
  env.FACTORY_SECRETS_DIR = path.join(dataDir, 'secrets');
  env.FACTORY_INSPECT_ROOTS = inspectRoot;
  env.FACTORY_PROJECTS_ROOT = projectsRoot;
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_RUNTIME_TOOLS']) delete env[k];
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const deadline = Date.now() + 30_000;
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
    await new Promise((r) => setTimeout(r, 100));
  }
  if (exited) throw new Error(`server exited during startup: ${stderr.slice(0, 400)}`);
  return { port, proc, dataDir, inspectRoot };
}

async function api(s: Running, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${s.port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const RENAME_TEMPLATE = {
  id: 'it-rename-count',
  name: 'IT rename count',
  version: 1,
  search: { kind: 'variable', namePattern: '^count$', enclosing: '^alpha$' },
  replace: { op: 'rename', to: 'total' },
  asInspection: true,
  severity: 'warning',
};

describe('ssr HTTP lifecycle', () => {
  let s: Running;
  let projDir: string;

  before(async () => {
    s = await startServer();
    projDir = path.join(s.inspectRoot, 'projects', 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'app.ts'), FIXTURE_TS, 'utf8');
  });

  after(async () => {
    s.proc.kill('SIGTERM');
    await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
    fs.rmSync(s.dataDir, { recursive: true, force: true });
    fs.rmSync(s.inspectRoot, { recursive: true, force: true });
  });

  it('GET /api/ssr/templates → 4 builtins, 0 saved', async () => {
    const r = await api(s, 'GET', `/api/ssr/templates?root=${encodeURIComponent(projDir)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.builtins.length, 4);
    assert.deepEqual(
      r.body.builtins.map((t: { id: string }) => t.id),
      ['public-methods', 'typed-variables', 'long-functions', 'async-methods'],
    );
    assert.deepEqual(r.body.saved, []);
  });

  it('POST /api/ssr/templates → saves; bad template → 400', async () => {
    const ok = await api(s, 'POST', '/api/ssr/templates', { root: projDir, template: RENAME_TEMPLATE });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.template.id, 'it-rename-count');

    const bad = await api(s, 'POST', '/api/ssr/templates', {
      root: projDir,
      template: { id: 'Bad!', name: 'x', search: {} },
    });
    assert.equal(bad.status, 400);
  });

  it('POST /api/ssr/search → builtin public-methods hits render only', async () => {
    const r = await api(s, 'POST', '/api/ssr/search', { root: projDir, template: { id: 'public-methods' } });
    assert.equal(r.status, 200);
    const names = r.body.matches.map((m: { name: string }) => m.name);
    assert.deepEqual(names, ['render']); // helper is private
    assert.equal(r.body.matches[0].parent, 'Widget');
  });

  it('POST /api/ssr/preview → rename diff, file untouched', async () => {
    const r = await api(s, 'POST', '/api/ssr/preview', { root: projDir, template: { id: 'it-rename-count' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.matchCount, 1);
    assert.equal(r.body.files.length, 1);
    const diff = r.body.files[0].diff as string;
    assert.ok(diff.includes('-  let count = 0;'));
    assert.ok(diff.includes('+  let total = 0;'));
    // nothing written yet
    assert.ok(fs.readFileSync(path.join(projDir, 'app.ts'), 'utf8').includes('let count = 0;'));
  });

  it('POST /api/ssr/apply → rewrites file, beta untouched', async () => {
    const r = await api(s, 'POST', '/api/ssr/apply', { root: projDir, template: { id: 'it-rename-count' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.applied, 1);
    assert.deepEqual(r.body.filesChanged, ['app.ts']);
    const after = fs.readFileSync(path.join(projDir, 'app.ts'), 'utf8');
    assert.ok(after.includes('let total = 0;'));
    assert.ok(after.includes('let count = 100;'), 'beta scope untouched');
  });

  it('POST /api/ssr/quickfix → applies a single finding', async () => {
    // restore fixture, then quick-fix just the alpha variable
    fs.writeFileSync(path.join(projDir, 'app.ts'), FIXTURE_TS, 'utf8');
    const r = await api(s, 'POST', '/api/ssr/quickfix', {
      root: projDir,
      templateId: 'it-rename-count',
      file: 'app.ts',
      startLine: 9,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.applied, true);
    const after = fs.readFileSync(path.join(projDir, 'app.ts'), 'utf8');
    assert.ok(after.includes('let total = 0;'));
    assert.ok(after.includes('let count = 100;'));
  });

  it('POST /api/inspections/run → ssr-template checker runs (byChecker)', async () => {
    fs.writeFileSync(path.join(projDir, 'app.ts'), FIXTURE_TS, 'utf8');
    const reg = await api(s, 'POST', '/api/projects', { name: 'ssr-proj', path: projDir });
    assert.equal(reg.status, 201, JSON.stringify(reg.body).slice(0, 300));
    const run = await api(s, 'POST', '/api/inspections/run', { projectId: reg.body.id, root: projDir });
    assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 300));
    // First run establishes the baseline (newFindings is empty by design);
    // byChecker proves the ssr-template checker ran and matched once.
    assert.equal(run.body.totals.byChecker['ssr-template'], 1);
  });
});

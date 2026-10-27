/**
 * Extension route tests (round-6 R6-S1) — imports the route from src
 * with type-stripping, injects a temp project root, and exercises
 * install/list/enable/disable/run/panels/providers/checkers/jail.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/extensions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  extensionCheckerProvider,
  handleExtensionRoutes,
  setExtensionInspectionRootResolver,
} from '../src/routes/extensions.ts';
import type { RouteContext } from '../src/routes/context.ts';

const PROJ_BASE = tmpdir();

// NOTE: node:test runs top-level tests in this file concurrently, so
// every test gets its own project root. The jail resolver allows any
// tmpdir root (the escape test still uses /etc, which stays 403).
setExtensionInspectionRootResolver((root?: string) => {
  if (root === undefined) return mkdtempSync(join(tmpdir(), 'ext-proj-'));
  if (root.startsWith(PROJ_BASE)) return root;
  throw new Error(`inspection root is outside the allowed roots: ${root}`);
});

function freshProj(): string {
  return mkdtempSync(join(tmpdir(), 'ext-proj-'));
}

const auditCalls: string[] = [];
function mockCtx(body: unknown) {
  const calls: Array<{ code: number; body: unknown }> = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body as Record<string, unknown>,
    audit: { record: (_a: unknown, event: string) => { auditCalls.push(event); } },
  } as unknown as RouteContext;
  return { ctx, calls };
}

const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;
const url = (p: string) => new URL(`http://127.0.0.1${p}`);

async function run(method: string, path: string, body: unknown = {}) {
  const { ctx, calls } = mockCtx(body);
  const handled = await handleExtensionRoutes(req(method), res, url(path), ctx);
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  return calls[0];
}

const HELLO_MANIFEST = {
  name: 'hello-command',
  version: '1.0.0',
  description: 'sample command',
  permissions: ['commands.execute'],
  contributes: {
    commands: [{ id: 'hello.echo', title: 'Echo' }],
    panels: [],
    checkers: [],
    providers: [],
  },
};
const HELLO_MAIN = `api.registerCommand('hello.echo', (args) => ({ greeting: 'hello ' + (args.name || 'world') }));`;

const MARKER_MANIFEST = {
  name: 'marker-checker',
  version: '1.0.0',
  description: 'sample checker',
  permissions: ['checkers.contribute'],
  contributes: {
    commands: [],
    panels: [],
    checkers: [{ id: 'mark', title: 'Mark', pattern: 'SAMPLE-MARKER', message: 'found SAMPLE-MARKER' }],
    providers: [],
  },
};

test('install + list + run command + panels + uninstall', async () => {
  const PROJ = freshProj();
  const g0 = await run('GET', `/api/extensions?root=${encodeURIComponent(PROJ)}`);
  assert.deepEqual((g0.body as { installed: unknown[] }).installed, []);
  const ins = await run('POST', '/api/extensions/install', { root: PROJ, manifest: HELLO_MANIFEST, main: HELLO_MAIN });
  assert.equal(ins.code, 201);
  assert.ok(auditCalls.includes('EXT_INSTALLED'));
  const list = await run('GET', `/api/extensions?root=${encodeURIComponent(PROJ)}`);
  const installed = (list.body as { installed: Array<{ name: string; enabled: boolean }> }).installed;
  assert.equal(installed.length, 1);
  assert.equal(installed[0].enabled, true);
  const runRes = await run('POST', '/api/extensions/hello-command/commands/hello.echo/run', {
    root: PROJ,
    args: { name: 'tan' },
  });
  assert.equal(runRes.code, 200);
  assert.deepEqual((runRes.body as { result: unknown }).result, { greeting: 'hello tan' });
  const dis = await run('POST', '/api/extensions/hello-command/disable', { root: PROJ });
  assert.equal((dis.body as { extension: { enabled: boolean } }).extension.enabled, false);
  const blocked = await run('POST', '/api/extensions/hello-command/commands/hello.echo/run', {
    root: PROJ,
    args: {},
  });
  assert.equal(blocked.code, 409);
  const del = await run('DELETE', `/api/extensions/hello-command?root=${encodeURIComponent(PROJ)}`);
  assert.equal(del.code, 200);
  assert.ok(auditCalls.includes('EXT_UNINSTALLED'));
});

test('duplicate install is 409-style rejected', async () => {
  const PROJ = freshProj();
  await run('POST', '/api/extensions/install', { root: PROJ, manifest: HELLO_MANIFEST, main: HELLO_MAIN });
  const dup = await run('POST', '/api/extensions/install', { root: PROJ, manifest: HELLO_MANIFEST, main: HELLO_MAIN });
  assert.equal(dup.code, 400);
  assert.match((dup.body as { error: string }).error, /already installed/);
  await run('DELETE', `/api/extensions/hello-command?root=${encodeURIComponent(PROJ)}`);
});

test('malicious manifest and main are rejected at install', async () => {
  const PROJ = freshProj();
  const badPerm = await run('POST', '/api/extensions/install', {
    root: PROJ,
    manifest: { ...HELLO_MANIFEST, permissions: ['network.access'] },
    main: HELLO_MAIN,
  });
  assert.equal(badPerm.code, 400);
  // Top-level require throws at load time, so install fails before writing.
  const badMain = await run('POST', '/api/extensions/install', {
    root: PROJ,
    manifest: HELLO_MANIFEST,
    main: `require('fs');\n${HELLO_MAIN}`,
  });
  assert.equal(badMain.code, 400);
  const list = await run('GET', `/api/extensions?root=${encodeURIComponent(PROJ)}`);
  assert.deepEqual((list.body as { installed: unknown[] }).installed, []);
});

test('handler-body escape is rejected at run time (vm is the enforcement)', async () => {
  const PROJ = freshProj();
  await run('POST', '/api/extensions/install', {
    root: PROJ,
    manifest: HELLO_MANIFEST,
    main: `api.registerCommand('hello.echo', () => require('fs'));`,
  });
  const runRes = await run('POST', '/api/extensions/hello-command/commands/hello.echo/run', {
    root: PROJ,
    args: {},
  });
  assert.equal(runRes.code, 400);
  await run('DELETE', `/api/extensions/hello-command?root=${encodeURIComponent(PROJ)}`);
});

test('root escape is 403', async () => {
  const PROJ = freshProj();
  const esc = await run('GET', '/api/extensions?root=%2Fetc');
  assert.equal(esc.code, 403);
});

test('install-from-dir honours the jail', async () => {
  const PROJ = freshProj();
  const src = join(PROJ, 'src-ext');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'extension.json'), JSON.stringify(HELLO_MANIFEST), 'utf8');
  writeFileSync(join(src, 'main.js'), HELLO_MAIN, 'utf8');
  const ins = await run('POST', '/api/extensions/install-from-dir', { root: PROJ, sourceDir: src });
  assert.equal(ins.code, 201);
  const outside = await run('POST', '/api/extensions/install-from-dir', { root: PROJ, sourceDir: '/tmp' });
  assert.equal(outside.code, 403);
  await run('DELETE', `/api/extensions/hello-command?root=${encodeURIComponent(PROJ)}`);
});

test('checker provider flags marker lines and honours disable', async () => {
  const PROJ = freshProj();
  await run('POST', '/api/extensions/install', { root: PROJ, manifest: MARKER_MANIFEST, main: `// no code needed` });
  const checkers = extensionCheckerProvider(PROJ);
  assert.equal(checkers.length, 1);
  assert.equal(checkers[0].name, 'ext:marker-checker:mark');
  const findings = checkers[0].run({ file: 'src/a.ts', lines: ['clean', 'has SAMPLE-MARKER here'] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].severity, 'warning');
  await run('POST', '/api/extensions/marker-checker/disable', { root: PROJ });
  assert.equal(extensionCheckerProvider(PROJ).length, 0);
  await run('DELETE', `/api/extensions/marker-checker?root=${encodeURIComponent(PROJ)}`);
});

test('schema endpoint documents the subset', async () => {
  const PROJ = freshProj();
  const s = await run('GET', '/api/extensions/schema');
  assert.equal(s.code, 200);
  assert.match(JSON.stringify(s.body), /marketplace/);
});

/**
 * Extension trust route tests (V3-#9) — install trust gate, trust /
 * untrust endpoints, tamper-voided trust, API version rejection,
 * signed install, and the official demo bundles.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/extensions-trust.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { signBundle, validateManifest } from '@ai-factory/extensions';
import {
  handleExtensionRoutes,
  setExtensionInspectionRootResolver,
} from '../src/routes/extensions.ts';
import type { RouteContext } from '../src/routes/context.ts';

const PROJ_BASE = tmpdir();

setExtensionInspectionRootResolver((root?: string) => {
  if (root === undefined) return mkdtempSync(join(tmpdir(), 'ext-trust-proj-'));
  if (root.startsWith(PROJ_BASE)) return root;
  throw new Error(`inspection root is outside the allowed roots: ${root}`);
});

function freshProj(): string {
  return mkdtempSync(join(tmpdir(), 'ext-trust-proj-'));
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

const MANIFEST = {
  name: 'trust-route',
  version: '1.0.0',
  apiVersion: '1',
  description: 'trust route demo',
  permissions: ['commands.execute'],
  contributes: {
    commands: [{ id: 'trust.echo', title: 'Echo' }],
    panels: [],
    checkers: [],
    providers: [],
  },
};
const MAIN = `api.registerCommand('trust.echo', (args) => ({ greeting: 'hello ' + (args.name || 'world') }));`;

test('unsigned inline install without trust is 409 trust-required and installs nothing', async () => {
  const PROJ = freshProj();
  const denied = await run('POST', '/api/extensions/install', { root: PROJ, manifest: MANIFEST, main: MAIN });
  assert.equal(denied.code, 409);
  assert.equal((denied.body as { code: string }).code, 'trust-required');
  const trust = (denied.body as { trust: { trusted: boolean; signature: string } }).trust;
  assert.equal(trust.trusted, false);
  assert.equal(trust.signature, 'absent');
  const list = await run('GET', `/api/extensions?root=${encodeURIComponent(PROJ)}`);
  assert.deepEqual((list.body as { installed: unknown[] }).installed, []);
});

test('unsigned inline install with trust records a user decision and audits it', async () => {
  const PROJ = freshProj();
  const ins = await run('POST', '/api/extensions/install', { root: PROJ, manifest: MANIFEST, main: MAIN, trust: true });
  assert.equal(ins.code, 201);
  const ext = (ins.body as { extension: { trust: { trusted: boolean; trustSource: string } } }).extension;
  assert.equal(ext.trust.trusted, true);
  assert.equal(ext.trust.trustSource, 'user');
  assert.ok(auditCalls.includes('EXT_TRUST_GRANTED'));
  const runRes = await run('POST', '/api/extensions/trust-route/commands/trust.echo/run', { root: PROJ, args: { name: 'tan' } });
  assert.equal(runRes.code, 200);
  assert.deepEqual((runRes.body as { result: unknown }).result, { greeting: 'hello tan' });
  await run('DELETE', `/api/extensions/trust-route?root=${encodeURIComponent(PROJ)}`);
});

test('tampering voids trust: run and enable fail 409 until re-trusted', async () => {
  const PROJ = freshProj();
  await run('POST', '/api/extensions/install', { root: PROJ, manifest: MANIFEST, main: MAIN, trust: true });
  const mainPath = join(PROJ, '.ai-factory', 'extensions', 'trust-route', 'main.js');
  writeFileSync(mainPath, readFileSync(mainPath, 'utf8') + '\n// tampered\n', 'utf8');
  const denied = await run('POST', '/api/extensions/trust-route/commands/trust.echo/run', { root: PROJ, args: {} });
  assert.equal(denied.code, 409);
  assert.equal((denied.body as { code: string }).code, 'trust-required');
  await run('POST', '/api/extensions/trust-route/disable', { root: PROJ });
  const enableDenied = await run('POST', '/api/extensions/trust-route/enable', { root: PROJ });
  assert.equal(enableDenied.code, 409);
  const granted = await run('POST', '/api/extensions/trust-route/trust', { root: PROJ });
  assert.equal(granted.code, 200);
  assert.equal((granted.body as { trusted: boolean }).trusted, true);
  const enabled = await run('POST', '/api/extensions/trust-route/enable', { root: PROJ });
  assert.equal(enabled.code, 200);
  const runRes = await run('POST', '/api/extensions/trust-route/commands/trust.echo/run', { root: PROJ, args: {} });
  assert.equal(runRes.code, 200);
  await run('DELETE', `/api/extensions/trust-route?root=${encodeURIComponent(PROJ)}`);
});

test('untrust revokes the decision and blocks runs again', async () => {
  const PROJ = freshProj();
  await run('POST', '/api/extensions/install', { root: PROJ, manifest: MANIFEST, main: MAIN, trust: true });
  const revoked = await run('POST', '/api/extensions/trust-route/untrust', { root: PROJ });
  assert.equal(revoked.code, 200);
  assert.equal((revoked.body as { trusted: boolean }).trusted, false);
  assert.ok(auditCalls.includes('EXT_TRUST_REVOKED'));
  const denied = await run('POST', '/api/extensions/trust-route/commands/trust.echo/run', { root: PROJ, args: {} });
  assert.equal(denied.code, 409);
  await run('DELETE', `/api/extensions/trust-route?root=${encodeURIComponent(PROJ)}`);
});

test('apiVersion 2 install is rejected, not silently run', async () => {
  const PROJ = freshProj();
  const denied = await run('POST', '/api/extensions/install', {
    root: PROJ,
    manifest: { ...MANIFEST, apiVersion: '2' },
    main: MAIN,
    trust: true,
  });
  assert.equal(denied.code, 400);
  assert.match((denied.body as { error: string }).error, /not supported by this host/);
});

test('signed install needs no trust flag and is trusted by signature', async () => {
  const PROJ = freshProj();
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const validated = validateManifest(MANIFEST);
  const sig = signBundle(validated, MAIN, pem);
  const ins = await run('POST', '/api/extensions/install', { root: PROJ, manifest: MANIFEST, main: MAIN, signature: sig });
  assert.equal(ins.code, 201);
  const ext = (ins.body as { extension: { trust: { trusted: boolean; trustSource: string; signature: string; review: string } } }).extension;
  assert.equal(ext.trust.trusted, true);
  assert.equal(ext.trust.trustSource, 'signature');
  assert.equal(ext.trust.signature, 'valid');
  assert.equal(ext.trust.review, 'unreviewed');
  const bad = await run('POST', '/api/extensions/install', {
    root: PROJ,
    manifest: { ...MANIFEST, name: 'trust-bad-sig' },
    main: MAIN,
    signature: { ...sig, signature: Buffer.from('tampered').toString('base64') },
  });
  assert.equal(bad.code, 400);
  assert.match((bad.body as { error: string }).error, /signature verification failed/);
  await run('DELETE', `/api/extensions/trust-route?root=${encodeURIComponent(PROJ)}`);
});

test('official demo bundles install from dir as official and run', async () => {
  const PROJ = freshProj();
  // install-from-dir is jailed to the project root by design, so copy
  // the shipped demo bundle (manifest + main + signature) inside first.
  // This is also the real user path for a demo checkout.
  const { mkdirSync, copyFileSync } = await import('node:fs');
  const demoDir = join(PROJ, 'demo-hello');
  mkdirSync(demoDir, { recursive: true });
  const repoDemo = fileURLToPath(new URL('../../../packages/extensions/demo/hello-command', import.meta.url));
  for (const f of ['extension.json', 'main.js', 'signature.json']) {
    copyFileSync(join(repoDemo, f), join(demoDir, f));
  }
  const ins = await run('POST', '/api/extensions/install-from-dir', { root: PROJ, sourceDir: demoDir });
  assert.equal(ins.code, 201);
  const ext = (ins.body as { extension: { trust: { trusted: boolean; trustSource: string; review: string; signature: string } } }).extension;
  assert.equal(ext.trust.trusted, true);
  assert.equal(ext.trust.trustSource, 'official');
  assert.equal(ext.trust.review, 'official');
  assert.equal(ext.trust.signature, 'valid');
  const runRes = await run('POST', '/api/extensions/hello-command/commands/hello.echo/run', { root: PROJ, args: { name: 'tan' } });
  assert.equal(runRes.code, 200);
  assert.deepEqual((runRes.body as { result: unknown }).result, { greeting: 'hello tan' });
  const notesDir = join(PROJ, 'demo-notes');
  mkdirSync(notesDir, { recursive: true });
  const repoNotes = fileURLToPath(new URL('../../../packages/extensions/demo/demo-notes', import.meta.url));
  for (const f of ['extension.json', 'main.js', 'signature.json']) {
    copyFileSync(join(repoNotes, f), join(notesDir, f));
  }
  const ins2 = await run('POST', '/api/extensions/install-from-dir', { root: PROJ, sourceDir: notesDir });
  assert.equal(ins2.code, 201);
  const prov = await run('POST', '/api/extensions/demo-notes/providers/demo.notes/resolve', { root: PROJ, query: 'hello' });
  assert.equal(prov.code, 200);
  assert.deepEqual((prov.body as { items: unknown }).items, [{ label: 'note:hello', text: 'note body for hello' }]);
  await run('DELETE', `/api/extensions/hello-command?root=${encodeURIComponent(PROJ)}`);
  await run('DELETE', `/api/extensions/demo-notes?root=${encodeURIComponent(PROJ)}`);
});

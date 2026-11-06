/**
 * Egress firewall tests — imports ../src/egress.ts straight from src
 * under node's type-stripping ESM loader (the module is node builtins
 * plus the compiled @ai-factory/diagpack package, so it resolves —
 * dual-mode import rule in AGENTS.md). The last test exercises a REAL
 * outbound point: @ai-factory/search's fetchText with the process guard
 * installed (deny refuses before dialing; an allowed call reaches a real
 * local server).
 *
 * Run: npm run test:server (TMPDIR wrapper); or
 *   node --test apps/server/tests/egress.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EgressStore,
  assertEgressAllowed,
  checkEgress,
  egressBlockedError,
  evaluateEgress,
  getEgressBlockLog,
  hostMatchesRule,
  resetEgressStoreForTests,
  setEgressBlockSinks,
  validateEgressRules,
  type EgressGlobalConfig,
  type EgressRule,
} from '../src/egress.ts';
import { fetchText, setFetchTextGuard } from '@ai-factory/search';

const allow = (domain: string, pathPrefix?: string): EgressRule => ({ domain, action: 'allow', ...(pathPrefix ? { pathPrefix } : {}) });
const deny = (domain: string, pathPrefix?: string): EgressRule => ({ domain, action: 'deny', ...(pathPrefix ? { pathPrefix } : {}) });

function globalCfg(rules: EgressRule[], defaultPolicy: 'allow' | 'deny' = 'deny', enabled = true): EgressGlobalConfig {
  return { enabled, defaultPolicy, rules, updatedAt: new Date(0).toISOString(), updatedBy: 'test' };
}

test('domain matching: suffix semantics cover subdomains, not look-alikes', () => {
  assert.equal(hostMatchesRule('example.com', 'example.com'), true);
  assert.equal(hostMatchesRule('example.com', 'api.example.com'), true);
  assert.equal(hostMatchesRule('example.com', 'a.b.example.com'), true);
  assert.equal(hostMatchesRule('example.com', 'notexample.com'), false);
  assert.equal(hostMatchesRule('example.com', 'example.com.evil.com'), false);
  assert.equal(hostMatchesRule('EXAMPLE.com.', 'Api.Example.COM'), true);
});

test('IP literals: exact match only — an IP is not the domain it resolves to', () => {
  assert.equal(hostMatchesRule('93.184.216.34', '93.184.216.34'), true);
  assert.equal(hostMatchesRule('example.com', '93.184.216.34'), false);
  assert.equal(hostMatchesRule('93.184.216.34', 'example.com'), false);
  assert.equal(hostMatchesRule('::1', '[::1]'), true);
});

test('disabled firewall allows everything (and says why)', () => {
  const v = evaluateEgress('https://anything.example/x', { global: globalCfg([deny('example.com')], 'deny', false) });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'disabled');
});

test('loopback is always exempt, even enabled + default-deny + deny rule', () => {
  const v = evaluateEgress('http://127.0.0.1:3100/api/health', { global: globalCfg([deny('127.0.0.1')]) });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'loopback-exempt');
  assert.equal(evaluateEgress('http://localhost:5173/', { global: globalCfg([]) }).allowed, true);
});

test('deny beats allow across layers; most specific layer reported', () => {
  const layers = {
    global: globalCfg([allow('example.com')]),
    project: { rules: [allow('api.example.com')] },
    task: { rules: [deny('api.example.com')] },
  };
  const v = evaluateEgress('https://api.example.com/v1', layers);
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'deny-rule');
  assert.equal(v.matchedLayer, 'task');
});

test('project-layer deny beats global allow', () => {
  const layers = {
    global: globalCfg([allow('example.com')]),
    project: { rules: [deny('example.com')] },
  };
  const v = evaluateEgress('https://example.com/', layers);
  assert.equal(v.allowed, false);
  assert.equal(v.matchedLayer, 'project');
});

test('allow rule in any layer allows under default-deny', () => {
  const layers = {
    global: globalCfg([]),
    project: { rules: [allow('api.example.com')] },
  };
  const v = evaluateEgress('https://api.example.com/x', layers);
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'allow-rule');
  assert.equal(v.matchedLayer, 'project');
  // non-matching host falls through to default-deny
  const v2 = evaluateEgress('https://other.example/x', layers);
  assert.equal(v2.allowed, false);
  assert.equal(v2.reason, 'default-deny');
});

test('default-allow policy: denylist mode', () => {
  const layers = { global: globalCfg([deny('bad.example')], 'allow') };
  assert.equal(evaluateEgress('https://good.example/', layers).reason, 'default-allow');
  assert.equal(evaluateEgress('https://bad.example/', layers).allowed, false);
});

test('path prefix: rule with prefix only covers that subtree', () => {
  const layers = { global: globalCfg([allow('api.example.com', '/v1/')]) };
  assert.equal(evaluateEgress('https://api.example.com/v1/models', layers).allowed, true);
  assert.equal(evaluateEgress('https://api.example.com/v2/models', layers).allowed, false);
  // prefix without leading slash is normalized
  const layers2 = { global: globalCfg([deny('api.example.com', 'admin')]) };
  assert.equal(evaluateEgress('https://api.example.com/admin/x', layers2).allowed, false);
});

test('ports are not distinguished: a domain rule covers every port', () => {
  const layers = { global: globalCfg([deny('example.com')]) };
  assert.equal(evaluateEgress('https://example.com:8443/x', layers).allowed, false);
  assert.equal(evaluateEgress('http://example.com:8080/x', layers).allowed, false);
});

test('non-http(s) and invalid URLs are refused when enabled', () => {
  const layers = { global: globalCfg([], 'allow') };
  assert.equal(evaluateEgress('file:///etc/passwd', layers).reason, 'non-http-scheme');
  assert.equal(evaluateEgress('not a url', layers).reason, 'invalid-url');
});

test('validation rejects wildcards, bad domains, bad actions, bad prefixes', () => {
  assert.match(validateEgressRules([{ domain: '*.example.com', action: 'allow' }], 'x').join(' '), /wildcards are not supported/);
  assert.ok(validateEgressRules([{ domain: '', action: 'allow' }], 'x').length > 0);
  assert.ok(validateEgressRules([{ domain: 'exa mple.com', action: 'allow' }], 'x').length > 0);
  assert.ok(validateEgressRules([{ domain: 'a.com', action: 'maybe' as never }], 'x').length > 0);
  assert.ok(validateEgressRules([{ domain: 'a.com', action: 'allow', pathPrefix: 'a\\b' }], 'x').length > 0);
  assert.deepEqual(validateEgressRules([allow('api.example.com', '/v1/'), deny('93.184.216.34')], 'x'), []);
  assert.deepEqual(validateEgressRules([], 'x'), []);
});

test('store: global + project/task layers round-trip through disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-egress-'));
  const store = new EgressStore(path.join(dir, 'data'));
  // factory default (V3-#5): enabled + deny, flagged factoryDefault
  assert.equal(store.getGlobal().enabled, true);
  assert.equal(store.getGlobal().factoryDefault, true);
  assert.equal(store.getGlobal().legacy, false);
  store.setGlobal({ enabled: true, defaultPolicy: 'deny', rules: [allow('example.com')] }, 'tester');
  const g = store.getGlobal();
  assert.equal(g.enabled, true);
  assert.deepEqual(g.rules, [{ domain: 'example.com', action: 'allow' }]);
  assert.equal(g.updatedBy, 'tester');
  // project layer + task rules
  const projDir = path.join(dir, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  store.setProjectLayer(projDir, { rules: [deny('evil.example')] });
  store.setProjectLayer(projDir, { taskId: 'task-1', taskRules: [allow('api.example.com', '/v2/')] });
  const layers = store.layersFor({ projectDir: projDir, taskId: 'task-1' });
  assert.equal(evaluateEgress('https://evil.example/', layers).allowed, false);
  assert.equal(evaluateEgress('https://api.example.com/v2/x', layers).allowed, true);
  assert.equal(evaluateEgress('https://api.example.com/v1/x', layers).allowed, true); // global allow('example.com') has no path prefix
  const file = JSON.parse(fs.readFileSync(path.join(projDir, '.ai-factory', 'egress.json'), 'utf8')) as { tasks: Record<string, unknown> };
  assert.ok('task-1' in file.tasks);
  // empty task rules remove the task entry
  store.setProjectLayer(projDir, { taskId: 'task-1', taskRules: [] });
  assert.equal(store.getProjectLayer(projDir).tasks['task-1'], undefined);
  // corrupt global file → disabled + loadError surfaced, never a guess
  fs.writeFileSync(store.globalFile(), '{ not json');
  const corrupt = store.getGlobal();
  assert.equal(corrupt.enabled, false);
  assert.match(corrupt.loadError ?? '', /unreadable/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkEgress records blocks: log entry + audit + notification sinks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-egress-'));
  process.env['AI_FACTORY_DATA_DIR'] = path.join(dir, 'data');
  resetEgressStoreForTests();
  const store = new EgressStore(path.join(dir, 'data'));
  store.setGlobal({ enabled: true, defaultPolicy: 'deny', rules: [deny('blocked.example')] }, 'tester');
  // point the singleton at the same files by re-creating after env set
  const audits: unknown[][] = [];
  const notes: unknown[] = [];
  setEgressBlockSinks({
    audit: (...args: unknown[]) => { audits.push(args); },
    notify: (e) => { notes.push(e); },
  });
  const v = checkEgress('https://blocked.example/secret', { source: 'unit-test' });
  assert.equal(v.allowed, false);
  const log = getEgressBlockLog(10);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.hostname, 'blocked.example');
  assert.equal(log[0]!.source, 'unit-test');
  assert.equal(audits.length, 1);
  assert.equal((audits[0] as unknown[])[1], 'EGRESS_BLOCKED');
  assert.equal(notes.length, 1);
  assert.equal((notes[0] as { type: string }).type, 'EGRESS_BLOCKED');
  // allowed call records nothing
  checkEgress('http://127.0.0.1:9/x', { source: 'unit-test' });
  assert.equal(getEgressBlockLog(10).length, 1);
  // assertEgressAllowed throws the coded error
  assert.throws(
    () => assertEgressAllowed('https://blocked.example/', { source: 'unit-test' }),
    (e: unknown) => (e as { code?: string }).code === 'EGRESS_BLOCKED',
  );
  // egressBlockedError is a plain Error with the code property
  const err = egressBlockedError('https://x.example/', v);
  assert.equal(err.code, 'EGRESS_BLOCKED');
  delete process.env['AI_FACTORY_DATA_DIR'];
  resetEgressStoreForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('real outbound point: fetchText guard refuses denied hosts and passes allowed ones', async () => {
  // The sandbox intercepts non-loopback TCP (replies with a policy text
  // instead of HTTP), so the e2e uses two provable cases against a local
  // server: (a) a denied hostname — the guard refuses BEFORE any socket
  // is opened, provable because the same call dialed for real would fail
  // with ENOTFOUND/ECONNREFUSED instead; (b) an allowed call passes the
  // guard and reaches the real local server.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-egress-'));
  process.env['AI_FACTORY_DATA_DIR'] = path.join(dir, 'data');
  resetEgressStoreForTests();
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello-egress'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    // Sanity: no guard installed, plain fetch works.
    assert.equal(await fetchText(`http://127.0.0.1:${port}/`, { timeoutMs: 3000 }), 'hello-egress');
    // Enable: default-allow, deny one hostname.
    new EgressStore(path.join(dir, 'data')).setGlobal(
      { enabled: true, defaultPolicy: 'allow', rules: [{ domain: 'blocked-test.invalid', action: 'deny' }] },
      'tester',
    );
    setFetchTextGuard((url) => assertEgressAllowed(url, { source: 'unit-test-fetch' }));
    // Denied host: EGRESS_BLOCKED (guard precedes dialing — a real dial
    // of blocked-test.invalid would die in DNS, not here).
    await assert.rejects(
      fetchText('http://blocked-test.invalid/', { timeoutMs: 3000 }),
      (e: unknown) => (e as { code?: string }).code === 'EGRESS_BLOCKED',
    );
    assert.equal(getEgressBlockLog(5)[0]!.source, 'unit-test-fetch');
    assert.equal(getEgressBlockLog(5)[0]!.hostname, 'blocked-test.invalid');
    // Allowed host: the guard runs, allows, and the real server answers.
    assert.equal(await fetchText(`http://127.0.0.1:${port}/ok`, { timeoutMs: 3000 }), 'hello-egress');
    // default-allow lets unlisted names through the guard (the dial then
    // fails on DNS — crucially NOT with EGRESS_BLOCKED).
    await assert.rejects(
      fetchText('http://other-test.invalid/', { timeoutMs: 3000 }),
      (e: unknown) => (e as { code?: string }).code !== 'EGRESS_BLOCKED',
    );
  } finally {
    setFetchTextGuard(null);
    delete process.env['AI_FACTORY_DATA_DIR'];
    resetEgressStoreForTests();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

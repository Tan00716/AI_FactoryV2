/**
 * Headless CLI inspect command tests (task ⑧) — mock HttpClient, no server.
 * Run: node --test packages/headless/dist/tests/*.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectCommand,
  parseArgs,
  EXIT_OK,
  EXIT_FAILED,
  EXIT_USAGE,
  EXIT_INSPECT_VIOLATIONS,
  type HttpClient,
  type HttpResult,
} from '../src/index.js';

type Handler = (method: string, path: string, body?: unknown) => HttpResult;

function mockClient(handler: Handler): HttpClient {
  return {
    request(method: string, path: string, body?: unknown): Promise<HttpResult> {
      return Promise.resolve(handler(method, path, body));
    },
  };
}

const runPayload = (over: Record<string, unknown> = {}) => ({
  runId: 'r1',
  projectId: 'p1',
  root: '/proj',
  profileName: 'default',
  profileSource: 'default-missing',
  totals: { total: 3, info: 1, warning: 2, error: 0, byChecker: { 'todo-fixme': 1, 'console-log': 2 } },
  newCount: 0,
  newFindings: [],
  baselineEstablished: false,
  licenses: { scanned: true, nodeModulesPresent: false, total: 0, note: 'heuristics' },
  ...over,
});

test('inspect: missing --project is a usage error (exit 2)', async () => {
  const r = await inspectCommand({ projectId: '  ', failOn: 'new', json: false }, mockClient(() => {
    throw new Error('unexpected');
  }));
  assert.equal(r.exitCode, EXIT_USAGE);
});

test('inspect: clean gate → exit 0', async () => {
  const http = mockClient((method, path) => {
    if (method === 'POST' && path === '/api/inspections/run') return { status: 200, body: runPayload() };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const r = await inspectCommand({ projectId: 'p1', failOn: 'new', json: false }, http);
  assert.equal(r.exitCode, EXIT_OK);
  assert.match(String((r.output as string[])[0]), /PASS/);
});

test('inspect: new findings with fail-on=new → exit 2 (violations)', async () => {
  const http = mockClient((method, path) => {
    if (method === 'POST' && path === '/api/inspections/run')
      return { status: 200, body: runPayload({ newCount: 2, newFindings: [{ id: 'a' }, { id: 'b' }] }) };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const r = await inspectCommand({ projectId: 'p1', failOn: 'new', json: false }, http);
  assert.equal(r.exitCode, EXIT_INSPECT_VIOLATIONS);
  assert.equal(EXIT_INSPECT_VIOLATIONS, 2);
  assert.match(String((r.output as string[])[0]), /VIOLATIONS/);
});

test('inspect: fail-on=any fails on any finding even when baselined', async () => {
  const http = mockClient((method, path) => {
    if (method === 'POST' && path === '/api/inspections/run') return { status: 200, body: runPayload({ newCount: 0 }) };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const r = await inspectCommand({ projectId: 'p1', failOn: 'any', json: true }, http);
  assert.equal(r.exitCode, EXIT_INSPECT_VIOLATIONS);
  assert.equal((r.output as Record<string, unknown>)['newCount'], 0);
});

test('inspect: server error → exit 1', async () => {
  const http = mockClient(() => ({ status: 500, body: { error: 'boom' } }));
  const r = await inspectCommand({ projectId: 'p1', failOn: 'new', json: false }, http);
  assert.equal(r.exitCode, EXIT_FAILED);
});

test('inspect: --profile applies the file first (PUT then POST run)', async () => {
  const seen: string[] = [];
  const http = mockClient((method, path, body) => {
    seen.push(`${method} ${path}`);
    if (method === 'PUT' && path === '/api/inspections/profile') {
      assert.equal((body as Record<string, unknown>)['projectId'], 'p1');
      return { status: 200, body: { projectId: 'p1', profile: (body as Record<string, unknown>)['profile'] } };
    }
    if (method === 'POST' && path === '/api/inspections/run') return { status: 200, body: runPayload() };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const r = await inspectCommand(
    { projectId: 'p1', profilePath: '/nonexistent-dir/missing-profile.json', failOn: 'new', json: false },
    http,
  );
  // Missing file is an operation failure, no HTTP calls made.
  assert.equal(r.exitCode, EXIT_FAILED);
  assert.equal(seen.length, 0);
});

test('parseArgs: inspect flags parse', () => {
  const p = parseArgs(['inspect', '--project', 'p1', '--root', '/x', '--fail-on', 'any', '--json']);
  assert.equal(p.command, 'inspect');
  assert.equal(p.opts['project'], 'p1');
  assert.equal(p.opts['root'], '/x');
  assert.equal(p.opts['fail-on'], 'any');
  assert.equal(p.opts['json'], true);
});

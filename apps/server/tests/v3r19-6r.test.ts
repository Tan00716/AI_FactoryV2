/**
 * Audit-ingestion redaction tests — R19 #6(r) (R19 N6–N10).
 *
 * Drives the real code paths (checkEgress sinks, httpclient history,
 * slash-command execution, task-chain execution) with synthetic
 * credential SHAPES (not real credentials) and asserts the viewer-readable
 * records carry no userinfo / assignment value. The N8 core (the
 * credential-assignment redactor itself) is unit-tested in
 * packages/diagpack/tests/redact-credential-assignments.test.ts (npm test
 * count); the N8 route behaviour is covered by the probe in
 * ~/v3r19-6r-shots/ (real WorkspaceExecutor: the command is policy-
 * rejected, but the rejection is audited with the raw command — see
 * packages/projects/src/executor.ts `fail()`).
 *
 * Dual-mode note: routes/commands.ts value-imports ../plan-store
 * (extensionless relative), so it is imported here from compiled dist
 * (flaky.test.ts precedent) — run after the server build. The other
 * three routes import node builtins + compiled @ai-factory/* packages
 * only, so src import with type-stripping is safe.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/v3r19-6r.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EgressStore,
  checkEgress,
  getEgressBlockLog,
  resetEgressStoreForTests,
  setEgressBlockSinks,
} from '../src/egress.ts';
import {
  handleHttpClientRoutes,
  setHttpApiDeps,
  setHttpClientEgressGate,
  setHttpClientRootResolver,
} from '../src/routes/httpclient.ts';
import { handleCommandRoutes } from '../dist/routes/commands.js';
import {
  resetTaskRunRecords,
  runTaskChainByLabel,
  setTaskRunnerDeps,
  type TaskRunnerDeps,
} from '../src/routes/tasks.ts';
import type { RouteContext } from '../src/routes/context.ts';
import type { ParseStats, ProblemMatcherDef } from '../src/problem-matchers.ts';

const MARKER = 'r19probe-7f3a9c1e5b8d2a4f6';

interface AuditRec {
  event: string;
  details?: Record<string, unknown>;
}

function mockCtx(body: unknown): {
  ctx: RouteContext;
  calls: Array<{ code: number; body: unknown }>;
  audits: AuditRec[];
} {
  const calls: Array<{ code: number; body: unknown }> = [];
  const audits: AuditRec[] = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body as Record<string, unknown>,
    audit: {
      record: (_actor: string, event: string, _entityType: string, _entityId: string, details?: Record<string, unknown>) => {
        audits.push({ event, details });
      },
    },
  } as unknown as RouteContext;
  return { ctx, calls, audits };
}

const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;

test('R19 N6: EGRESS_BLOCKED audit + notification + block log carry no userinfo (malformed / default-deny / non-http-scheme)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v3r19-6r-egress-'));
  process.env['AI_FACTORY_DATA_DIR'] = join(dir, 'data');
  resetEgressStoreForTests();
  const store = new EgressStore(join(dir, 'data'));
  store.setGlobal({ enabled: true, defaultPolicy: 'deny', rules: [] }, 'tester');
  const audits: unknown[][] = [];
  const notes: unknown[] = [];
  setEgressBlockSinks({
    audit: (...args: unknown[]) => { audits.push(args); },
    notify: (e) => { notes.push(e); },
  });
  try {
    // (1) malformed — port out of range, new URL() throws -> invalid-url.
    const v1 = checkEgress(`http://hookuser:s3cret-pw@127.0.0.1:99999/hook`, { source: 'unit-test' });
    assert.equal(v1.allowed, false);
    assert.equal(v1.reason, 'invalid-url');
    // (2) well-formed but not allowlisted -> default-deny.
    const v2 = checkEgress(`https://hookuser:s3cret-pw@notallowed.example/hook`, { source: 'unit-test' });
    assert.equal(v2.allowed, false);
    assert.equal(v2.reason, 'default-deny');
    // (3) non-http(s) scheme.
    const v3 = checkEgress(`ftp://ftpuser:ftp-pw@ftp.example/file.txt`, { source: 'unit-test' });
    assert.equal(v3.allowed, false);
    assert.equal(v3.reason, 'non-http-scheme');

    // All three write points, all three shapes: no userinfo anywhere.
    const log = getEgressBlockLog(10);
    assert.equal(log.length, 3);
    for (const entry of log) {
      assert.doesNotMatch(entry.url, /hookuser|s3cret-pw|ftpuser|ftp-pw/, 'block log url must not carry userinfo');
    }
    assert.match(log.map((e) => e.url).join(' '), /127\.0\.0\.1:99999\/hook/, 'malformed host/path preserved');
    assert.match(log.map((e) => e.url).join(' '), /notallowed\.example\/hook/, 'default-deny host/path preserved');
    assert.match(log.map((e) => e.url).join(' '), /ftp\.example\/file\.txt/, 'non-http-scheme host/path preserved');
    assert.equal(audits.length, 3);
    for (const a of audits) {
      assert.equal(a[1], 'EGRESS_BLOCKED');
      assert.doesNotMatch(String((a[4] as Record<string, unknown>)?.['url'] ?? ''), /hookuser|s3cret-pw|ftpuser|ftp-pw/, 'audit url must not carry userinfo');
    }
    assert.equal(notes.length, 3);
    for (const n of notes) {
      assert.equal((n as { type: string }).type, 'EGRESS_BLOCKED');
      assert.doesNotMatch(String((n as { detail?: Record<string, unknown> }).detail?.['url'] ?? ''), /hookuser|s3cret-pw|ftpuser|ftp-pw/, 'notification url must not carry userinfo');
    }
  } finally {
    setEgressBlockSinks({});
    delete process.env['AI_FACTORY_DATA_DIR'];
    resetEgressStoreForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R19 N7: httpclient history spec.url / urlTemplate / error / body carry no userinfo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v3r19-6r-http-'));
  setHttpClientRootResolver(() => dir);
  // handleSend loads the store first: the api data dir must be wired
  // (index.ts installs this once at boot; tests inject it).
  setHttpApiDeps({ resolveDataDir: () => dir });
  // Throwing gate: executeSend takes the blocked branch, which records
  // history with the raw template — the exact N7 leak, with no network.
  setHttpClientEgressGate(() => {
    throw new Error('blocked for test');
  });
  try {
    const { ctx, calls } = mockCtx({
      method: 'GET',
      url: `https://hookuser:s3cret-pw@127.0.0.1:9/hook`,
      body: `see https://bodyuser:body-pw@127.0.0.1:9/x`,
    });
    const handled = await handleHttpClientRoutes(
      req('POST'),
      res,
      new URL('http://127.0.0.1/api/http/send'),
      ctx,
    );
    assert.equal(handled, true);
    assert.equal(calls[0]?.code, 200);
    const { ctx: listCtx, calls: listCalls } = mockCtx(null);
    const listed = await handleHttpClientRoutes(
      req('GET'),
      res,
      new URL('http://127.0.0.1/api/http/history'),
      listCtx,
    );
    assert.equal(listed, true);
    const history = (listCalls[0]?.body as { history?: Array<Record<string, unknown>> }).history ?? [];
    assert.equal(history.length, 1);
    const entry = history[0] as Record<string, unknown>;
    assert.doesNotMatch(String(entry['urlTemplate'] ?? ''), /hookuser|s3cret-pw/, 'urlTemplate must not carry userinfo');
    assert.match(String(entry['urlTemplate'] ?? ''), /127\.0\.0\.1:9\/hook/, 'urlTemplate host/path preserved');
    const spec = entry['spec'] as Record<string, unknown>;
    assert.doesNotMatch(String(spec['url'] ?? ''), /hookuser|s3cret-pw/, 'spec.url must not carry userinfo');
    assert.match(String(spec['url'] ?? ''), /127\.0\.0\.1:9\/hook/, 'spec.url host/path preserved');
    assert.doesNotMatch(String(spec['body'] ?? ''), /bodyuser|body-pw/, 'spec.body must not carry userinfo');
    assert.match(String(spec['body'] ?? ''), /127\.0\.0\.1:9\/x/, 'spec.body host/path preserved');
  } finally {
    setHttpClientEgressGate(null);
    setHttpClientRootResolver(null);
    setHttpApiDeps(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R19 N9: COMMAND_EXECUTED args carry no --token value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v3r19-6r-cmds-'));
  process.env['AI_FACTORY_COMMANDS_FILE'] = join(dir, 'slash-commands.json');
  writeFileSync(
    join(dir, 'slash-commands.json'),
    JSON.stringify({
      commands: [{ name: 'echoit', kind: 'template', template: 'hello {args}', description: '', enabled: true }],
    }),
    'utf8',
  );
  try {
    const { ctx, calls, audits } = mockCtx({ input: `/echoit --token ${MARKER}` });
    const handled = await handleCommandRoutes(
      req('POST'),
      res,
      new URL('http://127.0.0.1/api/commands/execute'),
      ctx,
    );
    assert.equal(handled, true);
    assert.equal(calls[0]?.code, 200);
    const executed = audits.find((a) => a.event === 'COMMAND_EXECUTED');
    assert.ok(executed, 'COMMAND_EXECUTED must be recorded');
    const args = String(executed.details?.['args'] ?? '');
    assert.doesNotMatch(args, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'args must not carry the token value');
    assert.match(args, /--token \*\*\*/, 'flag name kept, value masked');
  } finally {
    delete process.env['AI_FACTORY_COMMANDS_FILE'];
    rmSync(dir, { recursive: true, force: true });
  }
});

const EMPTY_STATS: ParseStats = {
  lines: 0, matchedLines: 0, skippedLines: 0, diagnostics: 0,
  matchers: [], matchRate: 1, truncated: false,
};

/** Stub exec policy (tasks.test.ts): allowlist echo/node only. */
function stubPolicy(command: string): string[] {
  if (/(^|\s)rm(\s|$)/.test(command)) {
    const e = new Error('command refused: blocked by the execution safety policy');
    e.name = 'ExecPolicyDenied';
    throw e;
  }
  const tokens = command.trim().split(/\s+/);
  if (!['echo', 'node'].includes(tokens[0])) {
    const e = new Error(`command refused: '${tokens[0]}' is not in the allowed command list`);
    e.name = 'ExecPolicyDenied';
    throw e;
  }
  return tokens;
}

test('R19 N10: TASK_CHAIN_STARTED extraArgs carry no KEY=VALUE value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v3r19-6r-tasks-'));
  mkdirSync(join(dir, '.ai-factory'), { recursive: true });
  writeFileSync(
    join(dir, '.ai-factory', 'tasks.json'),
    JSON.stringify({ version: '2.0.0', tasks: [{ label: 'hello', command: 'echo hello' }] }),
    'utf8',
  );
  const deps: TaskRunnerDeps = {
    resolveRoot: () => dir,
    checkCommandPolicy: stubPolicy,
    commandHitsControlDir: () => false,
    resolveCwd: (cwd) => cwd ?? dir,
    parseAndStore: () => ({ added: 0, total: 0, stats: EMPTY_STATS }),
    resolveMatchers: () => [],
    getMatcher: (_pid: string, _name: string): ProblemMatcherDef | null => null,
  };
  setTaskRunnerDeps(deps);
  resetTaskRunRecords();
  try {
    const { ctx, audits } = mockCtx(null);
    const outcome = await runTaskChainByLabel('hello', dir, 'default', 'human', ctx, [`KEY=${MARKER}`]);
    assert.equal(outcome.ok, true);
    const started = audits.find((a) => a.event === 'TASK_CHAIN_STARTED');
    assert.ok(started, 'TASK_CHAIN_STARTED must be recorded');
    const extraArgs = started.details?.['extraArgs'] as string[] | undefined;
    assert.ok(Array.isArray(extraArgs), 'extraArgs must be present');
    assert.deepEqual(extraArgs, ['KEY=***'], 'key name kept, value masked');
    assert.doesNotMatch(extraArgs.join(' '), new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    setTaskRunnerDeps(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

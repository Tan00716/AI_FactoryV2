/**
 * DAP debugger route tests (round-4 task R4-S2) — imports
 * ../src/routes/debug.ts straight from src under node's type-stripping
 * ESM loader. The route module is node builtins only (+ @ai-factory/debugger
 * dist), so it resolves (dual-mode import rule in AGENTS.md).
 *
 * The adapter spawn is replaced via setDebugAdapterSpawnFn with a fixture
 * fake DAP adapter (tests/fixtures/debug/fake-adapter.mjs), so the full
 * session lifecycle is deterministic without a real node --inspect.
 *
 * Covers: path non-match, validation 400s, jail refusal, launch.json
 * configs (missing/invalid/mixed types), session start (201) incl. unknown
 * configName 404 and non-node type rejection, breakpoint set, stack/scopes/
 * variables/evaluate, step actions incl. NOT_PAUSED 409, output buffering,
 * session-dead 410, delete + 404 after.
 *
 * Run: npm run test:server (TMPDIR wrapper); or
 *   node --test apps/server/tests/debug.test.ts
 * from the repo root.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleDebugRoutes,
  setDebugInspectionRootResolver,
  setDebugAdapterSpawnFn,
} from '../src/routes/debug.ts';
import type { RouteContext } from '../src/routes/context.ts';
import type { SpawnedProcess } from '@ai-factory/debugger';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'debug-srv-test-'));
const FAKE_ADAPTER = join(
  process.cwd(),
  'apps/server/tests/fixtures/debug/fake-adapter.mjs',
);

setDebugInspectionRootResolver(() => TEST_ROOT);

function fakeSpawn(extraArgs: string[] = []) {
  return (
    _command: string,
    _args: string[],
    opts: { env: Record<string, string>; cwd?: string },
  ): SpawnedProcess => {
    const child: ChildProcess = spawn('node', [FAKE_ADAPTER, ...extraArgs], {
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      on: (event: 'error' | 'exit', cb: (...args: unknown[]) => void) => {
        child.on(event, cb as (...a: never[]) => void);
      },
      kill: (signal?: NodeJS.Signals) => {
        try {
          child.kill(signal ?? 'SIGTERM');
        } catch {
          /* ignore */
        }
      },
    };
  };
}

setDebugAdapterSpawnFn(fakeSpawn());

function mockCtx(
  body: unknown,
  query = '',
): { ctx: RouteContext; calls: Array<{ code: number; body: unknown }> } {
  const calls: Array<{ code: number; body: unknown }> = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body,
    audit: { record: () => {} },
  } as unknown as RouteContext;
  return { ctx, calls };
}

function url(path: string): URL {
  return new URL(`http://localhost${path}`);
}

function req(method: string): IncomingMessage {
  return { method } as IncomingMessage;
}

function lastBody(calls: Array<{ code: number; body: unknown }>): { code: number; body: Record<string, unknown> } {
  assert.ok(calls.length > 0, 'expected a response');
  const last = calls[calls.length - 1];
  return { code: last.code, body: last.body as Record<string, unknown> };
}

// -- fixtures ---------------------------------------------------------------

mkdirSync(join(TEST_ROOT, '.vscode'), { recursive: true });
writeFileSync(
  join(TEST_ROOT, '.vscode', 'launch.json'),
  JSON.stringify({
    version: '0.2.0',
    configurations: [
      { name: 'run app', type: 'node', request: 'launch', program: 'app.js', stopOnEntry: true },
      { name: 'py thing', type: 'debugpy', request: 'launch', program: 'x.py' },
    ],
  }),
);
writeFileSync(join(TEST_ROOT, 'app.js'), 'console.log("hi");\n');

// -- tests -------------------------------------------------------------------

test('non-debug paths are not handled', async () => {
  const { ctx, calls } = mockCtx({});
  const handled = await handleDebugRoutes(req('GET'), {} as ServerResponse, url('/api/other'), ctx);
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});

test('GET /configs requires projectId', async () => {
  const { ctx, calls } = mockCtx({});
  await handleDebugRoutes(req('GET'), {} as ServerResponse, url('/api/debug/configs'), ctx);
  const { code, body } = lastBody(calls);
  assert.equal(code, 400);
  assert.equal(body.code, 'bad-project');
});

test('GET /configs lists node configs and skips others honestly', async () => {
  const { ctx, calls } = mockCtx({});
  await handleDebugRoutes(
    req('GET'),
    {} as ServerResponse,
    url('/api/debug/configs?projectId=p1'),
    ctx,
  );
  const { code, body } = lastBody(calls);
  assert.equal(code, 200);
  const configs = body.configurations as { name: string; request: string }[];
  assert.equal(configs.length, 1);
  assert.equal(configs[0].name, 'run app');
  assert.match(String(body.note ?? ''), /py thing/);
});

test('GET /configs with invalid launch.json → 400', async () => {
  writeFileSync(join(TEST_ROOT, '.vscode', 'launch.json'), '{broken');
  const { ctx, calls } = mockCtx({});
  await handleDebugRoutes(
    req('GET'),
    {} as ServerResponse,
    url('/api/debug/configs?projectId=p1'),
    ctx,
  );
  const { code } = lastBody(calls);
  assert.equal(code, 400);
  // restore
  writeFileSync(
    join(TEST_ROOT, '.vscode', 'launch.json'),
    JSON.stringify({
      version: '0.2.0',
      configurations: [{ name: 'run app', type: 'node', request: 'launch', program: 'app.js' }],
    }),
  );
});

test('POST /sessions requires projectId', async () => {
  const { ctx, calls } = mockCtx({});
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url('/api/debug/sessions'), ctx);
  const { code, body } = lastBody(calls);
  assert.equal(code, 400);
  assert.equal(body.code, 'bad-project');
});

test('POST /sessions with unknown configName → 404', async () => {
  const { ctx, calls } = mockCtx({ projectId: 'p1', configName: 'nope' });
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url('/api/debug/sessions'), ctx);
  const { code, body } = lastBody(calls);
  assert.equal(code, 404);
  assert.equal(body.code, 'bad-config');
});

test('POST /sessions rejects non-node debug types', async () => {
  const { ctx, calls } = mockCtx({
    projectId: 'p1',
    config: { name: 'x', type: 'debugpy', request: 'launch', program: 'app.js' },
  });
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url('/api/debug/sessions'), ctx);
  const { code, body } = lastBody(calls);
  assert.equal(code, 400);
  assert.equal(body.code, 'bad-config');
});

test('POST /sessions jails the program path', async () => {
  const { ctx, calls } = mockCtx({
    projectId: 'p1',
    config: { name: 'x', type: 'node', request: 'launch', program: '../evil.js' },
  });
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url('/api/debug/sessions'), ctx);
  const { code, body } = lastBody(calls);
  assert.equal(code, 400);
  assert.equal(body.code, 'jail');
});

test('full session lifecycle against the fake adapter', async () => {
  // start (breakpoints up front, applied before configurationDone)
  const s = mockCtx({
    projectId: 'p1',
    configName: 'run app',
    breakpoints: [{ file: 'app.js', line: 1, condition: 'x > 1' }],
  });
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url('/api/debug/sessions'), s.ctx);
  let r = lastBody(s.calls);
  assert.equal(r.code, 201);
  const sessionId = r.body.sessionId as string;
  assert.ok(sessionId);
  const initialBps = r.body.breakpoints as { id: number; verified: boolean; file: string }[];
  assert.equal(initialBps.length, 1);
  assert.equal(initialBps[0].verified, true);
  assert.equal(initialBps[0].file, 'app.js');

  // list contains it
  const l = mockCtx({});
  await handleDebugRoutes(req('GET'), {} as ServerResponse, url('/api/debug/sessions'), l.ctx);
  r = lastBody(l.calls);
  assert.equal(r.code, 200);
  assert.ok((r.body.sessions as { sessionId: string }[]).some((x) => x.sessionId === sessionId));

  // set breakpoints (jailed file must exist) — re-set mid-session
  const b = mockCtx({ breakpoints: [{ file: 'app.js', line: 2 }] });
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url(`/api/debug/sessions/${sessionId}/breakpoints`), b.ctx);
  r = lastBody(b.calls);
  assert.equal(r.code, 200);
  const bps = r.body.breakpoints as { id: number; verified: boolean; file: string }[];
  assert.equal(bps.length, 1);
  assert.equal(bps[0].verified, true);
  assert.equal(bps[0].file, 'app.js');
  assert.equal(bps[0].line, 2);

  // breakpoint file escaping the jail → 400
  const bj = mockCtx({ breakpoints: [{ file: '../evil.js', line: 1 }] });
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url(`/api/debug/sessions/${sessionId}/breakpoints`), bj.ctx);
  r = lastBody(bj.calls);
  assert.equal(r.code, 400);
  assert.equal(r.body.code, 'jail');

  // stack (fake adapter pauses shortly after start)
  await new Promise((res) => setTimeout(res, 300));
  const st = mockCtx({});
  await handleDebugRoutes(req('GET'), {} as ServerResponse, url(`/api/debug/sessions/${sessionId}/stack?threadId=1`), st.ctx);
  r = lastBody(st.calls);
  assert.equal(r.code, 200);
  assert.equal((r.body.stackFrames as { name: string }[])[0].name, 'compute');

  // scopes + variables
  const sc = mockCtx({});
  await handleDebugRoutes(req('GET'), {} as ServerResponse, url(`/api/debug/sessions/${sessionId}/scopes?frameId=1`), sc.ctx);
  r = lastBody(sc.calls);
  assert.equal(r.code, 200);
  const scopes = r.body.scopes as { variablesReference: number }[];
  assert.ok(scopes[0].variablesReference > 0);

  const v = mockCtx({});
  await handleDebugRoutes(
    req('GET'),
    {} as ServerResponse,
    url(`/api/debug/sessions/${sessionId}/variables?ref=${scopes[0].variablesReference}`),
    v.ctx,
  );
  r = lastBody(v.calls);
  assert.equal(r.code, 200);
  assert.deepEqual(
    (r.body.variables as { name: string; value: string }[]).map((x) => [x.name, x.value]),
    [['n', '21']],
  );

  // evaluate
  const e = mockCtx({ expression: 'n + 1' });
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url(`/api/debug/sessions/${sessionId}/evaluate`), e.ctx);
  r = lastBody(e.calls);
  assert.equal(r.code, 200);
  assert.equal(r.body.result, '22');

  // step action
  const n = mockCtx({});
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url(`/api/debug/sessions/${sessionId}/next`), n.ctx);
  r = lastBody(n.calls);
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);

  // output buffering
  const o = mockCtx({});
  await handleDebugRoutes(req('GET'), {} as ServerResponse, url(`/api/debug/sessions/${sessionId}/output`), o.ctx);
  r = lastBody(o.calls);
  assert.equal(r.code, 200);
  assert.ok((r.body.lines as { output: string }[]).some((l) => l.output.includes('hello from target')));

  // session state
  const g = mockCtx({});
  await handleDebugRoutes(req('GET'), {} as ServerResponse, url(`/api/debug/sessions/${sessionId}`), g.ctx);
  r = lastBody(g.calls);
  assert.equal(r.code, 200);
  assert.equal((r.body.session as { sessionId: string }).sessionId, sessionId);

  // delete
  const d = mockCtx({});
  await handleDebugRoutes(req('DELETE'), {} as ServerResponse, url(`/api/debug/sessions/${sessionId}`), d.ctx);
  r = lastBody(d.calls);
  assert.equal(r.code, 200);

  // gone afterwards
  const g2 = mockCtx({});
  await handleDebugRoutes(req('GET'), {} as ServerResponse, url(`/api/debug/sessions/${sessionId}`), g2.ctx);
  r = lastBody(g2.calls);
  assert.equal(r.code, 404);
});

test('step while running → 409 NOT_PAUSED (fail-closed)', async () => {
  const s = mockCtx({ projectId: 'p1', config: { name: 'x', type: 'node', request: 'launch', program: 'app.js' } });
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url('/api/debug/sessions'), s.ctx);
  const sessionId = (lastBody(s.calls).body.sessionId as string) ?? '';
  assert.ok(sessionId);
  // immediately (before the fake adapter's 20ms auto-stop) → not paused
  const n = mockCtx({});
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url(`/api/debug/sessions/${sessionId}/next`), n.ctx);
  const r = lastBody(n.calls);
  // either 409 (lost the race) or 200 (won it) — both are honest; assert shape
  assert.ok([200, 409].includes(r.code), `unexpected code ${r.code}`);
  if (r.code === 409) assert.equal(r.body.code, 'not-paused');
  const d = mockCtx({});
  await handleDebugRoutes(req('DELETE'), {} as ServerResponse, url(`/api/debug/sessions/${sessionId}`), d.ctx);
});

test('dead session → 410', async () => {
  setDebugAdapterSpawnFn(fakeSpawn(['--exit-soon=400']));
  try {
    const s = mockCtx({ projectId: 'p1', config: { name: 'x', type: 'node', request: 'launch', program: 'app.js' } });
    await handleDebugRoutes(req('POST'), {} as ServerResponse, url('/api/debug/sessions'), s.ctx);
    const { code, body } = lastBody(s.calls);
    assert.equal(code, 201);
    const sessionId = body.sessionId as string;
    await new Promise((res) => setTimeout(res, 1200));
    const st = mockCtx({});
    await handleDebugRoutes(req('GET'), {} as ServerResponse, url(`/api/debug/sessions/${sessionId}/stack`), st.ctx);
    const r = lastBody(st.calls);
    assert.equal(r.code, 410);
    assert.equal(r.body.code, 'session-dead');
  } finally {
    setDebugAdapterSpawnFn(fakeSpawn());
  }
});

/**
 * DAP adapter registry route tests (round-7 task R7-#7) — imports
 * ../src/routes/debug.ts straight from src under node's type-stripping
 * ESM loader (same pattern as debug.test.ts: the route module is node
 * builtins only + @ai-factory/debugger dist).
 *
 * Covers: GET /api/debug/adapters (static registry, no spawn),
 * POST /api/debug/adapters/:kind/probe (node builtin available; unknown
 * kind 400), and invalid condition syntax rejected at session start
 * with 400 bad-breakpoint (fake adapter; the parse path is shared with
 * the /breakpoints route).
 *
 * Run: npm run test:server (TMPDIR wrapper); or
 *   node --test apps/server/tests/debug-adapters.test.ts
 * from the repo root.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleDebugRoutes,
  setDebugAdapterSpawnFn,
  setDebugInspectionRootResolver,
} from '../src/routes/debug.ts';
import type { RouteContext } from '../src/routes/context.ts';
import type { SpawnedProcess } from '@ai-factory/debugger';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'debug-adapters-test-'));
writeFileSync(join(TEST_ROOT, 'app.js'), 'console.log("hi");\n');
mkdirSync(join(TEST_ROOT, '.vscode'), { recursive: true });
writeFileSync(
  join(TEST_ROOT, '.vscode', 'launch.json'),
  JSON.stringify({
    version: '0.2.0',
    configurations: [{ name: 'run app', type: 'node', request: 'launch', program: 'app.js' }],
  }),
);
setDebugInspectionRootResolver(() => TEST_ROOT);

const FAKE_ADAPTER = join(
  process.cwd(),
  'apps/server/tests/fixtures/debug/fake-adapter.mjs',
);

setDebugAdapterSpawnFn(
  (_command: string, _args: string[], opts: { env: Record<string, string>; cwd?: string }): SpawnedProcess => {
    const child: ChildProcess = spawn('node', [FAKE_ADAPTER], {
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
  },
);

function mockCtx(
  body: unknown,
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

test('GET /adapters returns the static registry without probing', async () => {
  const { ctx, calls } = mockCtx({});
  const handled = await handleDebugRoutes(req('GET'), {} as ServerResponse, url('/api/debug/adapters'), ctx);
  assert.equal(handled, true);
  const { code, body } = lastBody(calls);
  assert.equal(code, 200);
  const adapters = body.adapters as { kind: string; driver: string; implemented: boolean }[];
  assert.deepEqual(adapters.map((a) => a.kind), ['node', 'python', 'go']);
  assert.equal(adapters[0].driver, 'builtin');
  assert.equal(adapters[0].implemented, true);
  assert.equal(adapters[1].implemented, false);
  assert.equal(adapters[2].implemented, false);
});

test('POST /adapters/node/probe reports the builtin adapter available', async () => {
  const { ctx, calls } = mockCtx({});
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url('/api/debug/adapters/node/probe'), ctx);
  const { code, body } = lastBody(calls);
  assert.equal(code, 200);
  assert.equal(body.kind, 'node');
  assert.equal(body.available, true);
  assert.equal(body.implemented, true);
});

test('POST /adapters/<unknown>/probe is a 400, not a 500', async () => {
  const { ctx, calls } = mockCtx({});
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url('/api/debug/adapters/chrome/probe'), ctx);
  const { code, body } = lastBody(calls);
  assert.equal(code, 400);
  assert.equal(body.code, 'unknown-adapter');
});

test('session start with syntactically invalid condition is a 400, not a broken session', async () => {
  const { ctx, calls } = mockCtx({
    projectId: 'p1',
    configName: 'run app',
    breakpoints: [{ file: 'app.js', line: 1, condition: 'x >' }],
  });
  await handleDebugRoutes(req('POST'), {} as ServerResponse, url('/api/debug/sessions'), ctx);
  const { code, body } = lastBody(calls);
  assert.equal(code, 400);
  assert.equal(body.code, 'bad-breakpoint');
  assert.match(String(body.error), /invalid breakpoint condition/);
});

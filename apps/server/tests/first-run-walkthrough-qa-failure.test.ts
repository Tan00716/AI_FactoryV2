/**
 * Walkthrough: QA failure-path leg (Batch 60).
 *
 * Batch 59-3 fixed a real whole-tree crash (F44): when a QA run failed
 * because `loop.execute(factory)` threw, the server wrote
 * `record.summary = { error: message }`, and QaPanel's
 * `{run.summary && ...}` guard let the `{error}` object through — then
 * `run.summary.categories.map` crashed on `undefined` and the whole
 * React tree unmounted. The fix normalizes the failure summary to the
 * success shape (`total/passed/failed/skipped: 0`, `categories: []`,
 * `failures: []`) plus an `error` field, and the panel renders a red
 * pill with `?? []` guards.
 *
 * This leg pins the *server side* of that fix end to end: the real
 * compiled server process, pure HTTP, zero mocks, fresh temp SQLite.
 * The panel-side rendering (red pill) was pinned by the b58-2
 * `orgErr` walkthrough pattern and is not re-proven here; what this
 * leg proves is the contract the panel relies on.
 *
 *   A. failure: boot the server with TMPDIR pointing *under a regular
 *      file* — a real, deterministic environment failure (ENOTDIR).
 *      POST /api/qa/runs: attempt 1 hits the intentional off-by-one in
 *      the demo sample (classified PRODUCT_FAILURE) → onFixNeeded →
 *      autoFixSample → mkdir fails → the qa.ts catch writes the
 *      normalized failure summary. Assert: status FAILED; the summary
 *      is exactly the success shape with zeros/empty arrays plus a
 *      non-empty string `error` naming the qa-run dir;
 *      Array.isArray(summary.categories) (the panel's `categories.map`
 *      contract); the record is retrievable via GET /api/qa/runs/:id.
 *   B. success control: boot with a normal TMPDIR and run the same QA:
 *      the auto-fix applies, attempt 2 passes, the §38 regression
 *      re-run passes, verdict PASS. Assert the failure summary's key
 *      set equals the success summary's key set plus 'error', and the
 *      success summary has no 'error' key.
 *
 * Requires the workspace build (root `npm run build`): boots
 * ../dist/index.js. Hermetic: temp DB_PATH + temp FACTORY_SECRETS_DIR
 * + temp FACTORY_PROJECTS_ROOT per leg, no API tokens. Dual-mode: node
 * builtins + fetch only, zero src imports.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

const children: ChildProcess[] = [];
after(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      // already dead
    }
  }
});

interface Booted {
  child: ChildProcess;
  port: number;
}

/** Boot the real server against the given DB file (real startup path). */
async function bootServer(
  dir: string,
  dbFile: string,
  extraEnv: Record<string, string> = {},
): Promise<Booted> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    // Hermetic secrets vault + project root (fail-closed without them).
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
    FACTORY_PROJECTS_ROOT: join(dir, 'projects'),
    ...extraEnv,
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
  // The QA loop spawns `node --test` child processes (shellRunner). Under
  // `node --test`, the runner exports NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID
  // and a child `node --test` refuses to run ("recursively within a test
  // file"). The server under test must not inherit the test-runner context
  // — production never has these vars. This is env hygiene, not a mock.
  delete env['NODE_TEST_CONTEXT'];
  delete env['NODE_TEST_WORKER_ID'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  children.push(child);
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Stop the server and wait for the process to actually exit. */
async function stopServer(child: ChildProcess): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    // already dead
  }
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() > deadline) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

type Json = Record<string, unknown>;

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: parsed };
}

async function createTask(port: number): Promise<string> {
  const p = await api(port, 'POST', '/api/projects', { name: 'qa-fail-walk' });
  assert.equal(p.status, 201);
  const t = await api(port, 'POST', '/api/tasks', {
    projectId: p.body['id'],
    title: 'qa failure-path walkthrough',
  });
  assert.equal(t.status, 201);
  return t.body['id'] as string;
}

/** The normalized failure summary the F44 fix guarantees. */
function assertFailureSummary(summary: unknown): void {
  assert.equal(typeof summary, 'object');
  assert.ok(summary !== null);
  const s = summary as Record<string, unknown>;
  assert.equal(s['total'], 0);
  assert.equal(s['passed'], 0);
  assert.equal(s['failed'], 0);
  assert.equal(s['skipped'], 0);
  assert.deepEqual(s['categories'], []);
  assert.deepEqual(s['failures'], []);
  // The panel's categories.map contract: must be a real array.
  assert.ok(Array.isArray(s['categories']));
  assert.equal(typeof s['error'], 'string');
  assert.ok((s['error'] as string).length > 0);
  // Proves the failure really came from the auto-fix step (not a mock):
  // the error names the qa-run temp dir that could not be created.
  assert.ok((s['error'] as string).includes('qa-run-'));
}

describe('walkthrough: QA failure-path leg', () => {
  it('A: failed QA run → normalized failure summary (F44 server side)', async () => {
    // $HOME scratch: this machine's /tmp is a 512MB tmpfs (F45).
    const dir = mkdtempSync(join(homedir(), 'qa-fail-walk-'));
    // A regular file: TMPDIR under it makes mkdir throw ENOTDIR —
    // a real, deterministic environment failure.
    writeFileSync(join(dir, 'not-a-dir'), '');
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'), {
      TMPDIR: join(dir, 'not-a-dir', 'qa'),
    });
    try {
      const taskId = await createTask(port);
      const r = await api(port, 'POST', '/api/qa/runs', { taskId });
      assert.equal(r.status, 200);
      const run = r.body['run'] as Record<string, unknown>;
      assert.equal(run['status'], 'FAILED');
      assert.ok(typeof run['finishedAt'] === 'string');
      assertFailureSummary(run['summary']);

      // The failed record is retrievable with the same normalized shape.
      const g = await api(port, 'GET', `/api/qa/runs/${run['id']}`);
      assert.equal(g.status, 200);
      const got = g.body['run'] as Record<string, unknown>;
      assert.equal(got['id'], run['id']);
      assertFailureSummary(got['summary']);
    } finally {
      await stopServer(child);
    }
  });

  it('B: success control → failure key set == success key set + error', async () => {
    const dir = mkdtempSync(join(homedir(), 'qa-ok-walk-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      const taskId = await createTask(port);
      const r = await api(port, 'POST', '/api/qa/runs', { taskId });
      assert.equal(r.status, 200);
      const run = r.body['run'] as Record<string, unknown>;
      // Auto-fix applies on the PRODUCT_FAILURE, attempt 2 passes,
      // then the §38 regression re-run: verdict PASS.
      assert.equal(run['status'], 'COMPLETED');
      assert.equal(run['verdict'], 'PASS');
      const summary = run['summary'] as Record<string, unknown>;
      assert.deepEqual(Object.keys(summary).sort(), [
        'categories',
        'failed',
        'failures',
        'passed',
        'skipped',
        'total',
      ]);
      assert.ok(!('error' in summary));
      assert.ok((summary['total'] as number) > 0);

      // Same run via the list endpoint: still no error key.
      const l = await api(port, 'GET', '/api/qa/runs');
      assert.equal(l.status, 200);
      const runs = l.body['runs'] as Record<string, unknown>[];
      assert.ok(runs.length >= 1);
      const listed = runs.find((x) => x['id'] === run['id']) as Record<string, unknown>;
      assert.ok(listed);
      assert.ok(!('error' in (listed['summary'] as Record<string, unknown>)));
    } finally {
      await stopServer(child);
    }
  });

  it('C: failure summary key set == success summary key set + error', async () => {
    // Re-runs A+B minimally to pin the key-set relationship on one
    // fresh pair of boots (shape drift in either direction fails here).
    const failDir = mkdtempSync(join(homedir(), 'qa-fail-walk-'));
    writeFileSync(join(failDir, 'not-a-dir'), '');
    const fail = await bootServer(failDir, join(failDir, 'factory.db'), {
      TMPDIR: join(failDir, 'not-a-dir', 'qa'),
    });
    let failKeys: string[];
    try {
      const taskId = await createTask(fail.port);
      const r = await api(fail.port, 'POST', '/api/qa/runs', { taskId });
      const run = r.body['run'] as Record<string, unknown>;
      assert.equal(run['status'], 'FAILED');
      failKeys = Object.keys(run['summary'] as Record<string, unknown>).sort();
    } finally {
      await stopServer(fail.child);
    }
    const okDir = mkdtempSync(join(homedir(), 'qa-ok-walk-'));
    const ok = await bootServer(okDir, join(okDir, 'factory.db'));
    let okKeys: string[];
    try {
      const taskId = await createTask(ok.port);
      const r = await api(ok.port, 'POST', '/api/qa/runs', { taskId });
      const run = r.body['run'] as Record<string, unknown>;
      assert.equal(run['verdict'], 'PASS');
      okKeys = Object.keys(run['summary'] as Record<string, unknown>).sort();
    } finally {
      await stopServer(ok.child);
    }
    assert.deepEqual(failKeys!, [...okKeys!, 'error'].sort());
  });
});

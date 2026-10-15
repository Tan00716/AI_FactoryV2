/**
 * Regression: /api/profiles scope gate (Batch 66-3 walkthrough find).
 *
 * What this pins, end to end (real compiled server process, pure
 * HTTP, zero mocks, fresh temp SQLite):
 *
 *   A. GET /api/profiles (agent leaderboard) returns 200 with a
 *      {profiles: [...]} body — the evaluation route handler's scope
 *      gate lets /api/profiles through to the handler below it.
 *   B. GET /api/profiles/<unknown-agent> reaches the :agentId matcher
 *      and returns the handler's own 404 message
 *      ("no evaluations recorded for this agent"), not the generic
 *      router "Not found" — i.e. the sub-path is also in scope.
 *
 * Background: handleEvaluationRoutes owned the /api/profiles handlers
 * (documented in its own file header and implemented below the gate)
 * but its inScope gate only admitted /api/evaluations, /api/proposals
 * and /api/loops — so the leaderboard endpoint always 404'd. The
 * desktop EvaluationPanel caught it as a red "Not found" banner and
 * its "Agent leaderboard" section could never load. Found by the
 * Batch 66-3 desktop remaining-panels live walkthrough (real
 * Electron+Xvfb+vite dev+real server).
 *
 * Requires the workspace build (root `npm run build`): boots
 * ../dist/index.js. Hermetic: temp DB_PATH + temp FACTORY_SECRETS_DIR
 * + temp FACTORY_PROJECTS_ROOT per leg, no API tokens. Dual-mode: node
 * builtins + fetch only, zero src imports.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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

/** Boot the real server against the given DB file (real startup path). */
async function bootServer(
  dir: string,
  dbFile: string,
): Promise<{ child: ChildProcess; port: number }> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    // Hermetic secrets vault + project root (fail-closed without them).
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
    FACTORY_PROJECTS_ROOT: join(dir, 'projects'),
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
  // Keep the boot clean of test-runner context (production never has it).
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
    return;
  }
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (Date.now() > deadline) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already dead
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('evaluation /api/profiles scope gate (walkthrough regression)', () => {
  it('A: GET /api/profiles returns 200 with a profiles array (not generic 404)', async () => {
    const dir = mkdtempSync(join(homedir(), 'b66-3-profiles-a-'));
    const { child, port } = await bootServer(dir, join(dir, 'db.sqlite'));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/profiles`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { profiles?: unknown };
      assert.ok(Array.isArray(body.profiles), 'expected {profiles: []}');
    } finally {
      await stopServer(child);
    }
  });

  it('B: GET /api/profiles/<unknown> reaches the :agentId matcher (handler 404, not router 404)', async () => {
    const dir = mkdtempSync(join(homedir(), 'b66-3-profiles-b-'));
    const { child, port } = await bootServer(dir, join(dir, 'db.sqlite'));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/profiles/does-not-exist`);
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, 'no evaluations recorded for this agent');
    } finally {
      await stopServer(child);
    }
  });
});

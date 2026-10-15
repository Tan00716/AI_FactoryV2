/**
 * Walkthrough: exec confinement leg (Batch 63, G8 / INV-15).
 *
 * What this pins, end to end (real compiled server process, pure
 * HTTP, zero mocks, fresh temp SQLite):
 *
 *   A. An autonomous (non-human) actor is refused fail-closed on
 *      POST /api/exec: 403 with code CONFINEMENT_UNAVAILABLE, an
 *      EXEC_DENIED audit record whose details carry
 *      reason=CONFINEMENT_UNAVAILABLE, and NO EXEC_RUN record —
 *      the command never executed.
 *   B. The human path is unaffected: the same whitelisted command
 *      with actor 'human' runs and returns its output.
 *   C. Fail-closed ordering: a non-human actor sending a
 *      *policy-violating* command still gets CONFINEMENT_UNAVAILABLE
 *      (not the policy refusal) — the confinement check precedes the
 *      shared command-policy check, so autonomy denial is the
 *      first gate, never the second.
 *
 * Honest boundary: this pins the *refusal*. Nothing here proves
 * real OS-level confinement of a subprocess — there is no universal
 * isolation Host on this machine (the known hard gate). The
 * UnverifiedBackend always reports verified:false and the server
 * refuses outright rather than pretending an OS boundary exists
 * (see packages/security/src/isolation.ts: LocalDevBackend lists
 * its limitations, including §7.3 "agent subprocesses inherit the
 * host user principal" and TOCTOU on path checks).
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

async function post(port: number, path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

interface AuditRecord {
  action: string;
  actor: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}

async function auditRecords(port: number): Promise<AuditRecord[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/audit?limit=200`);
  assert.equal(res.status, 200, 'GET /api/audit');
  const list = (await res.json()) as unknown;
  assert.ok(Array.isArray(list), '/api/audit returns a bare array');
  return list as AuditRecord[];
}

describe('exec confinement (G8 / INV-15)', () => {
  it('A: autonomous actor is refused fail-closed with CONFINEMENT_UNAVAILABLE', async () => {
    // $HOME, not /tmp (512MB tmpfs on this machine; see F45).
    const dir = mkdtempSync(join(homedir(), 'exec-confine-a-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      const cmd = 'echo confinement-probe-agent';
      const r = await post(port, '/api/exec', { command: cmd, actor: 'agent' });
      assert.equal(r.status, 403, 'non-human /api/exec must be 403');
      assert.equal(r.json['code'], 'CONFINEMENT_UNAVAILABLE');
      assert.match(String(r.json['error']), /CONFINEMENT_UNAVAILABLE/);
      // The error names the backend's inability to prove confinement.
      assert.match(String(r.json['error']), /unverified/);

      const records = await auditRecords(port);
      const denied = records.find(
        (rec) =>
          rec.action === 'EXEC_DENIED' &&
          rec.actor === 'agent' &&
          rec.entityType === 'exec',
      );
      assert.ok(denied, 'an EXEC_DENIED audit record must exist for the agent');
      assert.equal(denied.entityId, cmd.slice(0, 80));
      assert.equal(denied.details?.['reason'], 'CONFINEMENT_UNAVAILABLE');

      // The probe must never have executed: no EXEC_RUN anywhere.
      const runs = records.filter(
        (rec) => rec.action === 'EXEC_RUN' && rec.entityType === 'exec',
      );
      assert.equal(runs.length, 0, 'no EXEC_RUN records — nothing executed');
    } finally {
      await stopServer(child);
    }
  });

  it('B: the human path is unaffected by the confinement refusal', async () => {
    const dir = mkdtempSync(join(homedir(), 'exec-confine-b-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      const r = await post(port, '/api/exec', {
        command: 'echo human-still-runs',
        actor: 'human',
      });
      assert.equal(r.status, 200, 'human /api/exec must keep working');
      assert.equal(r.json['ok'], true);
      assert.match(String(r.json['output']), /human-still-runs/);
    } finally {
      await stopServer(child);
    }
  });

  it('C: confinement is the first gate, before the command policy', async () => {
    const dir = mkdtempSync(join(homedir(), 'exec-confine-c-'));
    const { child, port } = await bootServer(dir, join(dir, 'factory.db'));
    try {
      // `rm` matches a deny pattern — the refusal must still be the
      // confinement one, proving ordering: autonomy denial precedes
      // policy evaluation.
      const r = await post(port, '/api/exec', {
        command: 'rm -rf /tmp/should-never-run',
        actor: 'agent',
      });
      assert.equal(r.status, 403, 'non-human /api/exec must be 403');
      assert.equal(r.json['code'], 'CONFINEMENT_UNAVAILABLE');
    } finally {
      await stopServer(child);
    }
  });
});

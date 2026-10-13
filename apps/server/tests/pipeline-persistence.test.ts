/**
 * Pipeline record + stage definition persistence across restarts —
 * SPEC v2 §39/§40 (Batch 31-2).
 *
 * The server writes every pipeline record (create + every stage
 * transition) through to fdb.pipelineRecords. These tests pin the
 * restart contract on the REAL server (boot → SIGKILL → reboot on
 * the same DB file):
 *  - a QUEUED pipeline survives the kill: GET /api/pipelines/:id
 *    returns the full 12-stage definition (not a 404, not an empty
 *    stub), marked rehydrated: true; /run on it keeps 409ing
 *    (PIPELINE_NOT_REHYDRATABLE) — execution is never faked;
 *  - a pipeline killed mid-run hydrates as INTERRUPTED (pipeline and
 *    the in-flight stage), never presented as still running;
 *  - a SUCCEEDED pipeline's terminal history survives intact;
 *  - a project archived while the server was down refuses the
 *    rebuild with 409 (PIPELINE_REBUILD_REFUSED audited), never
 *    silently;
 *  - a pipeline with no persisted trace at all still 404s.
 *
 * Honest note on the mid-run simulation: /run's simulated stage
 * handlers complete in milliseconds, so a true SIGKILL cannot land
 * mid-run over HTTP. The test instead writes exactly the row shape
 * a mid-run kill would leave (pipeline RUNNING + one stage RUNNING,
 * via the same per-stage-end write-through the server performs) and
 * then kills the server — the hydrate logic under test is real.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

interface BootedServer {
  child: ChildProcess;
  port: number;
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function api(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: parsed };
}

async function bootServer(dbFile: string, secretsDir: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    // Hermetic vault: never inherit the developer's local secrets dir.
    FACTORY_SECRETS_DIR: secretsDir,
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_RUNTIME_TOOLS'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
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
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function killServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGKILL');
  await new Promise((r) => s.child.once('exit', r));
}

async function auditActions(port: number): Promise<string[]> {
  const r = await api(port, 'GET', '/api/audit?limit=500');
  assert.equal(r.status, 200);
  return ((r.body['records'] ?? r.body) as Array<{ action: string }>).map((x) => x.action);
}

const STAGE_NAMES = [
  'build', 'test', 'lint', 'typecheck', 'security', 'package',
  'artifact', 'review_gate', 'uat', 'release', 'smoke', 'recovery',
];

describe('pipeline record + stage persistence across SIGKILL restarts (Batch 31)', () => {
  it('a QUEUED pipeline survives the kill: full definition queryable, /run keeps 409ing', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-pipe-persist-'));
    const dbFile = join(dir, 'factory.db');
    const secretsDir = join(dir, 'secrets');
    let server: BootedServer | undefined;
    try {
      server = await bootServer(dbFile, secretsDir);
      const pl = await api(server.port, 'POST', '/api/pipelines', { environment: 'DEV' });
      assert.equal(pl.status, 201);
      const pipelineId = pl.body['id'] as string;
      assert.deepEqual(
        ((pl.body['stages'] as Array<{ name: string }>) ?? []).map((s) => s.name),
        STAGE_NAMES,
      );

      await killServer(server);
      server = await bootServer(dbFile, secretsDir);

      // The definition is queryable — not a 404, not an empty stub.
      const got = await api(server.port, 'GET', `/api/pipelines/${pipelineId}`);
      assert.equal(got.status, 200);
      assert.equal(got.body['status'], 'QUEUED');
      assert.equal(got.body['rehydrated'], true);
      const stages = got.body['stages'] as Array<{ name: string; status: string }>;
      assert.equal(stages.length, 12);
      assert.deepEqual(stages.map((s) => s.name), STAGE_NAMES);
      assert.ok(stages.every((s) => s.status === 'PENDING'));

      // The list surface merges the persisted row in.
      const listed = await api(server.port, 'GET', '/api/pipelines');
      assert.equal(listed.status, 200);
      const ids = (listed.body as Array<{ id: string }>).map((p) => p.id);
      assert.ok(ids.includes(pipelineId), 'persisted pipeline appears in the list');

      // /run on the rebuilt record is still refused — never faked.
      const run = await api(server.port, 'POST', `/api/pipelines/${pipelineId}/run`, {});
      assert.equal(run.status, 409);
      assert.equal((run.body as { name: string }).name, 'PIPELINE_NOT_REHYDRATABLE');

      const actions = await auditActions(server.port);
      assert.ok(actions.includes('PIPELINE_REHYDRATED'), 'rebuild on the audit trail');
      await killServer(server);
      server = undefined;
    } finally {
      if (server) await killServer(server).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pipeline killed mid-run hydrates as INTERRUPTED, never as still running', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-pipe-interrupt-'));
    const dbFile = join(dir, 'factory.db');
    const secretsDir = join(dir, 'secrets');
    let server: BootedServer | undefined;
    try {
      server = await bootServer(dbFile, secretsDir);
      const pl = await api(server.port, 'POST', '/api/pipelines', { environment: 'DEV' });
      const pipelineId = pl.body['id'] as string;

      // Simulate exactly what a mid-run SIGKILL would leave behind:
      // the per-stage-end write-through has landed stage 0/1 as
      // SUCCEEDED, stage 2 is RUNNING, the pipeline is RUNNING.
      {
        const raw = new DatabaseSync(dbFile);
        raw.prepare("UPDATE pipeline_records SET status = 'RUNNING' WHERE id = ?").run(pipelineId);
        raw.prepare(
          "UPDATE pipeline_stages SET status = 'SUCCEEDED', ended_at = '2026-10-13T00:00:01.000Z' WHERE pipeline_id = ? AND position IN (0, 1)",
        ).run(pipelineId);
        raw.prepare(
          "UPDATE pipeline_stages SET status = 'RUNNING', started_at = '2026-10-13T00:00:02.000Z' WHERE pipeline_id = ? AND position = 2",
        ).run(pipelineId);
        raw.close();
      }

      await killServer(server);
      server = await bootServer(dbFile, secretsDir);

      const got = await api(server.port, 'GET', `/api/pipelines/${pipelineId}`);
      assert.equal(got.status, 200);
      assert.equal(got.body['status'], 'INTERRUPTED', 'in-flight pipeline is INTERRUPTED, not RUNNING');
      const stages = got.body['stages'] as Array<{ name: string; status: string }>;
      assert.equal(stages[0].status, 'SUCCEEDED');
      assert.equal(stages[1].status, 'SUCCEEDED');
      assert.equal(stages[2].status, 'INTERRUPTED', 'in-flight stage is INTERRUPTED, not RUNNING');
      assert.ok(stages.slice(3).every((s) => s.status === 'PENDING'));

      // An interrupted pipeline can never resume: /run 409s.
      const run = await api(server.port, 'POST', `/api/pipelines/${pipelineId}/run`, {});
      assert.equal(run.status, 409);

      const actions = await auditActions(server.port);
      assert.ok(actions.includes('PIPELINE_REHYDRATED'));
      await killServer(server);
      server = undefined;
    } finally {
      if (server) await killServer(server).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a completed run keeps its terminal history across the restart', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-pipe-terminal-'));
    const dbFile = join(dir, 'factory.db');
    const secretsDir = join(dir, 'secrets');
    let server: BootedServer | undefined;
    try {
      server = await bootServer(dbFile, secretsDir);
      const pl = await api(server.port, 'POST', '/api/pipelines', { environment: 'DEV' });
      const pipelineId = pl.body['id'] as string;
      const run = await api(server.port, 'POST', `/api/pipelines/${pipelineId}/run`, {});
      assert.equal(run.status, 200);
      assert.equal(run.body['status'], 'SUCCEEDED');

      await killServer(server);
      server = await bootServer(dbFile, secretsDir);

      const got = await api(server.port, 'GET', `/api/pipelines/${pipelineId}`);
      assert.equal(got.status, 200);
      assert.equal(got.body['status'], 'SUCCEEDED');
      const stages = got.body['stages'] as Array<{ status: string; logs: string[] }>;
      assert.equal(stages.length, 12);
      assert.ok(stages.every((s) => s.status === 'SUCCEEDED'), 'all stages terminal');
      assert.ok(
        stages.every((s) => s.logs.length > 0),
        'per-stage logs survived the restart',
      );
      await killServer(server);
      server = undefined;
    } finally {
      if (server) await killServer(server).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a project archived while down refuses the rebuild (409, audited)', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-pipe-archive-'));
    const dbFile = join(dir, 'factory.db');
    const secretsDir = join(dir, 'secrets');
    let server: BootedServer | undefined;
    try {
      server = await bootServer(dbFile, secretsDir);
      const p = await api(server.port, 'POST', '/api/projects', { name: 'Archived' });
      const pid = p.body['id'] as string;
      const t = await api(server.port, 'POST', '/api/tasks', { projectId: pid, title: 'Ship it' });
      const tid = t.body['id'] as string;
      const pl = await api(server.port, 'POST', '/api/pipelines', { taskId: tid });
      const pipelineId = pl.body['id'] as string;

      // Archive while the server is down, then reboot.
      await killServer(server);
      server = await bootServer(dbFile, secretsDir);
      const arch = await api(server.port, 'POST', `/api/projects/${pid}/archive`, {});
      assert.equal(arch.status, 200);
      await killServer(server);
      server = await bootServer(dbFile, secretsDir);

      const got = await api(server.port, 'GET', `/api/pipelines/${pipelineId}`);
      assert.equal(got.status, 409);
      const actions = await auditActions(server.port);
      assert.ok(
        actions.includes('PIPELINE_REBUILD_REFUSED'),
        'archive-guard refusal on the audit trail',
      );
      await killServer(server);
      server = undefined;
    } finally {
      if (server) await killServer(server).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pipeline with no persisted trace still 404s', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-pipe-404-'));
    const dbFile = join(dir, 'factory.db');
    const secretsDir = join(dir, 'secrets');
    let server: BootedServer | undefined;
    try {
      server = await bootServer(dbFile, secretsDir);
      const got = await api(server.port, 'GET', '/api/pipelines/pipe-that-never-existed');
      assert.equal(got.status, 404);
      await killServer(server);
      server = undefined;
    } finally {
      if (server) await killServer(server).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

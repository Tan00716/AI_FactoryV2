/**
 * Deployment persistence across restarts — SPEC v2 §41/§77 (Batch 19-1).
 *
 * The server writes every deployment through to fdb.deployments with
 * its reconstructable spec. These tests pin the restart contract on
 * the REAL server (boot → SIGKILL → reboot on the same DB file):
 *  - a parked (AWAITING_APPROVAL) deployment survives the kill:
 *    GET /api/pipelines/:id returns an honest REHYDRATED stub,
 *    GET /api/deployments lists the parked deployment, and
 *    POST /api/pipelines/:id/approve with the persisted approval
 *    ticket REBUILDS the job and completes the deployment to
 *    SUCCEEDED (the old behavior — explicit 404 — is gone for
 *    persisted deployments; DEPLOYMENT_REHYDRATED is on the audit
 *    trail);
 *  - the archive guard is re-validated at rebuild time: a project
 *    archived while the server was down refuses the approve with
 *    409 PROJECT_ARCHIVED (DEPLOYMENT_REBUILD_REFUSED audited),
 *    never silently;
 *  - a pipeline with NO persisted deployments still 404s exactly as
 *    before — rebuild is not a blanket 404 removal.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

async function bootServer(dbFile: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
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

describe('deployment persistence across SIGKILL restarts (Batch 19)', () => {
  it('parked deploy survives the kill: rebuild + approve completes it', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-deploy-persist-'));
    const dbFile = join(dir, 'factory.db');
    let server: BootedServer | undefined;
    try {
      server = await bootServer(dbFile);
      const p = await api(server.port, 'POST', '/api/projects', { name: 'Durable' });
      const pid = p.body['id'] as string;
      const t = await api(server.port, 'POST', '/api/tasks', { projectId: pid, title: 'Ship it' });
      const tid = t.body['id'] as string;
      const pl = await api(server.port, 'POST', '/api/pipelines', { taskId: tid });
      const pipelineId = pl.body['id'] as string;

      const dep = await api(server.port, 'POST', `/api/pipelines/${pipelineId}/deploy`, {
        environment: 'PROD',
        taskId: tid,
        actor: 'deploy-bot',
      });
      assert.equal(dep.status, 200);
      const prodId = (dep.body['deployment'] as Record<string, unknown>)['id'] as string;
      assert.equal((dep.body['deployment'] as Record<string, unknown>)['status'], 'AWAITING_APPROVAL');
      const approvalId = (dep.body['approval'] as Record<string, unknown>)['approval_id'] as string;

      // The approval decision is itself durable (approvals are in the DB).
      const decision = await api(server.port, 'POST', `/api/approvals/${approvalId}/decision`, {
        approved: true,
        decided_by: 'human',
      });
      assert.equal(decision.status, 200);

      await killServer(server);
      server = await bootServer(dbFile);
      const port2 = server.port;

      // The pipeline record is gone from memory but its deployments
      // are durable: GET returns an honest REHYDRATED stub.
      const stub = await api(port2, 'GET', `/api/pipelines/${pipelineId}`);
      assert.equal(stub.status, 200);
      assert.equal(stub.body['rehydrated'], true);

      // The parked deployment is listed cross-restart.
      const list = await api(port2, 'GET', '/api/deployments');
      assert.equal(list.status, 200);
      const listed = (list.body as Array<Record<string, unknown>>).find((d) => d['id'] === prodId);
      assert.ok(listed, 'parked deployment listed after restart');
      assert.equal(listed?.['status'], 'AWAITING_APPROVAL');

      // Approve rebuilds the job from the persisted spec and the
      // deployment REALLY completes.
      const approve = await api(port2, 'POST', `/api/pipelines/${pipelineId}/approve`, {
        approvalId,
      });
      assert.equal(approve.status, 200);
      const resumed = approve.body['deployment'] as Record<string, unknown>;
      assert.equal(resumed['id'], prodId);
      assert.equal(resumed['status'], 'SUCCEEDED');
      assert.equal(resumed['approvalId'], approvalId);
      assert.ok(resumed['startedAt'], 'rebuilt job ran the deploy phase');
      assert.ok(resumed['endedAt'], 'rebuilt job completed');

      const actions = await auditActions(port2);
      assert.ok(actions.includes('DEPLOYMENT_REHYDRATED'), 'rebuild on the audit trail');
      assert.ok(actions.includes('DEPLOY_SUCCEEDED'), 'completion audited');
      assert.ok(actions.includes('DEPLOY_RESUMED'), 'resume audited');

      await killServer(server);
      server = undefined;
    } finally {
      if (server) await killServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a project archived while down refuses the rebuild (409, audited)', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-deploy-archive-'));
    const dbFile = join(dir, 'factory.db');
    let server: BootedServer | undefined;
    try {
      server = await bootServer(dbFile);
      const p = await api(server.port, 'POST', '/api/projects', { name: 'SoonArchived' });
      const pid = p.body['id'] as string;
      const t = await api(server.port, 'POST', '/api/tasks', { projectId: pid, title: 'Ship it' });
      const tid = t.body['id'] as string;
      const pl = await api(server.port, 'POST', '/api/pipelines', { taskId: tid });
      const pipelineId = pl.body['id'] as string;
      const dep = await api(server.port, 'POST', `/api/pipelines/${pipelineId}/deploy`, {
        environment: 'PROD',
        taskId: tid,
        actor: 'deploy-bot',
      });
      const approvalId = (dep.body['approval'] as Record<string, unknown>)['approval_id'] as string;
      const decision = await api(server.port, 'POST', `/api/approvals/${approvalId}/decision`, {
        approved: true,
        decided_by: 'human',
      });
      assert.equal(decision.status, 200);

      // Archive while the server is down, then reboot.
      await killServer(server);
      server = await bootServer(dbFile);
      const arch = await api(server.port, 'POST', `/api/projects/${pid}/archive`, {});
      assert.equal(arch.status, 200);
      await killServer(server);
      server = await bootServer(dbFile);

      const approve = await api(server.port, 'POST', `/api/pipelines/${pipelineId}/approve`, {
        approvalId,
      });
      assert.equal(approve.status, 409);
      assert.equal(approve.body['code'], 'PROJECT_ARCHIVED');
      const actions = await auditActions(server.port);
      assert.ok(
        actions.includes('DEPLOYMENT_REBUILD_REFUSED'),
        'refused rebuild is on the audit trail',
      );

      await killServer(server);
      server = undefined;
    } finally {
      if (server) await killServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pipeline with no persisted deployments still 404s', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-deploy-404-'));
    const dbFile = join(dir, 'factory.db');
    let server: BootedServer | undefined;
    try {
      server = await bootServer(dbFile);
      const r = await api(server.port, 'GET', '/api/pipelines/does-not-exist');
      assert.equal(r.status, 404);
      assert.match(r.body['error'] as string, /pipeline .* not found/);
      await killServer(server);
      server = undefined;
    } finally {
      if (server) await killServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

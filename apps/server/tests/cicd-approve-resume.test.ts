/**
 * Pipeline approve → resume, end to end — Batch 16.
 *
 * The defect this pins shut: POST /api/pipelines/:id/approve could
 * never resume a parked PROD deployment. Each cicd handler built a
 * fresh DeploymentService, and the parked job (deployment + deploy /
 * smoke functions + the evidence/audit callbacks captured at deploy
 * time) lived in the /deploy instance's private registry — so the
 * /approve instance's resume() always threw DeploymentNotFoundError
 * (409) and the deployment stayed AWAITING_APPROVAL forever.
 *
 * The fix keeps one module-level DeploymentJobRegistry in
 * routes/cicd.ts, injected into every DeploymentService the module
 * constructs (the same lifetime as the module's pipelines /
 * deployments / snapshotStore state). This file proves, against the
 * real compiled server:
 *
 *   1. rollback works BEFORE any approval flow (DEV deploy → rollback);
 *   2. a PROD deploy parks, approve with a still-PENDING ticket is
 *      refused (409, gate intact), and after the ticket is APPROVED a
 *      separate /approve request resumes the deployment to SUCCEEDED —
 *      approvalId/startedAt/endedAt recorded, `deployment` evidence
 *      attached by the resume itself, DEPLOY_RESUMED / DEPLOY_SUCCEEDED
 *      on the audit record;
 *   3. rollback works AFTER the approve too;
 *   4. the restart boundary is explicit, not silent: pipelines,
 *      deployments, snapshots and parked jobs are process-memory
 *      state, so after a restart the pipeline is gone and /approve
 *      answers 404 — a parked deployment does NOT survive a restart
 *      (and is never silently dropped within the process either).
 *
 * The workspace must be built (dist/index.js), like the sibling
 * archive-guard tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'cicd-approve-resume-test-token-0123456789';

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, never> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, never> = {};
  try {
    parsed = JSON.parse(text) as Record<string, never>;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: parsed };
}

interface BootedServer {
  child: ChildProcess;
  port: number;
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(dbFile: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKEN: TOKEN,
  };
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

async function stopServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((r) => s.child.once('exit', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    s.child.kill('SIGKILL');
    await new Promise((r) => s.child.once('exit', r));
  }
}

describe('pipeline approve resumes a parked PROD deployment (Batch 16)', () => {
  it('deploy parks → ticket approved → separate approve request resumes to SUCCEEDED; rollback works before and after; restart boundary is an explicit 404', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-cicd-resume-'));
    const dbFile = join(dir, 'factory.db');
    let server: BootedServer | undefined;
    try {
      server = await bootServer(dbFile);
      const port = server.port;

      const p = await api(port, 'POST', '/api/projects', { name: 'ResumeMe' });
      assert.equal(p.status, 201);
      const pid = p.body['id'] as unknown as string;
      const t = await api(port, 'POST', '/api/tasks', { projectId: pid, title: 'Ship it' });
      assert.equal(t.status, 201);
      const tid = t.body['id'] as unknown as string;

      const evidenceTotal = async (): Promise<number> => {
        const rep = await api(port, 'GET', `/api/projects/${pid}/final-report`);
        assert.equal(rep.status, 200);
        const report = rep.body['report'] as unknown as {
          extensions: { evidence: { total: number } };
        };
        return report.extensions.evidence.total;
      };
      const pipelineDeployments = async (): Promise<Array<Record<string, unknown>>> => {
        const r = await api(port, 'GET', `/api/pipelines/${pipelineId}`);
        assert.equal(r.status, 200);
        return r.body['deployments'] as unknown as Array<Record<string, unknown>>;
      };

      const pl = await api(port, 'POST', '/api/pipelines', { taskId: tid });
      assert.equal(pl.status, 201);
      const pipelineId = pl.body['id'] as unknown as string;

      // --- rollback BEFORE any approval flow: DEV deploy, roll it back.
      const depDev = await api(port, 'POST', `/api/pipelines/${pipelineId}/deploy`, {
        environment: 'DEV',
        taskId: tid,
        actor: 'deploy-bot',
      });
      assert.equal(depDev.status, 200);
      assert.equal(
        (depDev.body['deployment'] as Record<string, unknown>)['status'],
        'SUCCEEDED',
      );
      const rbBefore = await api(port, 'POST', `/api/pipelines/${pipelineId}/rollback`, {});
      assert.equal(rbBefore.status, 200);
      assert.equal(
        (rbBefore.body['deployment'] as Record<string, unknown>)['status'],
        'ROLLED_BACK',
      );

      // --- PROD deploy parks on a human-approval ticket.
      const depProd = await api(port, 'POST', `/api/pipelines/${pipelineId}/deploy`, {
        environment: 'PROD',
        taskId: tid,
        actor: 'deploy-bot',
      });
      assert.equal(depProd.status, 200);
      assert.ok(depProd.body['pendingApproval']);
      const prod = depProd.body['deployment'] as unknown as Record<string, unknown>;
      const prodId = prod['id'] as string;
      assert.equal(prod['status'], 'AWAITING_APPROVAL');
      assert.ok(prod['snapshotId'], 'pre-deploy snapshot taken before parking');
      const approval = depProd.body['approval'] as unknown as Record<string, unknown>;
      const approvalId = approval['approval_id'] as string;

      // --- the gate still bites: approve with a PENDING ticket → 409,
      // and the deployment stays parked.
      const early = await api(port, 'POST', `/api/pipelines/${pipelineId}/approve`, {
        approvalId,
      });
      assert.equal(early.status, 409);
      assert.match(early.body['error'] as unknown as string, /not APPROVED/);
      assert.equal(
        (await pipelineDeployments()).find((d) => d['id'] === prodId)?.['status'],
        'AWAITING_APPROVAL',
      );

      // --- decide the ticket, then approve from a separate request.
      const decision = await api(port, 'POST', `/api/approvals/${approvalId}/decision`, {
        approved: true,
        decided_by: 'human',
      });
      assert.equal(decision.status, 200);
      // Baseline AFTER the decision: deciding auto-attaches an
      // `approval` evidence record, so growth past this point is the
      // resume's own doing.
      const evBeforeResume = await evidenceTotal();

      const approve = await api(port, 'POST', `/api/pipelines/${pipelineId}/approve`, {
        approvalId,
      });
      assert.equal(approve.status, 200);
      const resumed = approve.body['deployment'] as unknown as Record<string, unknown>;
      assert.equal(resumed['id'], prodId);
      assert.equal(resumed['status'], 'SUCCEEDED');
      assert.equal(resumed['approvalId'], approvalId);
      assert.ok(resumed['startedAt'], 'resume ran the deploy phase');
      assert.ok(resumed['endedAt'], 'resume completed the deployment');

      // The deployment really executed: its `deployment` evidence was
      // attached (by the evidence callback captured at deploy time),
      // and the resume is on the audit record.
      assert.ok(
        (await evidenceTotal()) > evBeforeResume,
        'resume attached deployment evidence',
      );
      const auditRes = await api(port, 'GET', '/api/audit?limit=300');
      const actions = (auditRes.body as unknown as { action: string }[]).map((r) => r.action);
      assert.ok(actions.includes('DEPLOY_RESUMED'), 'resume audited');
      assert.ok(actions.includes('DEPLOY_SUCCEEDED'), 'completion audited');

      // Every read surface agrees the deployment completed.
      assert.equal(
        (await pipelineDeployments()).find((d) => d['id'] === prodId)?.['status'],
        'SUCCEEDED',
      );
      const allDeps = await api(port, 'GET', '/api/deployments');
      assert.equal(
        (allDeps.body as unknown as Array<Record<string, unknown>>).find(
          (d) => d['id'] === prodId,
        )?.['status'],
        'SUCCEEDED',
      );

      // --- rollback AFTER the approve: the resumed deployment has a
      // snapshot and rolls back like any other.
      const rbAfter = await api(port, 'POST', `/api/pipelines/${pipelineId}/rollback`, {});
      assert.equal(rbAfter.status, 200);
      assert.equal(
        (rbAfter.body['deployment'] as Record<string, unknown>)['id'],
        prodId,
      );
      assert.equal(
        (rbAfter.body['deployment'] as Record<string, unknown>)['status'],
        'ROLLED_BACK',
      );

      // --- restart boundary: park one more PROD deployment, approve
      // its ticket, then restart. The parked job is process-memory
      // state (like the pipeline record itself), so after the restart
      // the approve fails EXPLICITLY — 404 pipeline not found — rather
      // than the deployment silently vanishing mid-process.
      const depProd3 = await api(port, 'POST', `/api/pipelines/${pipelineId}/deploy`, {
        environment: 'PROD',
        taskId: tid,
        actor: 'deploy-bot',
      });
      assert.equal(depProd3.status, 200);
      const approval3 = depProd3.body['approval'] as unknown as Record<string, unknown>;
      const approvalId3 = approval3['approval_id'] as string;
      const decision3 = await api(port, 'POST', `/api/approvals/${approvalId3}/decision`, {
        approved: true,
        decided_by: 'human',
      });
      assert.equal(decision3.status, 200);

      await stopServer(server);
      server = await bootServer(dbFile);
      const port2 = server.port;
      const orphan = await api(port2, 'POST', `/api/pipelines/${pipelineId}/approve`, {
        approvalId: approvalId3,
      });
      assert.equal(orphan.status, 404);
      assert.match(orphan.body['error'] as unknown as string, /pipeline .* not found/);
      const listAfter = await api(port2, 'GET', '/api/pipelines');
      assert.equal((listAfter.body as unknown as unknown[]).length, 0);

      await stopServer(server);
      server = undefined;
    } finally {
      if (server) await stopServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

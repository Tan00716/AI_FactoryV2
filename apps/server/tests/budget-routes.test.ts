/**
 * Cost-governance budget HTTP tests — V3.0 audit suggestion #8.
 * Boots the real server (dist) with an isolated DB and exercises the
 * whole feature end to end:
 *
 *   GET  /api/quota/budgets/defaults     policy (caps on, auto-renew off)
 *                                       + unmeasured conversion table
 *   POST /api/quota/budgets             create project budget ($10/month)
 *   POST /api/quota/budgets             duplicate → 409, never overwrite
 *   POST /api/quota/budgets/:id/usage   80% → warned (audit), 100% → tripped
 *   POST /api/quota/budgets/check       blocked while tripped
 *   POST /api/quota/budgets/:id/release reason required; release unblocks
 *   POST /api/quota/budgets/apply-defaults  idempotent (existing kept)
 *   POST /api/projects + project budget trip → shadow checkpoint created
 *   GET  /api/quota/budgets             counts + current-window view
 *   GET  /api/audit                     breaker events on the chain
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/budget-routes.test.ts
 * (requires a server build first — the server boots from dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
  projDir: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const port = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port.port));
    });
  });
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-budget-http-'));
  const projDir = path.join(dir, 'projects', 'demo');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'notes.txt'), 'work in progress\n', 'utf8');
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
    // Shadow-checkpoint jail: the tripped project's dir must be an allowed root.
    FACTORY_SHADOW_ROOTS: path.join(dir, 'projects'),
    // Test-harness opt-in (same as the V3-#5 smoke script): the server
    // is fail-closed without a token even on loopback since V3-#1.
    FACTORY_ALLOW_OPEN_LOCAL: '1',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error('server did not become healthy in 30s');
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { port, proc, dir, projDir };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(s.dir, { recursive: true, force: true });
}

async function call(s: Running, method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${s.port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: r.status, json };
}

test('budget lifecycle: defaults, create, warn, trip, block, release', async () => {
  const s = await startServer();
  try {
    const defaults = await call(s, 'GET', '/api/quota/budgets/defaults');
    assert.equal(defaults.status, 200);
    const policy = defaults.json['policy'] as Record<string, unknown>;
    assert.equal(policy['capEnabledByDefault'], true);
    assert.equal(policy['autoRenewDefault'], false);
    const table = defaults.json['conversionTable'] as { measured: boolean }[];
    assert.ok(table.length >= 1);
    assert.ok(table.every((row) => row.measured === false));

    const created = await call(s, 'POST', '/api/quota/budgets', {
      scope: 'project', scopeKey: 'proj-a', unit: 'usd-estimate', limit: 10, period: 'monthly',
    });
    assert.equal(created.status, 201);
    const budget = created.json['budget'] as Record<string, unknown>;
    assert.equal(budget['scope'], 'project');
    assert.equal(budget['limit'], 10);

    const dup = await call(s, 'POST', '/api/quota/budgets', {
      scope: 'project', scopeKey: 'proj-a', unit: 'usd-estimate', limit: 99, period: 'monthly',
    });
    assert.equal(dup.status, 409);

    const warn = await call(s, 'POST', `/api/quota/budgets/${budget['id']}/usage`, {
      costUsd: 8, source: 'simulated',
    });
    assert.equal(warn.status, 201);
    assert.equal((warn.json['warned'] as unknown[]).length, 1);
    assert.equal((warn.json['tripped'] as unknown[]).length, 0);

    const trip = await call(s, 'POST', `/api/quota/budgets/${budget['id']}/usage`, {
      costUsd: 2.5, source: 'simulated',
    });
    assert.equal(trip.status, 201);
    assert.equal((trip.json['tripped'] as unknown[]).length, 1);

    const blocked = await call(s, 'POST', '/api/quota/budgets/check', { projectId: 'proj-a' });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.json['allowed'], false);
    assert.equal((blocked.json['blocking'] as unknown[]).length, 1);

    const noReason = await call(s, 'POST', `/api/quota/budgets/${budget['id']}/release`, {});
    assert.equal(noReason.status, 400);

    const released = await call(s, 'POST', `/api/quota/budgets/${budget['id']}/release`, {
      reason: 'operator override: month-end closeout',
    });
    assert.equal(released.status, 200);
    const unblocked = await call(s, 'POST', '/api/quota/budgets/check', { projectId: 'proj-a' });
    assert.equal(unblocked.json['allowed'], true);

    const list = await call(s, 'GET', '/api/quota/budgets');
    assert.equal(list.status, 200);
    const counts = list.json['counts'] as Record<string, number>;
    assert.equal(counts['total'], 1);
    assert.equal(counts['released'], 1);

    const audit = await call(s, 'GET', '/api/audit?limit=200');
    assert.equal(audit.status, 200);
    const events = JSON.stringify(audit.json);
    assert.ok(events.includes('BUDGET_BREAKER_WARNED'));
    assert.ok(events.includes('BUDGET_BREAKER_TRIPPED'));
    assert.ok(events.includes('BUDGET_RELEASED'));
  } finally {
    await stopServer(s);
  }
});

test('apply-defaults is idempotent; project trip snapshots a shadow checkpoint', async () => {
  const s = await startServer();
  try {
    const proj = await call(s, 'POST', '/api/projects', {
      name: 'budget-demo', path: s.projDir,
    });
    assert.equal(proj.status, 201);
    // POST /api/projects returns the bare project row, not { project }.
    const project = proj.json as Record<string, unknown>;
    const projectId = project['id'] as string;
    assert.ok(projectId);

    const first = await call(s, 'POST', '/api/quota/budgets/apply-defaults', { projectId });
    assert.equal(first.status, 200);
    assert.equal((first.json['created'] as unknown[]).length, 1);
    assert.equal((first.json['existing'] as unknown[]).length, 0);

    const second = await call(s, 'POST', '/api/quota/budgets/apply-defaults', { projectId });
    assert.equal(second.status, 200);
    assert.equal((second.json['created'] as unknown[]).length, 0);
    assert.equal((second.json['existing'] as unknown[]).length, 1);

    const budgetId = (first.json['created'] as { id: string }[])[0].id;
    const trip = await call(s, 'POST', `/api/quota/budgets/${budgetId}/usage`, {
      costUsd: 50, source: 'simulated',
    });
    assert.equal(trip.status, 201);
    assert.equal((trip.json['tripped'] as unknown[]).length, 1);
    const checkpoints = trip.json['checkpoints'] as Record<string, { created: boolean; checkpointId?: string }>;
    assert.equal(checkpoints[budgetId].created, true);
    assert.ok(checkpoints[budgetId].checkpointId);

    const audit = await call(s, 'GET', '/api/audit?limit=200');
    assert.ok(JSON.stringify(audit.json).includes('BUDGET_BREAKER_CHECKPOINT'));
  } finally {
    await stopServer(s);
  }
});

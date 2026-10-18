/**
 * W-C permission tiers: route tests (real compiled server, hermetic DB).
 *
 * Pins:
 *  A. GET /api/permissions/tiers seeds + returns the 4 default tiers.
 *  B. PUT /api/permissions/tiers/:tier validates (bad tier / bad policy → 400)
 *     and persists; GET reflects the edit.
 *  C. Agent→tier assignment round-trips; unknown agents resolve to the
 *     default tier ('write') on evaluate.
 *  D. POST /api/permissions/evaluate composes strictest-wins:
 *       - tier auto + approvals AUTO → AUTO
 *       - tier ask → ASK; tier deny → DENY
 *       - admin tier auto-allows, but approvals HUMAN_APPROVAL
 *         ('secret.read') still → ASK, and approvals BLOCKED
 *         ('secret.write') → DENY for every tier.
 *  E. POST /api/approvals/evaluate stays back-compatible without tier
 *     params, and gains tier fields when tier/agentId is passed.
 *  F. POST /api/approvals/:id/decision requires explicit decided_by
 *     (H3-A3: the silent 'human' default let any local caller
 *     self-approve) — missing/blank → 400.
 *
 * Requires the workspace build (root `npm run build`): boots
 * ../dist/index.js. Hermetic: temp DB_PATH + temp FACTORY_SECRETS_DIR
 * under $HOME (never /tmp — small tmpfs).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));
let child: ChildProcess | null = null;
let port = 0;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, json };
}

async function boot(): Promise<void> {
  const root = mkdtempSync(join(homedir(), 'wc-perm-'));
  const dbFile = join(root, 'factory.db');
  port = 24000 + Math.floor(Math.random() * 20000);
  child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbFile,
      FACTORY_SECRETS_DIR: join(dirname(dbFile), 'secrets'),
      TMPDIR: tmpdir(),
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not boot');
    await new Promise((r) => setTimeout(r, 200));
  }
}

after(() => {
  child?.kill('SIGKILL');
});

await boot();

const j = (r: { json: unknown }): Record<string, unknown> => r.json as Record<string, unknown>;

describe('W-C: tier CRUD', () => {
  it('seeds and lists the 4 default tiers', async () => {
    const r = await api('GET', '/api/permissions/tiers');
    assert.equal(r.status, 200);
    const tiers = (j(r)['tiers'] as Array<{ tier: string }>).map((t) => t.tier).sort();
    assert.deepEqual(tiers, ['admin', 'exec', 'read', 'write']);
  });

  it('rejects unknown tier and malformed policy', async () => {
    const r1 = await api('PUT', '/api/permissions/tiers/root', { auto: ['*'] });
    assert.equal(r1.status, 400);
    const r2 = await api('PUT', '/api/permissions/tiers/exec', { auto: [42] });
    assert.equal(r2.status, 400);
  });

  it('persists operator edits', async () => {
    const r = await api('PUT', '/api/permissions/tiers/read', {
      auto: ['*.read'],
      ask: ['*'],
      deny: ['secret.*'],
      updatedBy: 'test',
    });
    assert.equal(r.status, 200);
    const g = await api('GET', '/api/permissions/tiers');
    const read = (j(g)['tiers'] as Array<{ tier: string; deny: string[] }>).find((t) => t.tier === 'read');
    assert.deepEqual(read?.deny, ['secret.*']);
  });

  it('agent tier assignment round-trips', async () => {
    const r = await api('PUT', '/api/permissions/agents/agent-1', { tier: 'read' });
    assert.equal(r.status, 200);
    const g = await api('GET', '/api/permissions/agents');
    assert.equal(g.status, 200);
    const rows = j(g)['assignments'] as Array<{ agentId: string; tier: string }>;
    assert.ok(rows.some((x) => x.agentId === 'agent-1' && x.tier === 'read'));
    const bad = await api('PUT', '/api/permissions/agents/agent-1', { tier: 'root' });
    assert.equal(bad.status, 400);
  });
});

describe('W-C: evaluate composition (strictest wins)', () => {
  it('resets the read tier to defaults (CRUD test above mutated it)', async () => {
    const r = await api('PUT', '/api/permissions/tiers/read', {
      auto: ['*.read', 'filesystem.list', 'git.status', 'git.log', 'knowledge.*', 'memory.read'],
      ask: ['*'],
      deny: [],
    });
    assert.equal(r.status, 200);
  });

  it('read tier: knowledge.search → AUTO', async () => {
    const r = await api('POST', '/api/permissions/evaluate', { action: 'knowledge.search', tier: 'read' });
    assert.equal(r.status, 200);
    assert.equal(j(r)['level'], 'AUTO');
  });

  it('read tier: filesystem.write → ASK', async () => {
    const r = await api('POST', '/api/permissions/evaluate', { action: 'filesystem.write', tier: 'read' });
    assert.equal(j(r)['level'], 'ASK');
    assert.equal(j(r)['requiresApproval'], true);
  });

  it('exec tier deny wins: secret.read → DENY', async () => {
    const r = await api('POST', '/api/permissions/evaluate', { action: 'secret.read', tier: 'exec' });
    assert.equal(j(r)['level'], 'DENY');
  });

  it('approvals HUMAN_APPROVAL beats admin auto: secret.read → ASK', async () => {
    const r = await api('POST', '/api/permissions/evaluate', { action: 'secret.read', tier: 'admin' });
    assert.equal(r.status, 200);
    assert.equal(j(r)['tierVerdict'], 'auto');
    assert.equal(j(r)['level'], 'ASK');
  });

  it('approvals BLOCKED beats every tier: secret.write → DENY even for admin', async () => {
    const r = await api('POST', '/api/permissions/evaluate', { action: 'secret.write', tier: 'admin' });
    assert.equal(j(r)['level'], 'DENY');
  });

  it('agentId resolves the assigned tier', async () => {
    const r = await api('POST', '/api/permissions/evaluate', { action: 'filesystem.write', agentId: 'agent-1' });
    assert.equal(j(r)['tier'], 'read');
    assert.equal(j(r)['level'], 'ASK');
  });

  it('unknown agent falls back to the default tier', async () => {
    const r = await api('POST', '/api/permissions/evaluate', { action: 'filesystem.write', agentId: 'nobody' });
    assert.equal(j(r)['tier'], 'write');
    assert.equal(j(r)['level'], 'AUTO');
  });

  it('CRITICAL risk escalates through composition', async () => {
    const r = await api('POST', '/api/permissions/evaluate', {
      action: 'git.push',
      tier: 'exec',
      riskLevel: 'CRITICAL',
    });
    assert.equal(j(r)['level'], 'ASK');
  });
});

describe('W-C: approvals /evaluate integration', () => {
  it('stays back-compatible without tier params', async () => {
    const r = await api('POST', '/api/approvals/evaluate', { action: 'git.push' });
    assert.equal(r.status, 200);
    assert.equal(j(r)['tier'], undefined);
    assert.ok('requiresApproval' in (r.json as object));
  });

  it('adds tier fields when tier is passed', async () => {
    const r = await api('POST', '/api/approvals/evaluate', { action: 'git.push', tier: 'exec' });
    assert.equal(r.status, 200);
    assert.equal(j(r)['tier'], 'exec');
    assert.equal(j(r)['effectiveRequiresApproval'], true);
  });
});

describe('W-C: decision requires explicit decided_by (H3-A3)', () => {
  async function makeApproval(): Promise<string> {
    const p = await api('POST', '/api/projects', { name: `wc-a3-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    const pid = (p.json as { id: string }).id;
    const t = await api('POST', '/api/tasks', { projectId: pid, title: 't' });
    const tj = t.json as { task_id?: string; id?: string };
    const tid = tj.task_id ?? tj.id;
    assert.ok(tid, `task creation failed: ${JSON.stringify(t.json).slice(0, 200)}`);
    const a = await api('POST', '/api/approvals', { action: 'do thing', task_id: tid });
    const aid = (a.json as { approval_id?: string }).approval_id;
    assert.ok(aid, `approval creation failed: ${JSON.stringify(a.json).slice(0, 200)}`);
    return aid;
  }

  it('missing decided_by → 400 (was: silently APPROVED as human)', async () => {
    const id = await makeApproval();
    const r = await api('POST', `/api/approvals/${id}/decision`, { approved: true });
    assert.equal(r.status, 400);
  });

  it('blank decided_by → 400', async () => {
    const id = await makeApproval();
    const r = await api('POST', `/api/approvals/${id}/decision`, { approved: true, decided_by: '  ' });
    assert.equal(r.status, 400);
  });

  it('explicit decided_by still decides', async () => {
    const id = await makeApproval();
    const r = await api('POST', `/api/approvals/${id}/decision`, { approved: true, decidedBy: 'human' });
    assert.equal(r.status, 200);
    assert.equal((r.json as { approval: { status: string } }).approval.status, 'APPROVED');
  });
});

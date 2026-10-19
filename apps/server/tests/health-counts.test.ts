/**
 * /api/health count-only contract — H5 soak follow-up (e2e).
 *
 * Boots the real built server (../dist/index.js) over a seeded DB and
 * asserts /api/health reports exact table counts. Requires the
 * workspace build (root `npm run build`). Hermetic: temp DB + temp
 * FACTORY_SECRETS_DIR.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactoryDatabase } from '@ai-factory/db';
import { createCheckpointV2 } from '@ai-factory/runtime';
import { RequirementManager } from '@ai-factory/requirements';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

const CLOCK = { now: () => 42_000 };

function checkpoint(runId: string, stepPosition: number) {
  return createCheckpointV2(
    {
      runId,
      stepPosition,
      workflowVersion: 'wf@1',
      taskVersion: 'task@1',
      contextManifestHash: 'ctx',
      activeTools: [],
      activeProcesses: [],
      leaseGeneration: 1,
      fencingToken: 1,
      pendingApprovals: [],
      budgetUsage: {},
      pendingSideEffects: [],
      resumePreconditions: [],
    },
    CLOCK,
  );
}

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
  base: string;
  dir: string;
}

async function bootSeededServer(): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-health-count-'));
  const dbFile = join(dir, 'factory.db');

  // Seed BEFORE boot, via the same dist stores the server uses.
  const fdb = new FactoryDatabase(dbFile);
  try {
    fdb.checkpoints.put(checkpoint('run-a', 0));
    fdb.checkpoints.put(checkpoint('run-a', 1));
    fdb.checkpoints.put(checkpoint('run-b', 0));
    const reqMgr = new RequirementManager({ now: () => 42_000, store: fdb.requirements });
    reqMgr.create({ businessGoal: 'g1', rationale: 'r1', acceptanceCriteria: [], createdBy: 'human' });
    reqMgr.create({ businessGoal: 'g2', rationale: 'r2', acceptanceCriteria: [], createdBy: 'human' });
    for (const id of ['run-1', 'run-2']) {
      fdb.runs.put({
        id,
        agentId: 'agent-1',
        taskId: 'task-1',
        status: 'COMPLETED',
        outcome: 'completed',
        steps: 1,
        evidence: [],
        handoffs: [],
        trace: [],
        createdAt: '2026-10-19T00:00:00.000Z',
        finishedAt: '2026-10-19T00:00:01.000Z',
        error: null,
      });
    }
    fdb.retention.addHold({
      id: 'hold-1',
      scope: 'GLOBAL',
      projectId: null,
      reason: 'audit',
      setBy: 'human',
      setAt: '2026-10-19T00:00:00.000Z',
      releasedAt: null,
      releasedBy: null,
    });
  } finally {
    fdb.db.close();
  }

  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
  const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('server exited during boot');
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('server did not come up in 20s');
    await new Promise((r) => setTimeout(r, 200));
  }
  return { child, base, dir };
}

describe('/api/health count-only contract (e2e)', () => {
  it('reports exact table counts from COUNT(*), not list()', async () => {
    const { child, base, dir } = await bootSeededServer();
    try {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        checkpoints: { stored: number };
        requirements: { stored: number };
        runs: { stored: number };
        retention: { activeHolds: number };
      };
      assert.equal(body.checkpoints.stored, 3);
      assert.equal(body.requirements.stored, 2);
      assert.equal(body.runs.stored, 2);
      assert.equal(body.retention.activeHolds, 1);
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

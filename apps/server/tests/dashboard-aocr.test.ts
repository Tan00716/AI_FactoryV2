/**
 * Dashboard AOCR real-data wiring — SPEC_V2 §1.2 (Batch 3, S1-2).
 *
 * The dashboard package's primary metric (Authorized Outcome Completion
 * Rate) landed in Batch 2, but the server route never passed `outcomes`,
 * so the endpoint always showed 暂无数据. The route now builds outcomes
 * from the real stores: authorized := an approval record with decision
 * 'APPROVED' exists for the task; completed := task.status === 'DONE'.
 * These tests seed the stores and check the endpoint against hand math.
 *
 * NOTE: this file imports the route from dist (../dist/routes/dashboard.js),
 * unlike the src-importing sibling tests. dashboard.ts pulls in sibling
 * route modules via extensionless relative imports ('./qa', './cicd',
 * './resources'), which CommonJS/tsc resolve fine but Node's type-stripping
 * ESM loader cannot. The compiled dist resolves them normally — so this
 * test requires `npm run build -w @ai-factory/server` first (the same build
 * the package-name imports in the other tests already require of dist).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskManager } from '@ai-factory/core';
import { handleDashboardRoutes } from '../dist/routes/dashboard.js';

interface ApprovalRow {
  approval_id: string;
  task_id: string;
  status: string;
  decision: string;
  decided_by: string;
}

function makeCtx(tasks: TaskManager, approvals: ApprovalRow[]) {
  const calls: Array<{ status: number; body: unknown }> = [];
  return {
    ctx: {
      tasks,
      agents: { list: () => [] },
      fdb: { approvals: { list: () => approvals } },
      readBody: async () => ({}),
      json: (_res: unknown, status: number, b: unknown) => {
        calls.push({ status, body: b });
      },
    } as never,
    calls,
  };
}

async function getStats(tasks: TaskManager, approvals: ApprovalRow[]) {
  const { ctx, calls } = makeCtx(tasks, approvals);
  const handled = await handleDashboardRoutes(
    { method: 'GET' } as never,
    {} as never,
    new URL('http://localhost/api/stats'),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, 200);
  return calls[0].body as {
    metrics: {
      authorizedOutcomeCompletionRate: { value: number | null; note?: string };
    };
  };
}

function approval(taskId: string, decision: string): ApprovalRow {
  return {
    approval_id: `appr-${taskId}-${decision}`,
    task_id: taskId,
    status: decision === 'APPROVED' ? 'APPROVED' : decision === 'REJECTED' ? 'REJECTED' : 'PENDING',
    decision,
    decided_by: decision === '' ? '' : 'human',
  };
}

describe('dashboard AOCR wiring (§1.2, S1-2)', () => {
  it('computes AOCR from real task + approval records (hand-checked 1/2 = 50%)', async () => {
    const tasks = new TaskManager();
    // authorized & completed → numerator + denominator
    const t1 = tasks.create({ projectId: 'p1', title: 'done+approved', creator: 'human' });
    tasks.setStatus(t1.id, 'DONE');
    // authorized but not completed → denominator only
    const t2 = tasks.create({ projectId: 'p1', title: 'approved, in flight', creator: 'human' });
    // completed but REJECTED → not authorized, enters neither side
    const t3 = tasks.create({ projectId: 'p1', title: 'done but rejected', creator: 'human' });
    tasks.setStatus(t3.id, 'DONE');
    // completed with NO approval record at all → not authorized
    const t4 = tasks.create({ projectId: 'p1', title: 'done, never submitted', creator: 'human' });
    tasks.setStatus(t4.id, 'DONE');
    // pending decision → not authorized yet
    const t5 = tasks.create({ projectId: 'p1', title: 'pending approval', creator: 'human' });

    const stats = await getStats(tasks, [
      approval(t1.id, 'APPROVED'),
      approval(t2.id, 'APPROVED'),
      approval(t3.id, 'REJECTED'),
      approval(t5.id, ''),
    ]);
    assert.equal(stats.metrics.authorizedOutcomeCompletionRate.value, 50);
  });

  it('no authorized tasks → AOCR is null with 暂无数据, never a fabricated rate', async () => {
    const tasks = new TaskManager();
    const t1 = tasks.create({ projectId: 'p1', title: 'done, no approvals', creator: 'human' });
    tasks.setStatus(t1.id, 'DONE');

    const stats = await getStats(tasks, []);
    assert.equal(stats.metrics.authorizedOutcomeCompletionRate.value, null);
    assert.equal(stats.metrics.authorizedOutcomeCompletionRate.note, '暂无数据');
  });
});

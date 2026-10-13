/**
 * Batch 38 — §81 run-terminal needsHuman emissions.
 *
 * What this pins:
 *  1. A run terminating with reasonCode BUDGET_EXCEEDED builds a §81
 *     'budget-exceeded' record (severity high); LOOP_STAGNATION builds
 *     'repeated-failure' (severity medium). The trigger is one of the
 *     eight §81 reasons — enforced by the HumanNeedReason type, not a
 *     string match.
 *  2. recipient is null (no named human accounts on the server) and
 *     requiredDeciderLevel is 'operator' — the API role that does daily
 *     run work. Nothing invents a person.
 *  3. emitRunNeedsHuman is insert-only + audited NEEDS_HUMAN_RAISED; a
 *     failed write-through audits NEEDS_HUMAN_PERSIST_FAILED and never
 *     throws (it must not roll back the already-committed run record).
 *
 * Tests import the route from src (like runtime-manifests.test.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryNeedsHumanStore } from '@ai-factory/db';
import {
  buildRunUpgradeRecord,
  emitRunNeedsHuman,
} from '../src/routes/runtime.ts';
import type { RouteContext } from '../src/routes/context.ts';

function makeCtx(store: InMemoryNeedsHumanStore, auditCalls: unknown[][]): RouteContext {
  return {
    fdb: { needsHuman: store },
    audit: {
      record: (...args: unknown[]) => {
        auditCalls.push(args);
      },
    },
  } as unknown as RouteContext;
}

describe('§81 run-terminal needsHuman emissions (Batch 38)', () => {
  it("BUDGET_EXCEEDED → 'budget-exceeded' record, severity high, honest recipient", () => {
    const rec = buildRunUpgradeRecord({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      reasonCode: 'BUDGET_EXCEEDED',
      reason: 'Budget exceeded: steps 41 reached maxSteps 40',
      steps: 41,
    });
    assert.equal(rec.reason, 'budget-exceeded');
    assert.equal(rec.reasonZh, '预算超限');
    assert.equal(rec.severity, 'high');
    assert.equal(rec.source, 'runtime-run:run-1');
    assert.equal(rec.recipient, null);
    assert.equal(rec.requiredDeciderLevel, 'operator');
    assert.equal(rec.status, 'open');
    const detail = JSON.parse(rec.detailJson) as Record<string, unknown>;
    assert.equal(detail['runId'], 'run-1');
    assert.equal(detail['reasonCode'], 'BUDGET_EXCEEDED');
    assert.equal(detail['steps'], 41);
    const context = JSON.parse(rec.contextJson) as Record<string, string>;
    assert.equal(context['taskId'], 'task-1');
    assert.equal(context['agentId'], 'agent-1');
  });

  it("LOOP_STAGNATION → 'repeated-failure' record, severity medium", () => {
    const rec = buildRunUpgradeRecord({
      runId: 'run-2',
      taskId: 'task-2',
      agentId: 'agent-2',
      reasonCode: 'LOOP_STAGNATION',
      reason: "Loop stagnated: same error signature 'step-throw' 3 times in a row — escalating",
      steps: 12,
    });
    assert.equal(rec.reason, 'repeated-failure');
    assert.equal(rec.reasonZh, '重复失败');
    assert.equal(rec.severity, 'medium');
    assert.equal(rec.source, 'runtime-run:run-2');
    assert.equal(rec.recipient, null);
    assert.equal(rec.requiredDeciderLevel, 'operator');
    assert.equal(rec.status, 'open');
  });

  it('emitRunNeedsHuman writes through insert-only + audits NEEDS_HUMAN_RAISED', () => {
    const store = new InMemoryNeedsHumanStore();
    const auditCalls: unknown[][] = [];
    const ctx = makeCtx(store, auditCalls);
    const rec = buildRunUpgradeRecord({
      runId: 'run-3',
      taskId: 'task-3',
      agentId: 'agent-3',
      reasonCode: 'BUDGET_EXCEEDED',
      reason: 'Budget exceeded: test',
      steps: 5,
    });
    emitRunNeedsHuman(ctx, rec);
    const row = store.get(rec.id);
    assert.ok(row);
    assert.equal(row?.status, 'open');
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0][1], 'NEEDS_HUMAN_RAISED');
    const detail = auditCalls[0][4] as Record<string, unknown>;
    assert.equal(detail['reason'], 'budget-exceeded');
    assert.equal(detail['source'], 'runtime-run:run-3');
  });

  it('emitRunNeedsHuman: failed write-through audits NEEDS_HUMAN_PERSIST_FAILED and never throws', () => {
    const store = new InMemoryNeedsHumanStore();
    // Pre-insert the same id so submit() throws duplicate.
    const auditCalls: unknown[][] = [];
    const ctx = makeCtx(store, auditCalls);
    const rec = buildRunUpgradeRecord({
      runId: 'run-4',
      taskId: 'task-4',
      agentId: 'agent-4',
      reasonCode: 'LOOP_STAGNATION',
      reason: 'stagnated',
      steps: 9,
    });
    store.submit(rec);
    assert.doesNotThrow(() => emitRunNeedsHuman(ctx, rec));
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0][1], 'NEEDS_HUMAN_PERSIST_FAILED');
  });
});

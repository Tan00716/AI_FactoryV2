/**
 * Batch 43 — §81 'irrecoverable-env-error' emission.
 *
 * What this pins:
 *  1. The deterministic emission point: a run that escalated on
 *     LOOP_STAGNATION whose stagnation signature is a machine-readable
 *     environment-error code (ENV_ERROR_CODES — Batch 40's
 *     ENV_SANDBOX_UNAVAILABLE / ENV_BINARY_MISSING). The loop retried the
 *     same env-erroring step to the stagnation limit with no progress, so
 *     the loop's own recovery was exhausted — "irrecoverable" is a fact
 *     about what happened, not a prediction. Code membership only; the
 *     human-readable reason message is never parsed.
 *  2. A single env error never emits (no stagnation → no emission); a
 *     direct ENV_* reasonCode is deliberately NOT wired (no live
 *     production path produces it — the bridge carries it, but nothing
 *     escapes the loop with one today).
 *  3. The record: trigger 'irrecoverable-env-error', severity critical
 *     (autonomy mapping), recipient null, requiredDeciderLevel 'operator'
 *     (mapping choice — the spec has no trigger→rank table), source
 *     `runtime-run:<runId>`. It fires ADDITIVELY alongside the Batch-38
 *     'repeated-failure' record for the same stagnation (that contract is
 *     untouched): the store's primary key is the record id, so a
 *     repeated-failure record with the same source coexists.
 *  4. Honest wording: the detail says the env error "repeated with no
 *     progress until the loop's stagnation limit tripped" — it does not
 *     claim the environment is proven unfixable forever.
 *
 * Tests import the route from src (like needs-human-run-emission.test.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryNeedsHumanStore } from '@ai-factory/db';
import {
  buildEnvErrorUpgradeRecord,
  buildRunUpgradeRecord,
  emitRunNeedsHuman,
  shouldEmitEnvErrorUpgrade,
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

describe("§81 'irrecoverable-env-error' emission (Batch 43)", () => {
  it('predicate: LOOP_STAGNATION + env signature → true', () => {
    assert.equal(
      shouldEmitEnvErrorUpgrade({ reasonCode: 'LOOP_STAGNATION', stagnationSignature: 'ENV_BINARY_MISSING' }),
      true,
    );
    assert.equal(
      shouldEmitEnvErrorUpgrade({ reasonCode: 'LOOP_STAGNATION', stagnationSignature: 'ENV_SANDBOX_UNAVAILABLE' }),
      true,
    );
  });

  it('predicate: non-env stagnation signature → false', () => {
    assert.equal(
      shouldEmitEnvErrorUpgrade({ reasonCode: 'LOOP_STAGNATION', stagnationSignature: 'step-throw' }),
      false,
    );
    assert.equal(
      shouldEmitEnvErrorUpgrade({ reasonCode: 'LOOP_STAGNATION', stagnationSignature: 'adapter:unknown-tool' }),
      false,
    );
    assert.equal(
      shouldEmitEnvErrorUpgrade({ reasonCode: 'LOOP_STAGNATION', stagnationSignature: null }),
      false,
    );
    assert.equal(
      shouldEmitEnvErrorUpgrade({ reasonCode: 'LOOP_STAGNATION', stagnationSignature: undefined }),
      false,
    );
  });

  it('predicate: non-stagnation reasonCode → false even with an env signature', () => {
    assert.equal(
      shouldEmitEnvErrorUpgrade({ reasonCode: 'BUDGET_EXCEEDED', stagnationSignature: 'ENV_BINARY_MISSING' }),
      false,
    );
    assert.equal(
      shouldEmitEnvErrorUpgrade({ reasonCode: null, stagnationSignature: 'ENV_BINARY_MISSING' }),
      false,
    );
  });

  it('predicate: direct ENV_* reasonCode is deliberately NOT wired → false', () => {
    // The Batch-38 bridge already carries an ENV_* code when an env
    // FactoryError escapes the loop (Batch-40 tested), but no live
    // production path produces that today — wiring it would be
    // definition-without-implementation.
    assert.equal(
      shouldEmitEnvErrorUpgrade({ reasonCode: 'ENV_BINARY_MISSING', stagnationSignature: undefined }),
      false,
    );
    assert.equal(
      shouldEmitEnvErrorUpgrade({ reasonCode: 'ENV_SANDBOX_UNAVAILABLE', stagnationSignature: null }),
      false,
    );
  });

  it('record shape: trigger, critical, honest recipient/level, env code in context', () => {
    const rec = buildEnvErrorUpgradeRecord({
      runId: 'run-env-1',
      taskId: 'task-env-1',
      agentId: 'agent-env-1',
      envErrorCode: 'ENV_BINARY_MISSING',
      reason: "Loop stagnated: same error signature 'ENV_BINARY_MISSING' 3 times in a row — escalating",
      steps: 12,
    });
    assert.equal(rec.reason, 'irrecoverable-env-error');
    assert.equal(rec.severity, 'critical');
    assert.equal(rec.recipient, null);
    assert.equal(rec.requiredDeciderLevel, 'operator');
    assert.equal(rec.source, 'runtime-run:run-env-1');
    assert.equal(rec.status, 'open');
    const detail = JSON.parse(rec.detailJson) as Record<string, unknown>;
    assert.equal(detail['envErrorCode'], 'ENV_BINARY_MISSING');
    assert.equal(detail['reasonCode'], 'LOOP_STAGNATION');
    assert.equal(detail['runId'], 'run-env-1');
    assert.match(String(detail['reason']), /ENV_BINARY_MISSING/);
    const context = JSON.parse(rec.contextJson) as Record<string, unknown>;
    assert.equal(context['envErrorCode'], 'ENV_BINARY_MISSING');
    assert.equal(context['reasonCode'], 'LOOP_STAGNATION');
  });

  it('record wording: honest about what "irrecoverable" means here', () => {
    const rec = buildEnvErrorUpgradeRecord({
      runId: 'run-env-2',
      taskId: 'task-env-2',
      agentId: 'agent-env-2',
      envErrorCode: 'ENV_SANDBOX_UNAVAILABLE',
      reason: "Loop stagnated: same error signature 'ENV_SANDBOX_UNAVAILABLE' 3 times in a row — escalating",
      steps: 9,
    });
    const detailJson = JSON.parse(rec.detailJson) as Record<string, unknown>;
    // What the human actually sees (the DbRecord persists detailJson, not
    // the EscalationRecord prose): the loop's own message — a fact about
    // what happened (repeated with no progress, 3 times, escalated) — plus
    // a suggestion framed as repairable, never "the environment can never
    // be fixed".
    assert.match(String(detailJson['reason']), /3 times in a row/);
    assert.match(String(detailJson['suggestion']), /Repair the host environment/);
    assert.match(String(detailJson['note']), /repeated-failure/);
    assert.equal(detailJson['envErrorCode'], 'ENV_SANDBOX_UNAVAILABLE');
    // F19 follow-up (Batch 45): the honest narrative must survive
    // persistence — it is copied into detailJson, not only the transient
    // autonomy record.
    assert.match(
      String(detailJson['narrative']),
      /'Irrecoverable' describes the loop's own recovery being exhausted/,
    );
  });

  it('coexists with the repeated-failure record for the same run (same source, different id)', () => {
    const store = new InMemoryNeedsHumanStore();
    const auditCalls: unknown[][] = [];
    const ctx = makeCtx(store, auditCalls);
    const repeated = buildRunUpgradeRecord({
      runId: 'run-env-3',
      taskId: 'task-env-3',
      agentId: 'agent-env-3',
      reasonCode: 'LOOP_STAGNATION',
      reason: 'stagnated',
      steps: 9,
    });
    const envRec = buildEnvErrorUpgradeRecord({
      runId: 'run-env-3',
      taskId: 'task-env-3',
      agentId: 'agent-env-3',
      envErrorCode: 'ENV_BINARY_MISSING',
      reason: 'stagnated',
      steps: 9,
    });
    emitRunNeedsHuman(ctx, repeated);
    emitRunNeedsHuman(ctx, envRec);
    assert.ok(store.get(repeated.id));
    assert.ok(store.get(envRec.id));
    assert.notEqual(repeated.id, envRec.id);
    assert.equal(
      auditCalls.filter((c) => c[1] === 'NEEDS_HUMAN_RAISED').length,
      2,
    );
  });

  it('write-through failure audits NEEDS_HUMAN_PERSIST_FAILED and never throws', () => {
    const store = new InMemoryNeedsHumanStore();
    const auditCalls: unknown[][] = [];
    const ctx = makeCtx(store, auditCalls);
    const rec = buildEnvErrorUpgradeRecord({
      runId: 'run-env-4',
      taskId: 'task-env-4',
      agentId: 'agent-env-4',
      envErrorCode: 'ENV_SANDBOX_UNAVAILABLE',
      reason: 'stagnated',
      steps: 6,
    });
    store.submit(rec);
    assert.doesNotThrow(() => emitRunNeedsHuman(ctx, rec));
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0][1], 'NEEDS_HUMAN_PERSIST_FAILED');
  });
});

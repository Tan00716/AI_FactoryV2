/**
 * Durable outbox sink — SPEC v2 §18.2 (G-17) / §48.4 (Batch 17).
 *
 * The engine's outbox used to be a process-local array: committed
 * events nobody had drained yet vanished on restart. With an
 * OutboxSink wired, this file pins:
 *
 *  1. Every COMMITTED transition appends exactly one event to the
 *     sink, in the engine's own shape; denials and idempotency-deduped
 *     repeats append nothing (§18.2: the outbox records what
 *     committed).
 *  2. finalize() appends its REQUEST_COMPLETE event the same way.
 *  3. A new engine constructed over the same sink restores the pending
 *     queue (restart), drained events stay drained, and drain
 *     acknowledges by id — if the acknowledgement throws, the events
 *     stay queued in BOTH places (at-least-once, never a silent drop).
 *  4. A sink whose append throws does not un-commit the transition:
 *     the event stays in the process queue and the gap is written to
 *     the audit log as OUTBOX_PERSIST_FAILED.
 *  5. No sink = the original process-local behavior, unchanged.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditLog,
  WorkflowEngineV2,
  type Evidence,
  type GateContext,
  type OutboxEvent,
  type OutboxSink,
  type StoredOutboxEvent,
} from '../src/index';

function planEvidence(): Evidence {
  return {
    id: 'ev-plan', taskId: 't-1', type: 'plan', title: 'ev-plan',
    payload: {}, status: 'DRAFT', createdBy: 'tester',
    createdAt: '2026-10-10T00:00:00.000Z', sealedAt: null,
  };
}

const NOW = 1700000000000;
const NOW_ISO = new Date(NOW).toISOString();

function baseCtx(
  over: Partial<GateContext> & { idempotencyKey?: string } = {},
): GateContext & { idempotencyKey?: string } {
  return {
    taskId: 't-1',
    taskVersion: 1,
    actor: 'agent-1',
    authorization: { status: 'AUTHORIZED', expiresAt: null },
    requirementVersion: 'REQ-001@1',
    candidateDigest: 'sha256:abc',
    implementerId: 'coder-1',
    evidence: [],
    evidenceReqVersions: {},
    staleEvidenceIds: [],
    budgetOk: true,
    quotaOk: true,
    confinementOk: true,
    dependenciesReady: true,
    ...over,
  };
}

/** In-memory OutboxSink with the store semantics: confirm, never delete. */
class FakeSink implements OutboxSink {
  readonly stored: Array<{ event: OutboxEvent; dispatched: boolean }> = [];
  readonly ackedIds: string[][] = [];
  private seq = 0;

  append(event: OutboxEvent): StoredOutboxEvent {
    const id = `evt-${++this.seq}`;
    this.stored.push({ event: structuredClone(event), dispatched: false });
    return { ...structuredClone(event), id };
  }

  listPending(taskId?: string): StoredOutboxEvent[] {
    return this.stored
      .map((row, i) => ({ row, id: `evt-${i + 1}` }))
      .filter(({ row }) => !row.dispatched)
      .filter(({ row }) => taskId === undefined || row.event.taskId === taskId)
      .map(({ row, id }) => ({ ...structuredClone(row.event), id }));
  }

  markDispatched(ids: string[]): StoredOutboxEvent[] {
    this.ackedIds.push([...ids]);
    const out: StoredOutboxEvent[] = [];
    for (const id of ids) {
      const idx = Number(id.replace('evt-', '')) - 1;
      const row = this.stored[idx];
      if (row && !row.dispatched) {
        row.dispatched = true;
        out.push({ ...structuredClone(row.event), id });
      }
    }
    return out;
  }
}

function engineWith(sink?: OutboxSink, audit = new AuditLog()) {
  return new WorkflowEngineV2({
    audit,
    now: () => NOW,
    ...(sink ? { outboxSink: sink } : {}),
  });
}

const goodSnapshot = {
  applicableAcs: [{ id: 'AC-001', verified: true }],
  gatesValid: true,
  milestonesValid: true,
  pendingBlocks: [],
  authorizationsComplete: true,
  releaseApplicable: true,
  releaseNaAuthorized: false,
};

describe('outbox sink (§18.2, Batch 17)', () => {
  it('a committed transition appends exactly one event, in the engine shape', () => {
    const sink = new FakeSink();
    const e = engineWith(sink);
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    const r = e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', baseCtx());
    assert.equal(r.ok, true);
    assert.equal(sink.stored.length, 1);
    assert.deepEqual(sink.stored[0].event, {
      taskId: 't-1',
      from: 'TODO',
      to: 'PLANNING',
      by: 'agent-1',
      at: NOW_ISO,
      intent: r.ok ? r.intent : '',
    });
    // And the engine queue agrees, in the plain (id-less) event shape.
    assert.deepEqual(e.listOutbox(), [sink.stored[0].event]);
    assert.deepEqual(e.listOutbox('t-1'), [sink.stored[0].event]);
    assert.deepEqual(e.listOutbox('other'), []);
  });

  it('denials and deduped repeats append nothing', () => {
    const sink = new FakeSink();
    const e = engineWith(sink);
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    const denied = e.requestTransitionV2('t-1', 'DONE', 'agent-1', baseCtx());
    assert.equal(denied.ok, false);
    assert.equal(sink.stored.length, 0);

    const ctx = baseCtx({ idempotencyKey: 'evt-123' });
    assert.equal(e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', ctx).ok, true);
    const dup = e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', ctx);
    assert.equal((dup as { deduped?: boolean }).deduped, true);
    assert.equal(sink.stored.length, 1);
  });

  it('finalize appends the REQUEST_COMPLETE event', () => {
    const sink = new FakeSink();
    const e = engineWith(sink);
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    e.getMutable('t-1').stage = 'OUTCOME_VERIFICATION';
    const r = e.finalize('t-1', 'agent-1', goodSnapshot);
    assert.equal(r.ok, true);
    assert.equal(sink.stored.length, 1);
    assert.deepEqual(sink.stored[0].event, {
      taskId: 't-1',
      from: 'OUTCOME_VERIFICATION',
      to: 'DONE',
      by: 'agent-1',
      at: NOW_ISO,
      intent: 'REQUEST_COMPLETE',
    });
  });

  it('a fresh engine over the same sink restores pending; drained stays drained', () => {
    const sink = new FakeSink();
    const a = engineWith(sink);
    a.register('t-1', { requirementRef: 'REQ-001@1' });
    a.requestTransitionV2('t-1', 'PLANNING', 'agent-1', baseCtx());
    const r2 = a.requestTransitionV2(
      't-1', 'IN_PROGRESS', 'agent-1',
      baseCtx({ evidence: [planEvidence()] }),
    );
    assert.equal(r2.ok, true, JSON.stringify(r2));

    // "Restart": a new engine restores both undispatched events.
    const b = engineWith(sink);
    assert.deepEqual(
      b.listOutbox('t-1').map((e) => [e.from, e.to]),
      [
        ['TODO', 'PLANNING'],
        ['PLANNING', 'IN_PROGRESS'],
      ],
    );

    // Drain acknowledges by the sink ids — both of them, exactly once.
    const drained = b.drainOutbox('t-1');
    assert.equal(drained.length, 2);
    assert.deepEqual(sink.ackedIds, [['evt-1', 'evt-2']]);
    assert.equal(b.listOutbox().length, 0);

    // Another restart: nothing comes back — drain was the ack.
    const c = engineWith(sink);
    assert.equal(c.listOutbox().length, 0);
    // The stored records themselves were confirmed, not deleted.
    assert.equal(sink.stored.length, 2);
    assert.ok(sink.stored.every((s) => s.dispatched));
  });

  it('if the drain acknowledgement throws, the events stay queued on both sides', () => {
    const sink = new FakeSink();
    const realAck = sink.markDispatched.bind(sink);
    let failOnce = true;
    sink.markDispatched = (ids: string[]) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('sink unavailable');
      }
      return realAck(ids);
    };
    const e = engineWith(sink);
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', baseCtx());

    assert.throws(() => e.drainOutbox(), /sink unavailable/);
    // Nothing was removed anywhere: the retry drains cleanly.
    assert.equal(e.listOutbox().length, 1);
    assert.equal(sink.listPending().length, 1);
    assert.equal(e.drainOutbox().length, 1);
    assert.equal(e.listOutbox().length, 0);
    assert.equal(sink.listPending().length, 0);
  });

  it('a failing append neither un-commits the transition nor loses the event silently', () => {
    const audit = new AuditLog();
    const broken: OutboxSink = {
      append: () => {
        throw new Error('disk full');
      },
      listPending: () => [],
      markDispatched: () => [],
    };
    const e = engineWith(broken, audit);
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    const r = e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', baseCtx());
    assert.equal(r.ok, true);
    assert.equal(e.get('t-1').stage, 'PLANNING');
    // The event is still in this process's queue…
    assert.equal(e.listOutbox().length, 1);
    // …and the durability gap is on the audit record, not silent.
    const failures = audit
      .list()
      .filter((rec) => rec.action === 'OUTBOX_PERSIST_FAILED');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].entityId, 't-1');
    // Draining a never-persisted event still works (no id to ack).
    assert.equal(e.drainOutbox().length, 1);
  });

  it('no sink: the queue is process-local with the original semantics', () => {
    const e = engineWith(undefined);
    e.register('t-1', { requirementRef: 'REQ-001@1' });
    e.requestTransitionV2('t-1', 'PLANNING', 'agent-1', baseCtx());
    assert.equal(e.listOutbox().length, 1);
    const drained = e.drainOutbox();
    assert.equal(drained.length, 1);
    assert.equal(drained[0].to, 'PLANNING');
    assert.equal(e.listOutbox().length, 0);
  });
});

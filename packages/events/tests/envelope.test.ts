/**
 * Tests for the §32.1 event envelope: the bus populates occurredAt,
 * recordedAt, schemaVersion and payloadHash on every event, and producers
 * can attach the domain envelope fields (refs, aggregate, actor,
 * correlation/causation, idempotency).
 * Run: node --test dist/tests/envelope.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventBus, payloadHashOf } from '../src/index';

function fixedClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t++ };
}

describe('§32.1 event envelope', () => {
  it('populates occurredAt, recordedAt, schemaVersion and payloadHash', () => {
    const bus = new EventBus({ clock: fixedClock() });
    const e = bus.emit('TASK_CREATED', { taskId: 't1' }, 'server');
    assert.equal(e.occurredAt, e.ts, 'occurredAt mirrors ts');
    assert.ok(e.recordedAt >= e.occurredAt, 'recordedAt is not before occurredAt');
    assert.equal(e.schemaVersion, '2.0');
    assert.match(e.payloadHash, /^[0-9a-f]{64}$/, 'payloadHash is a sha256 hex string');
  });

  it('payloadHash is stable and key-order independent', () => {
    assert.equal(payloadHashOf({ b: 2, a: 1 }), payloadHashOf({ a: 1, b: 2 }));
    assert.equal(
      payloadHashOf({ a: 1 }),
      createHash('sha256').update('{"a":1}').digest('hex'),
    );
    const bus = new EventBus({ clock: fixedClock() });
    const e = bus.emit('X', { b: 2, a: 1 });
    assert.equal(e.payloadHash, payloadHashOf({ a: 1, b: 2 }));
  });

  it('attaches producer-supplied domain envelope fields', () => {
    const bus = new EventBus({ clock: fixedClock() });
    const e = bus.emit('EVIDENCE_INVALIDATION', { evidence_id: 'ev-1' }, 'qa', {
      orgRef: 'org-1',
      projectRef: 'proj-1',
      taskRef: 'task-1',
      runRef: 'run-1',
      aggregateId: 'ev-1',
      aggregateVersion: 3,
      actorId: 'qa-lead',
      actorType: 'employee',
      correlationId: 'corr-1',
      causationId: 'cause-0',
      idempotencyKey: 'idem-1',
    });
    assert.equal(e.orgRef, 'org-1');
    assert.equal(e.projectRef, 'proj-1');
    assert.equal(e.taskRef, 'task-1');
    assert.equal(e.runRef, 'run-1');
    assert.equal(e.aggregateId, 'ev-1');
    assert.equal(e.aggregateVersion, 3);
    assert.equal(e.actorId, 'qa-lead');
    assert.equal(e.actorType, 'employee');
    assert.equal(e.correlationId, 'corr-1');
    assert.equal(e.causationId, 'cause-0');
    assert.equal(e.idempotencyKey, 'idem-1');
  });

  it('omits unset optional envelope fields', () => {
    const bus = new EventBus({ clock: fixedClock() });
    const e = bus.emit('OUTCOME', {});
    assert.equal(e.orgRef, undefined);
    assert.equal(e.correlationId, undefined);
    assert.equal(e.idempotencyKey, undefined);
  });

  it('respects a producer-supplied schemaVersion', () => {
    const bus = new EventBus({ clock: fixedClock() });
    const e = bus.emit('TAKEOVER', {}, 'factory', { schemaVersion: '2.1' });
    assert.equal(e.schemaVersion, '2.1');
  });
});

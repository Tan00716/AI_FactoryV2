/** EventBus tests — spec §91. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/index.js';

const clock = (t: number) => ({ now: () => t });

describe('EventBus', () => {
  it('assigns monotonic seq and ISO timestamps', () => {
    const bus = new EventBus({ clock: clock(1_700_000_000_000) });
    const a = bus.emit('TASK_CREATED', { taskId: 't1' }, 'server');
    const b = bus.emit('TASK_STARTED', { taskId: 't1' }, 'server');
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(a.ts, new Date(1_700_000_000_000).toISOString());
    assert.equal(a.id.length > 0, true);
    assert.equal(a.source, 'server');
    assert.deepEqual(a.payload, { taskId: 't1' });
  });

  it('defaults payload to {} and source to factory', () => {
    const bus = new EventBus();
    const e = bus.emit('ERROR');
    assert.deepEqual(e.payload, {});
    assert.equal(e.source, 'factory');
  });

  it('delivers to type subscribers and wildcard subscribers', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe('TASK_CREATED', (e) => seen.push('specific:' + e.type));
    bus.subscribe('*', (e) => seen.push('wild:' + e.type));
    bus.emit('TASK_CREATED', {});
    bus.emit('ERROR', {});
    assert.deepEqual(seen, [
      'wild:TASK_CREATED',
      'specific:TASK_CREATED',
      'wild:ERROR',
    ]);
  });

  it('unsubscribe stops delivery', () => {
    const bus = new EventBus();
    let n = 0;
    const off = bus.subscribe('TASK_CREATED', () => n++);
    bus.emit('TASK_CREATED', {});
    off();
    bus.emit('TASK_CREATED', {});
    assert.equal(n, 1);
  });

  it('subscriber errors do not break other subscribers or emit', () => {
    const bus = new EventBus();
    const ok: string[] = [];
    bus.subscribe('*', () => {
      throw new Error('boom');
    });
    bus.subscribe('TASK_CREATED', (e) => ok.push(e.type));
    const e = bus.emit('TASK_CREATED', {});
    assert.equal(e.seq, 1);
    assert.deepEqual(ok, ['TASK_CREATED']);
  });

  it('retains only the most recent N events', () => {
    const bus = new EventBus({ retention: 3 });
    for (let i = 0; i < 5; i++) bus.emit('RUN_STEP', { i });
    assert.equal(bus.count(), 3);
    assert.equal(bus.lastSeq(), 5);
    const recent = bus.recent(10);
    assert.equal(recent.length, 3);
    assert.deepEqual(recent.map((e) => e.payload['i']), [4, 3, 2]);
  });

  it('recent() returns newest-first and filters by type', () => {
    const bus = new EventBus();
    bus.emit('TASK_CREATED', { n: 1 });
    bus.emit('ERROR', { n: 2 });
    bus.emit('TASK_CREATED', { n: 3 });
    const all = bus.recent(10);
    assert.deepEqual(all.map((e) => e.seq), [3, 2, 1]);
    const filtered = bus.recent(10, 'TASK_CREATED');
    assert.deepEqual(filtered.map((e) => e.payload['n']), [3, 1]);
    assert.equal(bus.recent(1).length, 1);
  });

  it('rejects empty types and non-object payloads (loose schema)', () => {
    const bus = new EventBus();
    assert.throws(() => bus.emit(''), /non-empty string/);
    assert.throws(() => bus.emit('X', [1, 2]), /JSON object/);
    assert.throws(() => bus.emit('X', 'nope'), /JSON object/);
    // Unknown-but-well-formed types are accepted (forward compatibility).
    const e = bus.emit('FUTURE_TYPE', { a: 1 });
    assert.equal(e.type, 'FUTURE_TYPE');
  });

  it('rejects non-function handlers', () => {
    const bus = new EventBus();
    assert.throws(() => bus.subscribe('X', 'nope' as never), /function/);
  });
});

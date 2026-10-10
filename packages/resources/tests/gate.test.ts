import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyGate } from '../src/index';

describe('ConcurrencyGate', () => {
  it('grants a slot immediately when the gate is free', async () => {
    const gate = new ConcurrencyGate(2);
    const release = await gate.acquire('a1');
    assert.equal(gate.inUse, 1);
    release();
    assert.equal(gate.inUse, 0);
  });

  it('queues waiters FIFO when the gate is full and wakes them on release', async () => {
    const gate = new ConcurrencyGate(1);
    const r1 = await gate.acquire('a1');
    const order: string[] = [];
    const p2 = gate.acquire('a2').then((release) => { order.push('a2'); release(); });
    const p3 = gate.acquire('a3').then((release) => { order.push('a3'); release(); });
    assert.equal(gate.queued, 2);
    r1(); // frees the slot → a2 admitted, then a2 releases → a3 admitted
    await Promise.all([p2, p3]);
    assert.deepEqual(order, ['a2', 'a3']);
    assert.equal(gate.inUse, 0);
  });

  it('lets a higher-priority waiter jump the queue (§93 P0 before P2)', async () => {
    const gate = new ConcurrencyGate(1);
    const r1 = await gate.acquire('a1');
    const order: string[] = [];
    const p2 = gate.acquire('a2', 'P2').then((release) => { order.push('a2'); release(); });
    const p0 = gate.acquire('a0', 'P0').then((release) => { order.push('a0'); release(); });
    r1();
    await Promise.all([p2, p0]);
    assert.deepEqual(order, ['a0', 'a2']);
  });

  it('keeps FIFO order within the same priority', async () => {
    const gate = new ConcurrencyGate(1);
    const r1 = await gate.acquire('a1');
    const order: string[] = [];
    const waits = ['a2', 'a3', 'a4'].map((id) =>
      gate.acquire(id, 'P1').then((release) => { order.push(id); release(); }),
    );
    r1();
    await Promise.all(waits);
    assert.deepEqual(order, ['a2', 'a3', 'a4']);
  });

  it('orders a mixed queue by priority then FIFO', async () => {
    const gate = new ConcurrencyGate(1);
    const r1 = await gate.acquire('a1');
    const order: string[] = [];
    const specs: Array<[string, 'P0' | 'P1' | 'P2' | 'P3' | 'P4']> = [
      ['p3a', 'P3'], ['p1a', 'P1'], ['p4a', 'P4'], ['p0a', 'P0'], ['p1b', 'P1'],
    ];
    const waits = specs.map(([id, pri]) =>
      gate.acquire(id, pri).then((release) => { order.push(id); release(); }),
    );
    assert.equal(gate.stats().waiting.length, 5);
    r1();
    await Promise.all(waits);
    assert.deepEqual(order, ['p0a', 'p1a', 'p1b', 'p3a', 'p4a']);
  });

  it('tryAcquire returns null instead of queueing when full', () => {
    const gate = new ConcurrencyGate(1);
    const release = gate.tryAcquire('a1');
    assert.ok(release);
    assert.equal(gate.tryAcquire('a2'), null);
    release!();
    assert.ok(gate.tryAcquire('a2'));
  });

  it('a released agent never blocks the gate for others', async () => {
    const gate = new ConcurrencyGate(2);
    const r1 = await gate.acquire('a1');
    const r2 = await gate.acquire('a2');
    assert.equal(gate.inUse, 2);
    r1();
    r2();
    const r3 = await gate.acquire('a3');
    assert.equal(gate.inUse, 1);
    r3();
  });

  it('rejects a non-positive limit', () => {
    assert.throws(() => new ConcurrencyGate(0), /positive/);
  });
});

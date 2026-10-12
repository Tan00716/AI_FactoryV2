/**
 * @ai-factory/notifications — §32 dedupe/merge + rate limiting tests.
 * Mutable injected clock so windows slide deterministically.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NotificationEngine } from '../src/engine';
import { SUPPRESSED_NOTIFICATION_TYPE } from '../src/types';

const T0 = 1_700_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function mutableClock(start = T0) {
  let now = start;
  return {
    clock: { now: () => now },
    set(ms: number) { now = ms; },
  };
}

const gateEvent = { type: 'GATE_FAILED' as const, entity: { kind: 'review', id: 'r1', label: 'auth.ts' } };

test('§32: repeats inside the window merge into one record (count, lastAt, one delivery)', () => {
  const { clock, set } = mutableClock();
  const eng = new NotificationEngine({ clock });
  const [a] = eng.emit(gateEvent);
  set(T0 + 60_000);
  const [b] = eng.emit(gateEvent);
  set(T0 + 120_000);
  const [c] = eng.emit(gateEvent);
  assert.equal(b.id, a.id);
  assert.equal(c.id, a.id);
  const list = eng.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].mergedCount, 3);
  assert.equal(list[0].createdAt, iso(T0)); // first occurrence wins
  assert.equal(list[0].lastAt, iso(T0 + 120_000));
  assert.equal(list[0].title, a.title);
  assert.equal(eng.deliveriesFor().length, 1); // merged repeats are not re-delivered
});

test('§32: dedupe window slides from lastAt, then a repeat outside starts a new record', () => {
  const { clock, set } = mutableClock();
  const eng = new NotificationEngine({ clock }); // default window 5 min
  const [a] = eng.emit(gateEvent);
  set(T0 + 4 * 60_000);
  eng.emit(gateEvent); // merges, lastAt = T0+4m
  set(T0 + 8 * 60_000);
  eng.emit(gateEvent); // 4m after lastAt -> still merges (sliding window)
  assert.equal(eng.list().length, 1);
  assert.equal(eng.get(a.id)?.mergedCount, 3);
  set(T0 + 8 * 60_000 + 5 * 60_000 + 1);
  const [fresh] = eng.emit(gateEvent); // >5m after lastAt -> new record
  assert.notEqual(fresh.id, a.id);
  assert.equal(fresh.mergedCount, 1);
  assert.equal(eng.list().length, 2);
});

test('§32: different entity, different type, or different recipient never merge', () => {
  const { clock } = mutableClock();
  const eng = new NotificationEngine({ clock });
  eng.emit(gateEvent);
  eng.emit({ type: 'GATE_FAILED', entity: { kind: 'review', id: 'r2', label: 'other.ts' } });
  eng.emit({ type: 'TASK_BLOCKED', entity: { kind: 'review', id: 'r1', label: 'auth.ts' } });
  eng.emit({ ...gateEvent, recipient: 'alice' });
  const list = eng.list();
  assert.equal(list.length, 4);
  assert.ok(list.every((n) => n.mergedCount === 1));
  // entity-less events of the same type DO share a key and merge:
  eng.emit({ type: 'GENERIC' });
  eng.emit({ type: 'GENERIC' });
  const generics = eng.list().filter((n) => n.type === 'GENERIC');
  assert.equal(generics.length, 1);
  assert.equal(generics[0].mergedCount, 2);
});

test('§32: a merge resurfaces a read record as unread', () => {
  const { clock, set } = mutableClock();
  const eng = new NotificationEngine({ clock });
  const [n] = eng.emit(gateEvent);
  eng.markRead(n.id);
  assert.equal(eng.unreadCount(), 0);
  set(T0 + 30_000);
  eng.emit(gateEvent);
  assert.equal(eng.unreadCount(), 1);
  assert.equal(eng.get(n.id)?.readAt, null);
});

test('§32: dedupeWindowMs 0 disables merging', () => {
  const { clock } = mutableClock();
  const eng = new NotificationEngine({ clock, dedupeWindowMs: 0 });
  eng.emit(gateEvent);
  eng.emit(gateEvent);
  assert.equal(eng.list().length, 2);
});

test('§32: rate limit suppresses excess new records into a queryable summary', () => {
  const { clock } = mutableClock();
  const eng = new NotificationEngine({ clock, rateLimit: { maxPerWindow: 3, windowMs: 60_000 } });
  const delivered: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    delivered.push(eng.emit({ type: 'TASK_COMPLETED', entity: { kind: 'task', id: `t${i}` } }).length);
  }
  assert.deepEqual(delivered, [1, 1, 1, 0, 0]); // suppressed emits create nothing
  assert.equal(eng.suppressedCount(), 2);
  const summaries = eng.list().filter((n) => n.type === SUPPRESSED_NOTIFICATION_TYPE);
  assert.equal(summaries.length, 1); // one summary, updated in place
  assert.equal(summaries[0].mergedCount, 2); // mergedCount == suppressed count
  assert.match(summaries[0].body, /2 notification\(s\)/);
  assert.equal(eng.list().filter((n) => n.type === 'TASK_COMPLETED').length, 3);
  assert.equal(eng.deliveriesFor().length, 4); // 3 records + 1 summary delivery
});

test('§32: merged repeats do not consume rate budget', () => {
  const { clock } = mutableClock();
  const eng = new NotificationEngine({ clock, rateLimit: { maxPerWindow: 2, windowMs: 60_000 } });
  for (let i = 0; i < 5; i += 1) eng.emit(gateEvent); // 1 new + 4 merges
  const [other] = eng.emit({ type: 'TASK_BLOCKED', entity: { kind: 'task', id: 't9' } });
  assert.ok(other);
  assert.equal(eng.suppressedCount(), 0);
  assert.equal(eng.list().length, 2);
});

test('§32: rate window rolls — delivery and a fresh count resume after expiry', () => {
  const { clock, set } = mutableClock();
  const eng = new NotificationEngine({ clock, rateLimit: { maxPerWindow: 1, windowMs: 60_000 } });
  eng.emit({ type: 'TASK_COMPLETED', entity: { kind: 'task', id: 'a' } });
  eng.emit({ type: 'TASK_COMPLETED', entity: { kind: 'task', id: 'b' } }); // suppressed
  assert.equal(eng.suppressedCount(), 1);
  set(T0 + 61_000);
  const [c] = eng.emit({ type: 'TASK_COMPLETED', entity: { kind: 'task', id: 'c' } });
  assert.ok(c);
  assert.equal(eng.suppressedCount(), 0); // new window, count reset
});

test('§32: rate limits are per recipient', () => {
  const { clock } = mutableClock();
  const eng = new NotificationEngine({ clock, rateLimit: { maxPerWindow: 1, windowMs: 60_000 } });
  eng.emit({ type: 'TASK_COMPLETED', entity: { kind: 'task', id: 'a' }, recipient: 'alice' });
  eng.emit({ type: 'TASK_COMPLETED', entity: { kind: 'task', id: 'b' }, recipient: 'alice' }); // suppressed
  const [bob] = eng.emit({ type: 'TASK_COMPLETED', entity: { kind: 'task', id: 'c' }, recipient: 'bob' });
  assert.ok(bob);
  assert.equal(eng.suppressedCount('alice'), 1);
  assert.equal(eng.suppressedCount('bob'), 0);
  assert.equal(eng.suppressedCount(), 1);
});

test('§32+§5: redaction survives merging — neither the first nor the merged secret leaks', () => {
  const { clock, set } = mutableClock();
  const eng = new NotificationEngine({ clock });
  const ev = (reason: string) => ({
    type: 'BUILD_FAILED' as const,
    entity: { kind: 'build', id: 'b1', label: 'b1' },
    detail: { reason },
  });
  eng.emit(ev('deploy failed, password=hunter2'));
  set(T0 + 10_000);
  eng.emit(ev('retry failed, password=hunter3')); // merges; first body wins
  const list = eng.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].mergedCount, 2);
  const serialized = JSON.stringify(list);
  assert.ok(!serialized.includes('hunter2'), 'first secret leaked');
  assert.ok(!serialized.includes('hunter3'), 'merged secret leaked');
  assert.match(list[0].body, /\*\*\*/);
});

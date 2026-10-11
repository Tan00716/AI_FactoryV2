/** @ai-factory/notifications — engine tests (deterministic clock). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NotificationEngine } from '../src/engine';

const clock = { now: () => 1_700_000_000_000 };

test('emit creates notification + in-app delivery record', () => {
  const eng = new NotificationEngine({ clock });
  const created = eng.emit({ type: 'GATE_FAILED', entity: { kind: 'review', id: 'r1', label: 'auth.ts' } });
  assert.equal(created.length, 1);
  const n = created[0];
  assert.equal(n.type, 'GATE_FAILED');
  assert.equal(n.priority, 'HIGH');
  assert.equal(n.read, false);
  assert.equal(n.readAt, null);
  assert.equal(n.createdAt, '2023-11-14T22:13:20.000Z');
  assert.equal(n.entity?.label, 'auth.ts');
  const del = eng.deliveriesFor(n.id);
  assert.equal(del.length, 1);
  assert.equal(del[0].channel, 'in_app');
  assert.equal(del[0].status, 'delivered');
  assert.equal(del[0].notificationId, n.id);
});

test('list is newest-first; unreadCount tracks', () => {
  const eng = new NotificationEngine({ clock });
  eng.emit({ type: 'TASK_BLOCKED', at: 1_700_000_000_000, entity: { kind: 'task', id: 't1', label: 'one' } });
  eng.emit({ type: 'DEPLOYMENT_COMPLETED', at: 1_700_000_010_000, entity: { kind: 'deployment', id: 'd1', label: 'two' } });
  const list = eng.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].entity?.label, 'two');
  assert.equal(eng.unreadCount(), 2);
});

test('markRead flips one; markAllRead flips rest', () => {
  const eng = new NotificationEngine({ clock });
  const [a, b] = eng.emit({ type: 'TASK_BLOCKED', entity: { kind: 'task', id: 't1' } });
  void b;
  const got = eng.markRead(a.id);
  assert.ok(got?.read);
  assert.ok(got?.readAt);
  assert.equal(eng.unreadCount(), 0);
  assert.equal(eng.markRead('missing'), null);
  eng.emit({ type: 'APPROVAL_PENDING', entity: { kind: 'approval', id: 'a1' } });
  eng.emit({ type: 'APPROVAL_PENDING', entity: { kind: 'approval', id: 'a2' } });
  assert.equal(eng.markAllRead(), 2);
  assert.equal(eng.unreadCount(), 0);
});

test('markRead is idempotent', () => {
  const eng = new NotificationEngine({ clock });
  const [n] = eng.emit({ type: 'GENERIC' });
  const first = eng.markRead(n.id)?.readAt;
  const second = eng.markRead(n.id)?.readAt;
  assert.equal(first, second);
});

test('maxStored evicts oldest (and its delivery)', () => {
  const eng = new NotificationEngine({ clock, maxStored: 2 });
  eng.emit({ type: 'GENERIC', detail: { n: '1' } });
  eng.emit({ type: 'GENERIC', detail: { n: '2' } });
  eng.emit({ type: 'GENERIC', detail: { n: '3' } });
  const list = eng.list();
  assert.equal(list.length, 2);
  assert.equal(list[1].createdAt, '2023-11-14T22:13:20.000Z');
  assert.equal(eng.deliveriesFor().length, 2);
});

test('emit with actor defaults to system', () => {
  const eng = new NotificationEngine({ clock });
  const [n] = eng.emit({ type: 'GENERIC' });
  assert.equal(n.actor, 'system');
  const [m] = eng.emit({ type: 'GENERIC', actor: 'human' });
  assert.equal(m.actor, 'human');
});

test('§5: secrets interpolated into title/body are redacted', () => {
  const eng = new NotificationEngine({ clock });
  const [n] = eng.emit({
    type: 'BUILD_FAILED',
    entity: { kind: 'build', id: 'b1', label: 'b1' },
    detail: { reason: 'deploy failed, password=hunter2' },
  });
  assert.ok(!n.body.includes('hunter2'), `body leaked secret: ${n.body}`);
  assert.match(n.body, /\*\*\*/);
});

test('§5: redaction also applies to custom rules via the same choke point', () => {
  const eng = new NotificationEngine({
    clock,
    rules: [
      {
        id: 'custom',
        eventTypes: ['GENERIC'],
        build: (e) => ({
          title: `custom ${String(e.detail?.['note'] ?? '')}`,
          body: `api_key=${String(e.detail?.['key'] ?? '')}`,
          priority: 'INFO' as const,
        }),
      },
    ],
  });
  const [n] = eng.emit({
    type: 'GENERIC',
    detail: { note: 'nothing secret here', key: 'sk-abcdefghijklmnop1234' },
  });
  assert.ok(!n.body.includes('sk-abcdefghijklmnop1234'));
  assert.equal(n.title, 'custom nothing secret here');
});

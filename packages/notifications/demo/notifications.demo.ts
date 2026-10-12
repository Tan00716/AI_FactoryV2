/**
 * @ai-factory/notifications demo: rule engine + in-app delivery.
 * Run: npm run build -w @ai-factory/notifications && node packages/notifications/dist/demo/notifications.demo.js
 */
import { NotificationEngine } from '../src/index';

const engine = new NotificationEngine();

for (const event of [
  { type: 'GATE_FAILED' as const, entity: { kind: 'review', id: 'r1', label: 'auth.ts' }, detail: { reason: '2 blocking findings' } },
  { type: 'TASK_BLOCKED' as const, entity: { kind: 'task', id: 't1', label: 'Login flow' } },
  { type: 'APPROVAL_PENDING' as const, entity: { kind: 'approval', id: 'a1', label: 'PROD deploy' }, detail: { riskLevel: 'HIGH' } },
  { type: 'DEPLOYMENT_COMPLETED' as const, entity: { kind: 'deployment', id: 'd1', label: 'd-1001' }, detail: { environment: 'DEV' } },
]) {
  const created = engine.emit(event);
  for (const n of created) {
    console.log(`[${n.priority}] ${n.title}\n      ${n.body}`);
  }
}
console.log(`unread: ${engine.unreadCount()}`);
const [first] = engine.list();
engine.markRead(first.id);
console.log(`after markRead: unread=${engine.unreadCount()}, deliveries=${engine.deliveriesFor().length}`);

// §32 storm control: identical repeats merge; excess new records are
// suppressed into one summary instead of flooding the recipient.
const storm = new NotificationEngine({ rateLimit: { maxPerWindow: 3, windowMs: 60_000 } });
for (let i = 0; i < 3; i += 1) {
  storm.emit({ type: 'GATE_FAILED', entity: { kind: 'review', id: 'r9', label: 'hot.ts' }, detail: { reason: 'still failing' } });
}
const merged = storm.list().find((n) => n.type === 'GATE_FAILED');
console.log(`storm: 3 identical gate failures merged into 1 record (mergedCount=${merged?.mergedCount})`);
for (let i = 0; i < 5; i += 1) {
  storm.emit({ type: 'TASK_COMPLETED', entity: { kind: 'task', id: `burst-${i}` } });
}
console.log(`burst: suppressed=${storm.suppressedCount()}, stored records=${storm.list().length} (2 delivered + 1 merged + 1 summary)`);

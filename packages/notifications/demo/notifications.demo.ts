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

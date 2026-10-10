/**
 * @ai-factory/notifications — NotificationEngine (spec module 30).
 *
 * In-memory engine: `emit(event)` runs the rule set, creates one
 * Notification per matched rule, and writes an in-app DeliveryRecord for
 * each. Read state (read/unread) is tracked per notification.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_RULES, matchRules } from './rules';
import type {
  Clock,
  DeliveryRecord,
  Notification,
  NotificationEvent,
  NotificationRule,
} from './types';

export interface EngineOptions {
  rules?: NotificationRule[];
  clock?: Clock;
  /** Cap stored notifications; oldest are evicted (default 500). */
  maxStored?: number;
}

export class NotificationEngine {
  private readonly rules: NotificationRule[];
  private readonly clock: Clock;
  private readonly maxStored: number;
  private readonly notifications: Notification[] = [];
  private readonly deliveries: DeliveryRecord[] = [];

  constructor(opts: EngineOptions = {}) {
    this.rules = opts.rules ?? DEFAULT_RULES;
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.maxStored = opts.maxStored ?? 500;
  }

  /** Run the rules for an event; returns the created notifications. */
  emit(event: NotificationEvent): Notification[] {
    const at = event.at ?? this.clock.now();
    const created: Notification[] = [];
    for (const rule of matchRules(event, this.rules)) {
      const o = rule.build(event);
      const n: Notification = {
        id: randomUUID(),
        type: o.type ?? event.type,
        title: o.title,
        body: o.body,
        priority: o.priority,
        entity: event.entity,
        actor: event.actor ?? 'system',
        read: false,
        createdAt: new Date(at).toISOString(),
        readAt: null,
      };
      this.notifications.push(n);
      created.push(n);
      this.deliveries.push({
        id: randomUUID(),
        notificationId: n.id,
        channel: 'in_app',
        status: 'delivered',
        deliveredAt: new Date(at).toISOString(),
      });
      if (this.notifications.length > this.maxStored) {
        const evicted = this.notifications.shift();
        if (evicted) {
          const idx = this.deliveries.findIndex((d) => d.notificationId === evicted.id);
          if (idx >= 0) this.deliveries.splice(idx, 1);
        }
      }
    }
    return created;
  }

  /** Newest first. */
  list(): Notification[] {
    return [...this.notifications].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  get(id: string): Notification | undefined {
    return this.notifications.find((n) => n.id === id);
  }

  unreadCount(): number {
    return this.notifications.filter((n) => !n.read).length;
  }

  markRead(id: string): Notification | null {
    const n = this.get(id);
    if (!n) return null;
    if (!n.read) {
      n.read = true;
      n.readAt = new Date(this.clock.now()).toISOString();
    }
    return n;
  }

  markAllRead(): number {
    let count = 0;
    const at = new Date(this.clock.now()).toISOString();
    for (const n of this.notifications) {
      if (!n.read) {
        n.read = true;
        n.readAt = at;
        count += 1;
      }
    }
    return count;
  }

  /** Delivery records for one notification, or all when id is omitted. */
  deliveriesFor(notificationId?: string): DeliveryRecord[] {
    const all = notificationId
      ? this.deliveries.filter((d) => d.notificationId === notificationId)
      : [...this.deliveries];
    return all.sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));
  }
}

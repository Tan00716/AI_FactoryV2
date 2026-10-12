/**
 * @ai-factory/notifications — NotificationEngine (spec module 30).
 *
 * In-memory engine: `emit(event)` runs the rule set, creates one
 * Notification per matched rule, and writes an in-app DeliveryRecord for
 * each. Read state (read/unread) is tracked per notification.
 *
 * §32 — storm control (dedupe / merge / rate limiting), in_app channel:
 *  - Dedupe/merge: repeats for the same recipient + (type, entityRef)
 *    inside `dedupeWindowMs` (sliding, measured from the record's lastAt)
 *    fold into the existing record — first title/body win, mergedCount
 *    grows, lastAt advances, and a read record resurfaces as unread.
 *    The merge key is built only from recipient/type/entity kind+id —
 *    never from title/body/detail — and merging happens after the §5
 *    redaction choke point, so dedupe can neither leak nor bypass secrets.
 *  - Rate limit: per recipient, at most `rateLimit.maxPerWindow` NEW
 *    records per `rateLimit.windowMs` (merged repeats don't consume
 *    budget). Excess records are suppressed — never silently: each
 *    suppression increments a queryable counter (suppressedCount()) and
 *    updates one SUPPRESSED_SUMMARY record in place whose mergedCount is
 *    the number suppressed in the current window. The summary itself is
 *    exempt from the rate limit.
 */
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '@ai-factory/security';
import { DEFAULT_RULES, matchRules } from './rules';
import {
  DEFAULT_RECIPIENT,
  SUPPRESSED_NOTIFICATION_TYPE,
} from './types';
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
  /**
   * §32 dedupe window in ms (sliding, from a record's last occurrence).
   * Default 300_000 (5 min). 0 disables dedupe/merge.
   */
  dedupeWindowMs?: number;
  /**
   * §32 per-recipient rate limit on NEW records. Defaults: maxPerWindow 30
   * per windowMs 60_000 (1 min). Pass maxPerWindow: Infinity to disable.
   */
  rateLimit?: { maxPerWindow?: number; windowMs?: number };
}

const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60_000;
const DEFAULT_RATE_MAX_PER_WINDOW = 30;
const DEFAULT_RATE_WINDOW_MS = 60_000;

/** Per-recipient rate-limit window state (§32). */
interface RateWindow {
  /** Epoch ms at which the current window started. */
  windowStart: number;
  /** New records delivered inside this window. */
  delivered: number;
  /** Records suppressed inside this window. */
  suppressed: number;
  /** Stored summary record standing in for the suppressed ones, if any. */
  summaryId: string | null;
}

function entityRef(entity?: { kind: string; id: string }): string {
  return entity ? `${entity.kind}:${entity.id}` : '';
}

export class NotificationEngine {
  private readonly rules: NotificationRule[];
  private readonly clock: Clock;
  private readonly maxStored: number;
  private readonly dedupeWindowMs: number;
  private readonly rateMaxPerWindow: number;
  private readonly rateWindowMs: number;
  private readonly notifications: Notification[] = [];
  private readonly deliveries: DeliveryRecord[] = [];
  private readonly rateWindows = new Map<string, RateWindow>();

  constructor(opts: EngineOptions = {}) {
    this.rules = opts.rules ?? DEFAULT_RULES;
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.maxStored = opts.maxStored ?? 500;
    this.dedupeWindowMs = opts.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.rateMaxPerWindow = opts.rateLimit?.maxPerWindow ?? DEFAULT_RATE_MAX_PER_WINDOW;
    this.rateWindowMs = opts.rateLimit?.windowMs ?? DEFAULT_RATE_WINDOW_MS;
  }

  /**
   * Run the rules for an event. Returns one record per matched rule: the
   * newly created notification, the existing record a duplicate merged
   * into, or nothing for a rule whose record was rate-limit suppressed.
   */
  emit(event: NotificationEvent): Notification[] {
    const at = event.at ?? this.clock.now();
    const recipient = event.recipient ?? DEFAULT_RECIPIENT;
    const created: Notification[] = [];
    for (const rule of matchRules(event, this.rules)) {
      const o = rule.build(event);
      // SPEC §5 — rule templates interpolate free-form event details, which
      // may carry secrets (tokens, passwords, connection strings). Redact
      // at the single choke point before anything is stored or delivered.
      const title = redactSecrets(o.title);
      const body = redactSecrets(o.body);
      const type = o.type ?? event.type;

      // §32 dedupe/merge — key from recipient + type + entityRef only
      // (never title/body/detail), checked on already-redacted records.
      const merged = this.tryMerge(recipient, type, event.entity, at);
      if (merged) {
        created.push(merged);
        continue;
      }

      // §32 rate limit — only NEW records consume the recipient's budget.
      if (!this.tryConsumeRateBudget(recipient, at)) {
        this.noteSuppressed(recipient, at);
        continue;
      }

      const n: Notification = {
        id: randomUUID(),
        type,
        title,
        body,
        priority: o.priority,
        entity: event.entity,
        actor: event.actor ?? 'system',
        read: false,
        createdAt: new Date(at).toISOString(),
        readAt: null,
        recipient,
        mergedCount: 1,
        lastAt: new Date(at).toISOString(),
      };
      this.storeRecord(n, at);
      created.push(n);
    }
    return created;
  }

  /**
   * §32 — fold a repeat into the newest matching stored record when its
   * last occurrence is inside the dedupe window. First title/body/priority
   * win; mergedCount grows, lastAt advances, a read record resurfaces as
   * unread (it happened again). Returns the record, or null if no merge.
   */
  private tryMerge(
    recipient: string,
    type: string,
    entity: NotificationEvent['entity'],
    at: number,
  ): Notification | null {
    if (this.dedupeWindowMs <= 0) return null;
    const ref = entityRef(entity);
    for (let i = this.notifications.length - 1; i >= 0; i -= 1) {
      const n = this.notifications[i];
      if ((n.recipient ?? DEFAULT_RECIPIENT) !== recipient) continue;
      if (n.type !== type) continue;
      if (entityRef(n.entity) !== ref) continue;
      const lastMs = Date.parse(n.lastAt ?? n.createdAt);
      if (Math.abs(at - lastMs) > this.dedupeWindowMs) continue;
      n.mergedCount = (n.mergedCount ?? 1) + 1;
      if (at > lastMs) n.lastAt = new Date(at).toISOString();
      if (n.read) {
        n.read = false;
        n.readAt = null;
      }
      return n;
    }
    return null;
  }

  /**
   * §32 — take one slot of the recipient's current rate window for a NEW
   * record. Rolls the window when it has expired. False when at the cap.
   */
  private tryConsumeRateBudget(recipient: string, at: number): boolean {
    if (!Number.isFinite(this.rateMaxPerWindow)) return true;
    let w = this.rateWindows.get(recipient);
    if (!w) {
      w = { windowStart: at, delivered: 0, suppressed: 0, summaryId: null };
      this.rateWindows.set(recipient, w);
    } else if (at - w.windowStart >= this.rateWindowMs) {
      w.windowStart = at;
      w.delivered = 0;
      w.suppressed = 0;
      w.summaryId = null;
    }
    if (w.delivered >= this.rateMaxPerWindow) return false;
    w.delivered += 1;
    return true;
  }

  /**
   * §32 — record a suppression: bump the recipient's counter and refresh
   * the single SUPPRESSED_SUMMARY record for the current window (created
   * on first suppression, updated in place afterwards). The summary is
   * exempt from the rate limit but stored/delivered like any record.
   */
  private noteSuppressed(recipient: string, at: number): void {
    const w = this.rateWindows.get(recipient);
    if (!w) return; // unreachable: tryConsumeRateBudget ran first
    w.suppressed += 1;
    const body =
      `${w.suppressed} notification(s) for recipient "${recipient}" were suppressed ` +
      `in the current rate-limit window (max ${this.rateMaxPerWindow} new notifications ` +
      `per ${this.rateWindowMs}ms). They were deduplicated into this summary instead ` +
      `of being delivered one by one.`;
    const existing = w.summaryId ? this.get(w.summaryId) : undefined;
    if (existing) {
      existing.body = body;
      existing.mergedCount = w.suppressed;
      existing.lastAt = new Date(at).toISOString();
      if (existing.read) {
        existing.read = false;
        existing.readAt = null;
      }
      return;
    }
    const n: Notification = {
      id: randomUUID(),
      type: SUPPRESSED_NOTIFICATION_TYPE,
      title: 'Notifications suppressed (rate limit)',
      body,
      priority: 'LOW',
      entity: { kind: 'recipient', id: recipient },
      actor: 'system',
      read: false,
      createdAt: new Date(at).toISOString(),
      readAt: null,
      recipient,
      mergedCount: w.suppressed,
      lastAt: new Date(at).toISOString(),
    };
    this.storeRecord(n, at);
    w.summaryId = n.id;
  }

  /**
   * §32 — notifications suppressed by the rate limiter in the current
   * window: for one recipient, or the total across recipients when omitted.
   * Windows roll on the recipient's next emit after expiry, so a count is
   * "current" as of that recipient's last event.
   */
  suppressedCount(recipient?: string): number {
    if (recipient !== undefined) {
      return this.rateWindows.get(recipient)?.suppressed ?? 0;
    }
    let total = 0;
    for (const w of this.rateWindows.values()) total += w.suppressed;
    return total;
  }

  /** Store a record + its in-app delivery, evicting the oldest at the cap. */
  private storeRecord(n: Notification, at: number): void {
    this.notifications.push(n);
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

/**
 * Persistent notification center (server side).
 *
 * The spec-module-30 NotificationEngine was in-memory only (lost on
 * restart). This module makes it durable:
 *
 *   PersistentNotificationEngine extends NotificationEngine and persists
 *   the notification list to a JSON file after every mutation (emit /
 *   markRead / markAllRead / clear). Persistence follows the
 *   session-store convention: atomic temp+rename writes, fail-closed on
 *   corrupt files (serve empty, refuse writes — never silently drop).
 *
 * Injection quarantine (W-B lesson): notification titles/bodies carry
 * user-controlled text (task titles, run outcomes, needsHuman reasons).
 * The emit choke point runs every user-controlled string through
 * classifyContent; strings flagged EXTERNAL_CONTENT go through
 * sanitizeUntrusted, benign DATA passes through unchanged (so ordinary
 * titles are not mangled by the quarantine format).
 *
 * Delivery failures must never break the caller's flow (a corrupt
 * notification file must not fail a run): persist() throws
 * NotificationStoreError on a corrupt store, and background emit sites
 * catch + log it. HTTP routes surface it as a 500 via the shared
 * handler — fail-closed, not silent.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NotificationEngine,
  type Notification,
  type NotificationEvent,
} from '@ai-factory/notifications';
import { classifyContent, sanitizeUntrusted } from '@ai-factory/security';

export function notificationStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_NOTIFICATION_STORE_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'notifications.json');
}

export class NotificationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationStoreError';
  }
}

/** Atomic write: write temp file then rename (crash-safe, same as plan-store). */
function atomicWriteJson(path: string, payload: unknown): void {
  const dir = resolve(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, path);
}

function isValidNotification(n: unknown): n is Notification {
  if (!n || typeof n !== 'object') return false;
  const r = n as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['type'] === 'string' &&
    typeof r['title'] === 'string' &&
    typeof r['body'] === 'string' &&
    typeof r['priority'] === 'string' &&
    typeof r['actor'] === 'string' &&
    typeof r['read'] === 'boolean' &&
    typeof r['createdAt'] === 'string'
  );
}

function loadNotifications(path: string): { initial: Notification[]; corrupt: boolean } {
  if (!existsSync(path)) return { initial: [], corrupt: false };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { notifications?: unknown[] };
    const initial: Notification[] = [];
    for (const n of raw.notifications ?? []) {
      if (isValidNotification(n)) initial.push(n);
    }
    return { initial, corrupt: false };
  } catch {
    // Fail-closed: serve empty, refuse writes — never silently drop.
    return { initial: [], corrupt: true };
  }
}

/**
 * Quarantine user-controlled text at the emit choke point. Only strings
 * the classifier flags as EXTERNAL_CONTENT (override attempts, external
 * markers) go through sanitizeUntrusted; ordinary DATA passes through
 * unchanged.
 */
function quarantineUserText(value: string): string {
  if (classifyContent(value).kind === 'EXTERNAL_CONTENT') {
    return sanitizeUntrusted(value).sanitized;
  }
  return value;
}

function sanitizeEventText(event: NotificationEvent): NotificationEvent {
  const entity = event.entity;
  const cleanEntity =
    entity && typeof entity.label === 'string'
      ? { ...entity, label: quarantineUserText(entity.label) }
      : entity;
  let detail = event.detail;
  if (detail) {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(detail)) {
      clean[k] = typeof v === 'string' ? quarantineUserText(v) : v;
    }
    detail = clean;
  }
  return { ...event, entity: cleanEntity, detail };
}

export class PersistentNotificationEngine extends NotificationEngine {
  private readonly path: string;
  private corrupt: boolean;

  constructor(path: string = notificationStorePath()) {
    const { initial, corrupt } = loadNotifications(path);
    super({ initial });
    this.path = path;
    this.corrupt = corrupt;
  }

  isCorrupt(): boolean {
    return this.corrupt;
  }

  private persist(): void {
    if (this.corrupt) {
      throw new NotificationStoreError('notification store is corrupt; refusing writes');
    }
    atomicWriteJson(this.path, { notifications: this.list() });
  }

  override emit(event: NotificationEvent): Notification[] {
    const created = super.emit(sanitizeEventText(event));
    this.persist();
    return created;
  }

  override markRead(id: string): Notification | null {
    const n = super.markRead(id);
    if (n) this.persist();
    return n;
  }

  override markAllRead(): number {
    const count = super.markAllRead();
    if (count > 0) this.persist();
    return count;
  }

  /** Delete read notifications; returns the count removed. */
  clearRead(): number {
    const removed = super.removeRead();
    if (removed > 0) this.persist();
    return removed;
  }

  /** Delete every notification; returns the count removed. */
  clearAll(): number {
    const removed = super.clear();
    if (removed > 0) this.persist();
    return removed;
  }
}

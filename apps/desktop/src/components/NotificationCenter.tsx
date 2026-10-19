import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang } from '../i18n';

/** Typed client for the notification endpoints (spec module 30). */
export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  entity?: { kind: string; id: string; label?: string };
  actor: string;
  read: boolean;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationCenterApi {
  list(): Promise<{ notifications: NotificationItem[]; unread: number }>;
  read(id: string): Promise<{ notification: NotificationItem; unread: number }>;
  readAll(): Promise<{ marked: number; unread: number }>;
  clear(all?: boolean): Promise<{ cleared: number; notifications: NotificationItem[]; unread: number }>;
}

async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export function createNotificationCenterApi(base: string = defaultApiBase()): NotificationCenterApi {
  return {
    list: () => req(base, '/notifications'),
    read: (id) => req(base, `/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
    readAll: () => req(base, '/notifications/read-all', { method: 'POST' }),
    clear: (all) =>
      req(base, '/notifications/clear', {
        method: 'POST',
        body: JSON.stringify(all ? { all: true } : {}),
      }),
  };
}

const PRIORITY_CLASS: Record<NotificationItem['priority'], string> = {
  HIGH: 'st-failed',
  MEDIUM: 'st-working',
  LOW: 'st-idle',
  INFO: 'st-active',
};

/**
 * Notification center: bell + unread badge + dropdown list.
 * Polls the server; clicking an item marks it read; "mark all read" and
 * "clear read" are one click away.
 *
 * OS desktop notifications: when a poll surfaces a notification id we
 * have never seen, it is forwarded to the Electron main process via the
 * preload bridge (window.aiFactory.notify) so the human is pinged even
 * with the app in the background. First poll only seeds the seen set
 * (no retroactive popups for old items).
 */
export function NotificationCenter({ base }: { base: string }) {
  const { t } = useLang();
  const [api] = useState<NotificationCenterApi>(() => createNotificationCenterApi(base));
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const firstPollRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const { notifications, unread: u } = await api.list();
      if (firstPollRef.current) {
        // Seed only — don't popup for items that predate this session.
        for (const n of notifications) seenRef.current.add(n.id);
        firstPollRef.current = false;
      } else {
        for (const n of notifications) {
          if (!n.read && !seenRef.current.has(n.id)) {
            seenRef.current.add(n.id);
            try {
              window.aiFactory?.notify(n.title, n.body);
            } catch {
              // Bridge absent (plain browser) or failed — in-app list is
              // the fallback; never break the poll loop.
            }
          }
        }
        // Prune ids that no longer exist (cleared server-side).
        const alive = new Set(notifications.map((n) => n.id));
        for (const id of seenRef.current) {
          if (!alive.has(id)) seenRef.current.delete(id);
        }
      }
      setItems(notifications);
      setUnread(u);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const markRead = async (id: string) => {
    try {
      const { notification, unread: u } = await api.read(id);
      setItems((prev) => prev.map((n) => (n.id === id ? notification : n)));
      setUnread(u);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const markAll = async () => {
    try {
      const { unread: u } = await api.readAll();
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnread(u);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const clearRead = async () => {
    try {
      const { notifications, unread: u } = await api.clear(false);
      setItems(notifications);
      setUnread(u);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="notif-bell" style={{ position: 'relative' }}>
      <button
        className="bell-btn"
        title={error ? t('notif.unavailable', { message: error }) : t('notif.bellTitle')}
        onClick={() => { setOpen((o) => !o); if (!open) refresh(); }}
      >
        🔔
        {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-dropdown">
          <div className="notif-head">
            <b>{t('notif.title')}</b>
            <button onClick={markAll} disabled={unread === 0}>{t('notif.markAllRead')}</button>
            <button onClick={clearRead} disabled={items.every((n) => !n.read)}>{t('notif.clearRead')}</button>
          </div>
          {error && <div className="pill warn" style={{ margin: 8 }}>{t('notif.loadFailed', { message: error })}</div>}
          {!error && items.length === 0 && <div className="muted" style={{ padding: 8 }}>{t('notif.empty')}</div>}
          <ul className="ev-list notif-list">
            {items.slice(0, 20).map((n) => (
              <li
                key={n.id}
                className={n.read ? 'notif-read' : 'notif-unread'}
                onClick={() => { if (!n.read) markRead(n.id); }}
                title={n.read ? n.title : t('notif.clickToMark')}
              >
                <span className={`status-dot ${PRIORITY_CLASS[n.priority]}`} />
                <div style={{ flex: 1 }}>
                  <div><b>{n.title}</b></div>
                  <div className="muted" style={{ fontSize: 12 }}>{n.body}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    <span className="pill">{n.priority}</span>{' '}
                    {n.entity?.label && <span>{n.entity.kind}: {n.entity.label}</span>}{' '}
                    {new Date(n.createdAt).toLocaleString()}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

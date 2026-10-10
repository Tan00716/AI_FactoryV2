import { useCallback, useEffect, useState } from 'react';

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

export interface NotificationsApi {
  list(): Promise<{ notifications: NotificationItem[]; unread: number }>;
  read(id: string): Promise<{ notification: NotificationItem; unread: number }>;
  readAll(): Promise<{ marked: number; unread: number }>;
}

async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export function createNotificationsApi(base: string = 'http://localhost:3100/api'): NotificationsApi {
  return {
    list: () => req(base, '/notifications'),
    read: (id) => req(base, `/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
    readAll: () => req(base, '/notifications/read-all', { method: 'POST' }),
  };
}

const PRIORITY_CLASS: Record<NotificationItem['priority'], string> = {
  HIGH: 'st-failed',
  MEDIUM: 'st-working',
  LOW: 'st-idle',
  INFO: 'st-active',
};

/**
 * Top-bar notification bell (spec module 30): unread badge + dropdown list.
 * Polls the server; clicking an item marks it read.
 */
export function NotificationsBell({ base }: { base: string }) {
  const [api] = useState<NotificationsApi>(() => createNotificationsApi(base));
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { notifications, unread: u } = await api.list();
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

  return (
    <div className="notif-bell" style={{ position: 'relative' }}>
      <button
        className="bell-btn"
        title={error ? `Notifications unavailable: ${error}` : 'Notifications'}
        onClick={() => { setOpen((o) => !o); if (!open) refresh(); }}
      >
        🔔
        {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-dropdown">
          <div className="notif-head">
            <b>Notifications</b>
            <button onClick={markAll} disabled={unread === 0}>Mark all read</button>
          </div>
          {items.length === 0 && <div className="muted" style={{ padding: 8 }}>No notifications.</div>}
          <ul className="ev-list notif-list">
            {items.slice(0, 20).map((n) => (
              <li
                key={n.id}
                className={n.read ? 'notif-read' : 'notif-unread'}
                onClick={() => { if (!n.read) markRead(n.id); }}
                title={n.read ? n.title : 'Click to mark read'}
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

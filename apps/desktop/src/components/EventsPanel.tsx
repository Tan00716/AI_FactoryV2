import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * System Event Bus panel — spec §91.
 * Realtime bus stream (polls GET /api/events) with multi-select filtering
 * by event type.
 */

export interface BusEvent {
  seq: number;
  id: string;
  type: string;
  ts: string;
  source: string;
  payload: Record<string, unknown>;
}

export interface EventsApi {
  list(type?: string, limit?: number): Promise<{ events: BusEvent[]; total: number; types: string[] }>;
  emit(type: string, payload?: object, source?: string): Promise<BusEvent>;
}

/** fetch client mirroring apps/desktop/src/api.ts `req`. */
export function createEventsApi(base = 'http://localhost:3100/api'): EventsApi {
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = (await res.json()) as T;
    if (!res.ok) {
      const e = new Error(
        (body as { error?: string }).error ?? `HTTP ${res.status}`,
      ) as Error & { status: number };
      e.status = res.status;
      throw e;
    }
    return body;
  }
  return {
    list: (type, limit = 100) =>
      req<{ events: BusEvent[]; total: number; types: string[] }>(
        `/events?limit=${limit}${type ? `&type=${encodeURIComponent(type)}` : ''}`,
      ),
    emit: (type, payload, source) =>
      req<BusEvent>('/events/emit', {
        method: 'POST',
        body: JSON.stringify({ type, payload, source }),
      }),
  };
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString();
}

export interface EventsPanelProps {
  api?: EventsApi;
  /** ms between refreshes; 0 disables polling. Default 3000. */
  pollMs?: number;
}

export function EventsPanel({ api, pollMs = 3000 }: EventsPanelProps) {
  const client = api ?? createEventsApi();
  const [events, setEvents] = useState<BusEvent[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    client
      .list(undefined, 200)
      .then((r) => {
        setEvents(r.events);
        setTypes(r.types ?? []);
      })
      .catch((e: Error) => setError(e.message));
  }, [client]);

  useEffect(() => {
    refresh();
    if (!pollMs) return;
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  const toggle = (t: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const visible = useMemo(
    () => (selected.size === 0 ? events : events.filter((e) => selected.has(e.type))),
    [events, selected],
  );

  return (
    <div className="events-panel">
      <div className="board-head">
        <h2>Events <span className="count">§91</span></h2>
        <span className="muted">
          {visible.length} shown · live
          {selected.size > 0 && (
            <>
              {' '}· <button className="link" onClick={() => setSelected(new Set())}>clear filter</button>
            </>
          )}
        </span>
      </div>
      {error && <div className="banner err">{error}</div>}

      <div className="filter-box">
        <div className="muted" style={{ marginBottom: 4 }}>
          Filter by event type ({selected.size} selected):
        </div>
        <div className="filter-grid">
          {types.map((t) => (
            <label key={t} className={`filter-chip${selected.has(t) ? ' on' : ''}`}>
              <input
                type="checkbox"
                checked={selected.has(t)}
                onChange={() => toggle(t)}
              />
              {t}
            </label>
          ))}
        </div>
      </div>

      {visible.length === 0 && <div className="muted">No events yet.</div>}
      {visible.map((e) => (
        <div key={e.seq} className="act-row">
          <span className="muted act-ts">{fmtTime(e.ts)}</span>
          <span className="muted">#{e.seq}</span>
          <span className="pill">{e.type}</span>
          <span className="muted">{e.source}</span>
          <span className="muted">{JSON.stringify(e.payload).slice(0, 160)}</span>
        </div>
      ))}
    </div>
  );
}

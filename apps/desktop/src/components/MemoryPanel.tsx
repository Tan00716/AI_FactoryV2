import { useCallback, useEffect, useState } from 'react';

/** Typed client for the memory endpoints (mirrors the req pattern in api.ts). */
export interface MemoryEntry {
  id: string;
  scope: string;
  scopeId: string;
  type: string;
  title: string;
  content: string;
  source: string;
  confidence: number;
  createdBy: string;
  evidenceIds: string[];
  lastVerifiedAt: string;
  applicableScope: string;
  expiresAt: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryApi {
  query(params?: { scope?: string; type?: string }): Promise<{ entries: MemoryEntry[] }>;
  write(entry: {
    scope: string; scopeId?: string; type: string; title: string;
    content?: string; source?: string; confidence?: number; createdBy?: string;
  }): Promise<{ entry: MemoryEntry }>;
  verify(id: string): Promise<{ entry: MemoryEntry }>;
}

const DEFAULT_BASE = 'http://localhost:3100/api';

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

export function createMemoryApi(base: string = DEFAULT_BASE): MemoryApi {
  return {
    query: (params) => {
      const q = new URLSearchParams();
      if (params?.scope) q.set('scope', params.scope);
      if (params?.type) q.set('type', params.type);
      const qs = q.toString();
      return req(base, `/memory${qs ? `?${qs}` : ''}`);
    },
    write: (entry) => req(base, '/memory', { method: 'POST', body: JSON.stringify(entry) }),
    verify: (id) => req(base, `/memory/${encodeURIComponent(id)}/verify`, { method: 'POST', body: '{}' }),
  };
}

const SCOPES = ['employee', 'project', 'organization', 'task', 'system'] as const;
const TYPES = ['Fact', 'Decision', 'Pattern', 'Lesson', 'Failure', 'Preference', 'Constraint', 'Solution', 'KnownIssue'] as const;

function confClass(c: number): string {
  if (c >= 0.7) return 'st-working';
  if (c >= 0.4) return 'st-active';
  return 'st-failed';
}

/**
 * Memory panel (§54–§56): browse entries by scope layer, confidence badges,
 * write form (dedup/merge on the server), verify action.
 */
export function MemoryPanel(props: { memory?: MemoryApi }) {
  const [api] = useState<MemoryApi>(() => props.memory ?? createMemoryApi());
  const [scope, setScope] = useState<string>('project');
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fType, setFType] = useState<string>('Lesson');
  const [fTitle, setFTitle] = useState('');
  const [fContent, setFContent] = useState('');

  const refresh = useCallback(async () => {
    try {
      const { entries: e } = await api.query({ scope });
      setEntries(e);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, scope]);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="memory-panel">
      {error && <div className="banner err">{error}</div>}
      <div className="row" style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {SCOPES.map((s) => (
          <button key={s} className={scope === s ? 'active' : ''} onClick={() => setScope(s)}>
            {s}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span className="muted">{entries.length} entries</span>
      </div>
      <div className="row" style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <select value={fType} onChange={(e) => setFType(e.target.value)}>
          {TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input value={fTitle} onChange={(e) => setFTitle(e.target.value)} placeholder="Title" style={{ flex: 1 }} />
        <input value={fContent} onChange={(e) => setFContent(e.target.value)} placeholder="Content" style={{ flex: 2 }} />
        <button
          disabled={busy || !fTitle}
          onClick={() => run(() => api.write({ scope, type: fType, title: fTitle, content: fContent, scopeId: 'ui' }))}
        >
          Write
        </button>
      </div>
      {entries.length === 0 && <p className="muted">No entries in this scope yet.</p>}
      <ul className="ev-list">
        {entries.map((e) => (
          <li key={e.id} style={{ marginBottom: 6 }}>
            <span className={`status-dot ${confClass(e.confidence)}`} style={{ display: 'inline-block', marginRight: 6 }} />
            <b>{e.title}</b>{' '}
            <span className="pill">{e.type}</span>{' '}
            <span className="pill">conf {e.confidence.toFixed(2)}</span>{' '}
            <span className="pill">{e.status}</span>
            <button disabled={busy} style={{ marginLeft: 8 }} onClick={() => run(() => api.verify(e.id))}>
              Verify
            </button>
            <div className="muted" style={{ marginTop: 2 }}>{e.content}</div>
            <div className="muted" style={{ fontSize: 11 }}>
              src: {e.source} · by {e.createdBy} · verified {e.lastVerifiedAt.slice(0, 10)}
              {e.expiresAt ? ` · expires ${e.expiresAt.slice(0, 10)}` : ''}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

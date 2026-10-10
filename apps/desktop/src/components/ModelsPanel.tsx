import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Model Registry — spec §90.
 * Table of provider / model / capability / context / reasoning / cost /
 * latency / availability / fallback, filterable by capability.
 */

export interface ModelRow {
  provider: string;
  model: string;
  capability: string[];
  context: 'small' | 'medium' | 'large';
  reasoning: boolean;
  cost: 'low' | 'high';
  latency: 'low' | 'high';
  availability: string;
  fallback: string | null;
}

export interface ModelsApi {
  list(): Promise<{ models: ModelRow[] }>;
}

/** fetch client mirroring apps/desktop/src/api.ts `req`. */
export function createModelsApi(base = 'http://localhost:3100/api'): ModelsApi {
  async function req<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      headers: { 'Content-Type': 'application/json' },
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
    list: () => req<{ models: ModelRow[] }>('/models'),
  };
}

const ALL_CAPS = ['reasoning', 'vision', 'tools'] as const;

export interface ModelsPanelProps {
  api?: ModelsApi;
  /** ms between refreshes; 0 disables polling. Default 15000. */
  pollMs?: number;
}

export function ModelsPanel({ api, pollMs = 15000 }: ModelsPanelProps) {
  const client = api ?? createModelsApi();
  const [models, setModels] = useState<ModelRow[]>([]);
  const [error, setError] = useState('');
  const [caps, setCaps] = useState<Set<string>>(new Set());
  const [provider, setProvider] = useState('');

  const refresh = useCallback(() => {
    client
      .list()
      .then((r) => setModels(r.models))
      .catch((e: Error) => setError(e.message));
  }, [client]);

  useEffect(() => {
    refresh();
    if (!pollMs) return;
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  const providers = useMemo(
    () => [...new Set(models.map((m) => m.provider))],
    [models],
  );

  const visible = useMemo(
    () =>
      models.filter(
        (m) =>
          (provider === '' || m.provider === provider) &&
          [...caps].every((c) => m.capability.includes(c)),
      ),
    [models, provider, caps],
  );

  const toggleCap = (c: string) => {
    setCaps((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  return (
    <div className="models-panel">
      <div className="board-head">
        <h2>Models <span className="count">§90</span></h2>
        <span className="muted">{visible.length} of {models.length} models</span>
      </div>
      {error && <div className="banner err">{error}</div>}

      <div className="filter-box">
        <label className="muted">
          Provider:{' '}
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">all</option>
            {providers.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <span className="muted" style={{ marginLeft: 12 }}>Capability:</span>
        {ALL_CAPS.map((c) => (
          <label key={c} className={`filter-chip${caps.has(c) ? ' on' : ''}`}>
            <input type="checkbox" checked={caps.has(c)} onChange={() => toggleCap(c)} />
            {c}
          </label>
        ))}
        {(caps.size > 0 || provider !== '') && (
          <button
            className="link"
            style={{ marginLeft: 8 }}
            onClick={() => { setCaps(new Set()); setProvider(''); }}
          >
            clear
          </button>
        )}
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Model</th>
            <th>Capability</th>
            <th>Context</th>
            <th>Reasoning</th>
            <th>Cost</th>
            <th>Latency</th>
            <th>Availability</th>
            <th>Fallback</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((m) => (
            <tr key={`${m.provider}:${m.model}`}>
              <td>{m.provider}</td>
              <td><code>{m.model}</code></td>
              <td>
                {m.capability.map((c) => (
                  <span key={c} className="pill" style={{ marginRight: 4 }}>{c}</span>
                ))}
              </td>
              <td>{m.context}</td>
              <td>{m.reasoning ? 'yes' : 'no'}</td>
              <td>{m.cost}</td>
              <td>{m.latency}</td>
              <td>
                <span className={`pill ${m.availability === 'online' ? 'ok' : m.availability === 'degraded' ? 'warn' : ''}`}>
                  {m.availability}
                </span>
              </td>
              <td><code>{m.fallback ?? '—'}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
      {visible.length === 0 && <div className="muted">No models match the filter.</div>}
      <div className="muted" style={{ marginTop: 8 }}>
        The router (§30) uses this capability metadata rather than hard-coded model names.
      </div>
    </div>
  );
}

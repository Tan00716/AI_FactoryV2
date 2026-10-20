import { useCallback, useEffect, useMemo, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang } from '../i18n';

/** Server response shapes (subset of apps/server/src/inspections.ts). */
export interface InspectionFinding {
  id: string;
  checker: string;
  severity: 'info' | 'warning' | 'error';
  file: string;
  line: number | null;
  message: string;
}

export interface InspectionProfile {
  version: 1;
  name: string;
  maxFileLines: number;
  maxFunctionLines: number;
  checkers: Record<string, boolean>;
  licenseAudit: boolean;
}

export interface InspectionTotals {
  total: number;
  info: number;
  warning: number;
  error: number;
  byChecker: Record<string, number>;
}

export interface LicenseAuditView {
  scanned: boolean;
  nodeModulesPresent: boolean;
  total: number;
  permissive: number;
  other: number;
  copyleft: Array<{ name: string; version: string; license: string }>;
  unknown: Array<{ name: string; version: string; license: string; reason: string }>;
  note: string;
}

export interface InspectionRunView {
  runId: string;
  root: string;
  profileName: string;
  profileSource: string;
  profileNote: string;
  durationMs: number;
  filesScanned: number;
  totals: InspectionTotals;
  newCount: number;
  newFindings: InspectionFinding[];
  baselineEstablished: boolean;
  licenses: LicenseAuditView | null;
}

export interface InspectionHistoryEntry {
  runId: string;
  at: string;
  total: number;
  newCount: number;
  byChecker: Record<string, number>;
  profileName: string;
  baselineEstablished: boolean;
}

export interface InspectionsApi {
  overview(projectId: string, root?: string): Promise<{
    profile: InspectionProfile;
    profileSource: string;
    profileNote: string;
    baseline: { exists: boolean; establishedAt?: string; signatures?: number };
    lastRun: InspectionHistoryEntry | null;
  }>;
  saveProfile(projectId: string, root: string, profile: InspectionProfile): Promise<InspectionProfile>;
  run(projectId: string, root?: string): Promise<InspectionRunView>;
  history(projectId: string): Promise<InspectionHistoryEntry[]>;
  rebaseline(projectId: string, root?: string): Promise<{ baseline: { exists: boolean; establishedAt?: string; signatures?: number } }>;
}

export function createInspectionsApi(base: string): InspectionsApi {
  const q = (projectId: string, root?: string) =>
    `?projectId=${encodeURIComponent(projectId)}${root ? `&root=${encodeURIComponent(root)}` : ''}`;
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, { headers: { ...authHeaders() }, ...init });
    const body = (await res.json()) as T;
    if (!res.ok) {
      const err = body as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return body;
  }
  return {
    overview: (projectId, root) => req(`/inspections${q(projectId, root)}`),
    saveProfile: (projectId, root, profile) =>
      req<{ projectId: string; root: string; profile: InspectionProfile }>('/inspections/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, root, profile }),
      }).then((r) => r.profile),
    run: (projectId, root) =>
      req<InspectionRunView>('/inspections/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, ...(root ? { root } : {}) }),
      }),
    history: (projectId) =>
      req<{ projectId: string; runs: InspectionHistoryEntry[] }>(`/inspections/history?projectId=${encodeURIComponent(projectId)}`).then(
        (r) => r.runs,
      ),
    rebaseline: (projectId, root) =>
      req<{ projectId: string; root: string; baseline: { exists: boolean; establishedAt?: string; signatures?: number } }>(
        '/inspections/baseline',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, ...(root ? { root } : {}) }),
        },
      ).then((r) => ({ baseline: r.baseline })),
  };
}

export function defaultInspectionsApi(): InspectionsApi {
  return createInspectionsApi(defaultApiBase());
}

/** Minimal zero-dependency SVG line chart. */
function LineChart(props: { series: Array<{ label: string; color: string; points: number[] }>; height?: number }) {
  const { series, height = 150 } = props;
  const width = 560;
  const pad = { l: 44, r: 8, t: 8, b: 18 };
  const all = series.flatMap((s) => s.points);
  const max = Math.max(1, ...all);
  const min = 0;
  const x = (i: number, n: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (width - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min)) * (height - pad.t - pad.b);
  const ticks = [0, 0.5, 1].map((f) => min + f * (max - min));
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" style={{ display: 'block' }}>
      {ticks.map((tv, i) => (
        <g key={i}>
          <line x1={pad.l} x2={width - pad.r} y1={y(tv)} y2={y(tv)} stroke="#2a2f3a" strokeWidth={1} />
          <text x={pad.l - 6} y={y(tv) + 4} textAnchor="end" fontSize={10} fill="#8b93a3">
            {tv >= 100 ? Math.round(tv) : tv.toFixed(1)}
          </text>
        </g>
      ))}
      {series.map((s) =>
        s.points.length > 1 ? (
          <polyline
            key={s.label}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            points={s.points.map((p, i) => `${x(i, s.points.length)},${y(p)}`).join(' ')}
          />
        ) : null,
      )}
      {series.map((s, si) => (
        <g key={s.label}>
          <rect x={pad.l + si * 150} y={height - 14} width={10} height={10} fill={s.color} />
          <text x={pad.l + si * 150 + 14} y={height - 5} fontSize={11} fill="#c9d1d9">
            {s.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

const CHECKER_IDS = ['todo-fixme', 'long-file', 'long-function', 'console-log'];

export function InspectionsPanel({ api, projectId }: { api: InspectionsApi; projectId: string }) {
  const { t } = useLang();
  const [root, setRoot] = useState('');
  const [profile, setProfile] = useState<InspectionProfile | null>(null);
  const [profileSource, setProfileSource] = useState('');
  const [profileNote, setProfileNote] = useState('');
  const [baseline, setBaseline] = useState<{ exists: boolean; establishedAt?: string; signatures?: number }>({ exists: false });
  const [run, setRun] = useState<InspectionRunView | null>(null);
  const [history, setHistory] = useState<InspectionHistoryEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, hist] = await Promise.all([
        api.overview(projectId, root.trim() || undefined),
        api.history(projectId),
      ]);
      setProfile(ov.profile);
      setProfileSource(ov.profileSource);
      setProfileNote(ov.profileNote);
      setBaseline(ov.baseline);
      setHistory(hist);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('inspections.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [api, projectId, root, t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const doRun = useCallback(async () => {
    setRunning(true);
    setMsg(null);
    try {
      const r = await api.run(projectId, root.trim() || undefined);
      setRun(r);
      setHistory(await api.history(projectId));
      setMsg(
        t('inspections.runDone', {
          total: r.totals.total,
          newCount: r.newCount,
          verdict: r.newCount > 0 ? t('inspections.hasNew') : t('inspections.clean'),
        }),
      );
    } catch (e) {
      setMsg(t('inspections.runFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRunning(false);
    }
  }, [api, projectId, root, t]);

  const doRebaseline = useCallback(async () => {
    if (!window.confirm(t('inspections.rebaselineConfirm'))) return;
    try {
      const r = await api.rebaseline(projectId, root.trim() || undefined);
      setBaseline(r.baseline);
      setMsg(t('inspections.rebased', { count: r.baseline.signatures ?? 0 }));
    } catch (e) {
      setMsg(t('inspections.runFailed', { message: e instanceof Error ? e.message : String(e) }));
    }
  }, [api, projectId, root, t]);

  const saveProfile = useCallback(async () => {
    if (!profile) return;
    try {
      const p = await api.saveProfile(projectId, root.trim() || '', profile);
      setProfile(p);
      setProfileSource('file');
      setProfileNote(t('inspections.profileSavedNote'));
      setMsg(t('inspections.saved'));
    } catch (e) {
      setMsg(t('inspections.saveFailed', { message: e instanceof Error ? e.message : String(e) }));
    }
  }, [api, profile, projectId, root, t]);

  const chartSeries = useMemo(() => {
    if (history.length === 0) return [];
    return [
      { label: t('inspections.trendTotal'), color: '#58a6ff', points: history.map((h) => h.total) },
      { label: t('inspections.trendNew'), color: '#f85149', points: history.map((h) => h.newCount) },
    ];
  }, [history, t]);

  const grouped = useMemo(() => {
    if (!run) return [];
    const map = new Map<string, InspectionFinding[]>();
    for (const f of run.newFindings) {
      const list = map.get(f.checker) ?? [];
      list.push(f);
      map.set(f.checker, list);
    }
    return [...map.entries()];
  }, [run]);

  const card = (label: string, value: string, sub?: string) => (
    <div className="card" style={{ padding: '10px 12px', minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ padding: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{t('inspections.title')}</h3>
        <span className="muted" style={{ fontSize: 12 }}>{t('inspections.subtitle')}</span>
        <span style={{ flex: 1 }} />
        <button className="primary" onClick={doRun} disabled={running}>
          {running ? t('inspections.running') : t('inspections.run')}
        </button>
        <button onClick={doRebaseline} title={t('inspections.rebaselineHint')}>
          {t('inspections.rebaseline')}
        </button>
        <button onClick={refresh}>{t('inspections.refresh')}</button>
      </div>
      {msg && <div className="banner">{msg}</div>}
      {err && <div className="banner err">{err}</div>}
      {loading && <div className="muted">{t('inspections.loading')}</div>}

      <div className="card" style={{ padding: '10px 12px', marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{t('inspections.rootLabel')}</div>
        <input
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          placeholder={t('inspections.rootPlaceholder')}
          style={{ width: '100%', boxSizing: 'border-box' }}
          onBlur={refresh}
        />
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{t('inspections.rootHint')}</div>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          {t('inspections.baselineStatus', { status: baseline.exists ? t('inspections.baselineYes') : t('inspections.baselineNo') })}
        </div>
      </div>

      {profile && (
        <div className="card" style={{ padding: '10px 12px', marginBottom: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{t('inspections.profileTitle')}</div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <label>
              <span className="muted" style={{ fontSize: 11, marginRight: 6 }}>{t('inspections.profileName')}</span>
              <input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} style={{ width: 160 }} />
            </label>
            <label>
              <span className="muted" style={{ fontSize: 11, marginRight: 6 }}>{t('inspections.maxFileLines')}</span>
              <input
                type="number"
                value={profile.maxFileLines}
                onChange={(e) => setProfile({ ...profile, maxFileLines: Number(e.target.value) })}
                style={{ width: 90 }}
              />
            </label>
            <label>
              <span className="muted" style={{ fontSize: 11, marginRight: 6 }}>{t('inspections.maxFunctionLines')}</span>
              <input
                type="number"
                value={profile.maxFunctionLines}
                onChange={(e) => setProfile({ ...profile, maxFunctionLines: Number(e.target.value) })}
                style={{ width: 90 }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              <input
                type="checkbox"
                checked={profile.licenseAudit}
                onChange={(e) => setProfile({ ...profile, licenseAudit: e.target.checked })}
              />{' '}
              {t('inspections.licenseAudit')}
            </label>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
            {CHECKER_IDS.map((id) => (
              <label key={id} style={{ fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={profile.checkers[id] !== false}
                  onChange={(e) => setProfile({ ...profile, checkers: { ...profile.checkers, [id]: e.target.checked } })}
                />{' '}
                {id}
              </label>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{profileNote} ({profileSource})</div>
          <button className="primary" style={{ marginTop: 8 }} onClick={saveProfile}>
            {t('inspections.saveProfile')}
          </button>
        </div>
      )}

      {run && (
        <>
          <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>
            {t('inspections.lastRun', { ms: run.durationMs, files: run.filesScanned })}
            {run.baselineEstablished && ` · ${t('inspections.baselineEstablished')}`}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
            {card(t('inspections.total'), String(run.totals.total))}
            {card(t('inspections.new'), String(run.newCount), run.newCount > 0 ? t('inspections.hasNew') : t('inspections.clean'))}
            {card(t('inspections.warnings'), String(run.totals.warning))}
            {card(t('inspections.infos'), String(run.totals.info))}
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>{t('inspections.newFindings')}</div>
          {grouped.length === 0 ? (
            <div className="muted">{t('inspections.noNew')}</div>
          ) : (
            grouped.map(([checker, findings]) => (
              <details key={checker} className="card" style={{ padding: '8px 12px', marginBottom: 6 }}>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                  {checker} <span className="muted">({findings.length})</span>
                </summary>
                <ul style={{ fontSize: 12, margin: '6px 0 0', paddingLeft: 18 }}>
                  {findings.slice(0, 50).map((f) => (
                    <li key={f.id}>
                      <span className="muted">{f.file}{f.line ? `:${f.line}` : ''}</span> — {f.message}
                    </li>
                  ))}
                  {findings.length > 50 && <li className="muted">…{t('inspections.more', { n: findings.length - 50 })}</li>}
                </ul>
              </details>
            ))
          )}

          {run.licenses && (
            <>
              <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>{t('inspections.licenseTitle')}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
                {card(t('inspections.deps'), String(run.licenses.total), t('inspections.permissiveCount', { n: run.licenses.permissive }))}
                {card(t('inspections.copyleft'), String(run.licenses.copyleft.length))}
                {card(t('inspections.unknown'), String(run.licenses.unknown.length), t('inspections.unknownHint'))}
              </div>
              {(run.licenses.copyleft.length > 0 || run.licenses.unknown.length > 0) && (
                <div className="card" style={{ padding: '8px 12px', marginTop: 6, fontSize: 12 }}>
                  {run.licenses.copyleft.length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <strong>{t('inspections.copyleft')}:</strong>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {run.licenses.copyleft.map((c) => (
                          <li key={c.name}>{c.name} {c.version} — {c.license}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {run.licenses.unknown.length > 0 && (
                    <div>
                      <strong>{t('inspections.unknown')}:</strong>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {run.licenses.unknown.slice(0, 30).map((u) => (
                          <li key={u.name}>{u.name} {u.version} — <span className="muted">{u.reason}</span></li>
                        ))}
                        {run.licenses.unknown.length > 30 && <li className="muted">…{t('inspections.more', { n: run.licenses.unknown.length - 30 })}</li>}
                      </ul>
                    </div>
                  )}
                </div>
              )}
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{run.licenses.note}</div>
            </>
          )}
        </>
      )}

      <div className="muted" style={{ fontSize: 12, margin: '16px 0 6px' }}>{t('inspections.trend')}</div>
      <div className="card" style={{ padding: 8 }}>
        {chartSeries.length > 0 && chartSeries[0].points.length > 0 ? (
          <LineChart series={chartSeries} />
        ) : (
          <div className="muted">{t('inspections.noHistory')}</div>
        )}
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.6 }}>
        {t('inspections.honestyNote')}
      </div>
    </div>
  );
}

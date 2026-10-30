import { useCallback, useEffect, useMemo, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang } from '../i18n';
import { EmptyState } from './EmptyState';

export interface MetricsSummary {
  ts: string;
  process: { rssMB: number; heapUsedMB: number; uptimeSec: number };
  db: { path: string; bytes: number };
  tables: { checkpoints: number; requirements: number; runs: number; auditLogs: number };
  runs: {
    total: number;
    completed: number;
    failed: number;
    escalated: number;
    running: number;
    successRate: number | null;
    avgDurationSec: number | null;
  };
  health: { samples: number; p50Ms: number; p95Ms: number; maxMs: number; lastMs: number };
  sampler: { intervalMs: number; maxSamples: number; samples: number };
}

export interface MetricsHistory {
  intervalMs: number;
  maxSamples: number;
  samples: Array<{ ts: number; rssMB: number; dbMB: number }>;
}

export interface MetricsApi {
  summary(): Promise<MetricsSummary>;
  history(): Promise<MetricsHistory>;
}

export function createMetricsApi(base: string): MetricsApi {
  async function req<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, { headers: { ...authHeaders() } });
    const body = (await res.json()) as T;
    if (!res.ok) {
      const err = body as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return body;
  }
  return {
    summary: () => req<MetricsSummary>('/metrics/summary'),
    history: () => req<MetricsHistory>('/metrics/history'),
  };
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}

/** Minimal zero-dependency SVG line chart. */
function LineChart(props: { series: Array<{ label: string; color: string; points: number[] }>; height?: number }) {
  const { series, height = 140 } = props;
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
          <rect x={pad.l + si * 130} y={height - 14} width={10} height={10} fill={s.color} />
          <text x={pad.l + si * 130 + 14} y={height - 5} fontSize={11} fill="#c9d1d9">
            {s.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function MetricsPanel({ api }: { api: MetricsApi }) {
  const { t } = useLang();
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [history, setHistory] = useState<MetricsHistory | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([api.summary(), api.history()]);
      setSummary(s);
      setHistory(h);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('metrics.error'));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const chartSeries = useMemo(() => {
    if (!history) return [];
    return [
      { label: `RSS (MB)`, color: '#58a6ff', points: history.samples.map((s) => s.rssMB) },
      { label: `DB (MB)`, color: '#3fb950', points: history.samples.map((s) => s.dbMB) },
    ];
  }, [history]);

  const card = (label: string, value: string, sub?: string) => (
    <div className="card" style={{ padding: '10px 12px', minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ padding: 4 }}>
      {summary === null && !loading && <EmptyState panel="metrics" />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{t('metrics.title')}</h3>
        <span className="muted" style={{ fontSize: 12 }}>{t('metrics.subtitle')}</span>
        <span style={{ flex: 1 }} />
        <button className="primary" onClick={() => { setLoading(true); refresh(); }}>
          {t('metrics.refresh')}
        </button>
      </div>
      {err && <div className="banner err">{err}</div>}
      {loading && !summary && <div className="muted">{t('metrics.loading')}</div>}
      {summary && (
        <>
          <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>{t('metrics.process')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
            {card(t('metrics.rss'), `${summary.process.rssMB} MB`, `${t('metrics.heap')}: ${summary.process.heapUsedMB} MB`)}
            {card(t('metrics.uptime'), fmtUptime(summary.process.uptimeSec))}
            {card(t('metrics.dbSize'), fmtBytes(summary.db.bytes), summary.db.path)}
            {card(t('metrics.auditLogs'), String(summary.tables.auditLogs), t('metrics.chainLength'))}
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>{t('metrics.runStats')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
            {card(t('metrics.totalRuns'), String(summary.runs.total),
              `${t('metrics.completed')}: ${summary.runs.completed} · ${t('metrics.failed')}: ${summary.runs.failed}`)}
            {card(t('metrics.successRate'), summary.runs.successRate === null ? '—' : `${(summary.runs.successRate * 100).toFixed(1)}%`,
              summary.runs.running > 0 ? `${t('metrics.running')}: ${summary.runs.running}` : undefined)}
            {card(t('metrics.avgDuration'), summary.runs.avgDurationSec === null ? '—' : `${summary.runs.avgDurationSec}s`)}
            {card(t('metrics.healthP95'), `${summary.health.p95Ms} ms`,
              `${t('metrics.samples')}: ${summary.health.samples} · p50 ${summary.health.p50Ms} ms`)}
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>{t('metrics.tables')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
            {card(t('metrics.checkpoints'), String(summary.tables.checkpoints))}
            {card(t('metrics.requirements'), String(summary.tables.requirements))}
            {card(t('metrics.runsTable'), String(summary.tables.runs))}
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '16px 0 6px' }}>
            {t('metrics.history')} · {t('metrics.historyHint')}
          </div>
          <div className="card" style={{ padding: 8 }}>
            {chartSeries.length > 0 && chartSeries[0].points.length > 0 ? (
              <LineChart series={chartSeries} />
            ) : (
              <div className="muted">{t('metrics.noHistory')}</div>
            )}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.6 }}>
            {t('metrics.overheadNote')}
          </div>
        </>
      )}
    </div>
  );
}

export function defaultMetricsApi(): MetricsApi {
  return createMetricsApi(defaultApiBase());
}

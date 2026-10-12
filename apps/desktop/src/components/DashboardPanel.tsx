import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '../api';

/** Mirrors the Stat / DashboardStats shapes from @ai-factory/dashboard. */
export interface DashboardStat {
  key: string;
  label: string;
  value: number | string | null;
  unit?: string;
  source: string;
  note?: string;
}

export interface DashboardStats {
  generatedAt: string;
  status: {
    activeTasks: DashboardStat;
    blockedTasks: DashboardStat;
    runningAgents: DashboardStat;
    qaFailures: DashboardStat;
    latestDeployment: DashboardStat;
    productionStatus: DashboardStat;
    resourceUsage: DashboardStat;
  };
  metrics: {
    tasksCompleted: DashboardStat;
    firstPassSuccessRate: DashboardStat;
    avgTaskDuration: DashboardStat;
    avgRepairLoops: DashboardStat;
    failedDeployments: DashboardStat;
    rollbackCount: DashboardStat;
    humanInterventions: DashboardStat;
  };
}

export interface DashboardApi {
  stats(): Promise<DashboardStats>;
}

const DEFAULT_BASE = 'http://localhost:3100/api';

async function req<T>(base: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export function createDashboardApi(base: string = DEFAULT_BASE): DashboardApi {
  return { stats: () => req(base, '/stats') };
}

function fmt(s: DashboardStat): string {
  if (s.value === null) return s.note ?? '暂无数据';
  return s.unit ? `${s.value}${s.unit}` : String(s.value);
}

function StatBox(props: { stat: DashboardStat }) {
  const s = props.stat;
  return (
    <div className="pill" style={{ padding: '6px 10px', textAlign: 'center', minWidth: 90 }}>
      <div className="muted" style={{ fontSize: 10 }}>{s.label}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(s)}</div>
      <div className="muted" style={{ fontSize: 9 }} title={s.source}>
        {s.value === null ? '暂无数据' : '实时'}
      </div>
    </div>
  );
}

function MetricCard(props: { stat: DashboardStat }) {
  const s = props.stat;
  return (
    <div className="card" style={{ cursor: 'default', marginBottom: 0 }}>
      <div className="card-title">{s.label}</div>
      <div style={{ fontSize: 28, fontWeight: 700 }}>{fmt(s)}</div>
      {/* 环比: no history is kept server-side yet, so the delta line is
          omitted entirely rather than invented (spec §83). */}
      <div className="card-meta">
        <span title={s.source}>来源: {s.source}</span>
      </div>
    </div>
  );
}

const POLL_MS = 5000;

/**
 * Dashboard panel (§83): status strip (live factory state) + metric cards,
 * refreshed every 5 s. Stats with no backing data render 暂无数据.
 */
export function DashboardPanel(props: { api?: DashboardApi }) {
  const [api] = useState<DashboardApi>(() => props.api ?? createDashboardApi());
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStats(await api.stats());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (error && !stats) {
    return <div className="banner err">Dashboard unavailable: {error}</div>;
  }
  if (!stats) return <p className="muted">Loading dashboard…</p>;

  const statusStats = Object.values(stats.status);
  const metricStats = Object.values(stats.metrics);

  return (
    <div className="dashboard-panel">
      <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <b>状态</b>
        {statusStats.map((s) => (
          <StatBox key={s.key} stat={s} />
        ))}
        <span style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 11 }}>
          更新于 {new Date(stats.generatedAt).toLocaleString()} · 每 5 秒刷新
        </span>
      </div>
      {error && <div className="banner err">{error}（显示上次成功数据）</div>}
      <b>指标</b>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 8,
          marginTop: 8,
        }}
      >
        {metricStats.map((s) => (
          <MetricCard key={s.key} stat={s} />
        ))}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang, type TFunc } from '../i18n';

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

const DEFAULT_BASE = defaultApiBase();

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

function fmt(s: DashboardStat, st: StatText): string {
  if (s.value === null) return st.note;
  return st.unit ? `${s.value}${st.unit}` : String(s.value);
}

/**
 * 服务端 /stats 下发的 label/source/note/unit 是中文常量
 * （见 packages/dashboard/src/aggregate.ts 的 NO_DATA_NOTE 与各 *_SRC）。
 * 桌面按 stat key 查语言包，有 key 就用翻译，缺 key 回退服务端原文 ——
 * 服务端零改动，新增指标不翻译也不会崩（回退中文原文，诚实可见）。
 */
interface StatText {
  label: string;
  source: string;
  note: string;
  unit: string;
}

function statText(s: DashboardStat, t: TFunc, has: (k: string) => boolean): StatText {
  const pick = (field: 'label' | 'source' | 'unit'): string => {
    const key = `dashboard.stat.${s.key}.${field}`;
    if (has(key)) return t(key);
    return field === 'unit' ? s.unit ?? '' : s[field];
  };
  const noteKey = `dashboard.stat.${s.key}.note`;
  // 服务端唯一的 note 常量就是"暂无数据"（NO_DATA_NOTE）；英文模式映射为 noData。
  // 未来若出现新的 note 文案，回退原文不猜测。
  const note = has(noteKey)
    ? t(noteKey)
    : s.note === '暂无数据' || !s.note
      ? t('dashboard.noData')
      : s.note;
  return { label: pick('label'), source: pick('source'), unit: pick('unit'), note };
}

function StatBox(props: { stat: DashboardStat }) {
  const { t, has } = useLang();
  const s = props.stat;
  const st = statText(s, t, has);
  return (
    <div className="pill" style={{ padding: '6px 10px', textAlign: 'center', minWidth: 90 }}>
      <div className="muted" style={{ fontSize: 10 }}>{st.label}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(s, st)}</div>
      <div className="muted" style={{ fontSize: 9 }} title={st.source}>
        {s.value === null ? st.note : t('dashboard.live')}
      </div>
    </div>
  );
}

function MetricCard(props: { stat: DashboardStat }) {
  const { t, has } = useLang();
  const s = props.stat;
  const st = statText(s, t, has);
  return (
    <div className="card" style={{ cursor: 'default', marginBottom: 0 }}>
      <div className="card-title">{st.label}</div>
      <div style={{ fontSize: 28, fontWeight: 700 }}>{fmt(s, st)}</div>
      {/* 环比: no history is kept server-side yet, so the delta line is
          omitted entirely rather than invented (spec §83). */}
      <div className="card-meta">
        <span title={st.source}>{t('dashboard.source', { source: st.source })}</span>
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
  const { t } = useLang();
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
        <b>{t('dashboard.status')}</b>
        {statusStats.map((s) => (
          <StatBox key={s.key} stat={s} />
        ))}
        <span style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 11 }}>
          {t('dashboard.updatedAt', { time: new Date(stats.generatedAt).toLocaleString() })}
        </span>
      </div>
      {error && <div className="banner err">{error}{t('dashboard.showingStale')}</div>}
      <b>{t('dashboard.metrics')}</b>
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

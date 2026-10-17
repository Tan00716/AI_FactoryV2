import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AuditChainVerification,
  type FactoryStatus,
  type IncidentSummary,
  type QuotaBucketView,
  type WatchdogSelf,
} from '../api';
import { useLang, type TFunc } from '../i18n';

/**
 * Ops 面板（spec §29.1/§50.2 Dashboard 视图的运维块，API-first）：
 *  - 三轴 factory 状态（control/health/capacity + ACK 门控显示）
 *  - watchdog 自身健康（§30）
 *  - quota buckets 用量（§27）
 *  - incidents 列表（§33）
 *
 * 纯文字展示，样式跟随现有面板（card/pill/muted/banner）。
 * 断线时显示上次成功数据 + 错误横幅，不编造状态（§29.4 stale 语义）。
 */
const POLL_MS = 5000;

function fmtTime(iso: string | undefined, t: TFunc): string {
  if (!iso) return t('ops.unknownTime');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function Block(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-title">{props.title}</div>
      {props.children}
    </div>
  );
}

function bucketUsage(b: QuotaBucketView, t: TFunc): string {
  // 不编造百分比：used/limit 缺失时只显示 unknown（spec AT-034）。
  if (typeof b.used === 'number' && typeof b.limit === 'number' && b.limit > 0) {
    return `${b.used}/${b.limit} (${((b.used / b.limit) * 100).toFixed(1)}%)`;
  }
  return t('ops.bucketUnknown');
}

export function OpsPanel() {
  const { t } = useLang();
  const [status, setStatus] = useState<FactoryStatus | null>(null);
  const [watchdog, setWatchdog] = useState<WatchdogSelf | null>(null);
  const [buckets, setBuckets] = useState<QuotaBucketView[]>([]);
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 审计链完整性（§32 / Batch 53）：idle → loading → ok / broken / error。
  // broken 是追加序（ORDER BY ts, rowid）链的下标，非 API newest-first 序。
  const [chain, setChain] = useState<AuditChainVerification | null>(null);
  const [chainState, setChainState] = useState<'idle' | 'loading' | 'ok' | 'broken' | 'error'>('idle');
  const [chainError, setChainError] = useState<string | null>(null);

  /** 自身健康状态码 → 本地化标签；未知码值如实回退原文（服务端零改动）。 */
  const selfHealthLabel = (v: string | undefined) =>
    v === 'ok' ? t('ops.selfHealthOk')
    : v === 'degraded' ? t('ops.selfHealthDegraded')
    : (v ?? t('ops.unknownTime'));

  const verifyChain = useCallback(async () => {
    setChainState('loading');
    setChainError(null);
    try {
      const v = await api.auditVerify();
      setChain(v);
      setChainState(v.ok ? 'ok' : 'broken');
    } catch (e) {
      setChainError((e as Error).message);
      setChainState('error');
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, w, q, i] = await Promise.all([
        api.factoryStatus(),
        api.watchdogSelf(),
        api.quotaBuckets(),
        api.incidents(),
      ]);
      setStatus(s);
      setWatchdog(w);
      setBuckets(q.buckets ?? []);
      setIncidents(i.incidents ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (error && !status) {
    return <div className="banner err">{t('ops.unavailable', { error })}</div>;
  }
  if (!status) return <p className="muted">Loading ops…</p>;

  return (
    <div className="ops-panel">
      {error && <div className="banner err">{error}{t('ops.showingStale')}</div>}

      <Block title={t('ops.factoryAxes')}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { k: 'control', label: t('ops.axis.control'), v: status.control },
            { k: 'health', label: t('ops.axis.health'), v: status.health },
            { k: 'capacity', label: t('ops.axis.capacity'), v: status.capacity },
          ].map((x) => (
            <div key={x.k} className="pill" style={{ padding: '6px 10px', minWidth: 110, textAlign: 'center' }}>
              <div className="muted" style={{ fontSize: 10 }}>{x.label}</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{x.v}</div>
            </div>
          ))}
          <span className="pill" style={{ padding: '6px 10px', textAlign: 'center' }}>
            <div className="muted" style={{ fontSize: 10 }}>Control Epoch</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{status.control_epoch}</div>
          </span>
        </div>
        <div className="card-meta" style={{ marginTop: 8 }}>
          <div>{t('ops.ackDisplay', { display: status.display })}</div>
          <div className="muted">
            {t('ops.pendingAcks', {
              workers: status.pending_acks.length > 0 ? status.pending_acks.join(', ') : t('ops.none'),
              time: fmtTime(status.updated_at, t),
            })}
          </div>
        </div>
      </Block>

      <Block title={t('ops.watchdogHealth')}>
        <p style={{ margin: '4px 0' }}>
          {t('ops.selfHealth')}: <b>{selfHealthLabel(watchdog?.selfHealth)}</b>
          <span className="muted">{t('ops.healthLegend')}</span>
        </p>
      </Block>

      <Block title={t('ops.chainIntegrity')}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={verifyChain}
            disabled={chainState === 'loading'}
            title={t('ops.verifyTitle')}
          >
            {chainState === 'loading' ? t('ops.verifying') : t('ops.verifyChain')}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            {chainState === 'idle' && t('ops.chainIdle')}
            {chainState === 'loading' && t('ops.chainLoading')}
          </span>
        </div>
        {chainState === 'ok' && chain && (
          <p style={{ margin: '8px 0 0', color: 'green' }}>
            {t('ops.chainOk', { count: chain.verifiedCount })}
            {chain.legacyCount > 0 && (
              <span className="muted">{t('ops.chainLegacy', { count: chain.legacyCount })}</span>
            )}
          </p>
        )}
        {chainState === 'broken' && chain && (
          <div className="banner err" style={{ marginTop: 8 }}>
            {t('ops.chainBroken', { at: chain.brokenAt ?? 0, count: chain.verifiedCount })}
          </div>
        )}
        {chainState === 'error' && (
          <div className="banner err" style={{ marginTop: 8 }}>
            {t('ops.chainError', { error: chainError ?? '' })}
          </div>
        )}
      </Block>

      <Block title={t('ops.quotaTitle', { count: buckets.length })}>
        {buckets.length === 0 ? (
          <p className="muted">{t('ops.noBuckets')}</p>
        ) : (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr className="muted" style={{ textAlign: 'left' }}>
                <th>{t('ops.col.providerAccount')}</th>
                <th>Bucket</th>
                <th>{t('ops.col.usage')}</th>
                <th>Auth</th>
                <th>{t('ops.col.freshness')}</th>
                <th>{t('ops.col.resetAt')}</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={`${b.providerAccountId}|${b.workspaceId}|${b.limitBucket}`}>
                  <td>{b.providerAccountId}</td>
                  <td>{b.limitBucket}</td>
                  <td>{bucketUsage(b, t)}</td>
                  <td>{b.authState}</td>
                  <td>{b.freshness}</td>
                  <td>{b.resetAt ? fmtTime(b.resetAt, t) : 'unknown'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Block>

      <Block title={t('ops.incidentsTitle', { count: incidents.length })}>
        {incidents.length === 0 ? (
          <p className="muted">{t('ops.noIncidents')} {t('ops.noIncidentsHint')}</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {incidents.map((i) => (
              <li key={i.id} style={{ marginBottom: 6 }}>
                <b>[{i.severity}]</b> {i.title}{' '}
                <span className="muted">
                  {t('ops.incidentMeta', {
                    id: i.id,
                    status: i.status,
                    detected: fmtTime(i.detectedAt, t),
                    updated: fmtTime(i.updatedAt, t),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  );
}

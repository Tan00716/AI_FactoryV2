import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AuditChainVerification,
  type FactoryStatus,
  type IncidentSummary,
  type QuotaBucketView,
  type WatchdogSelf,
} from '../api';

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

function fmtTime(iso?: string): string {
  if (!iso) return '未知';
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

function bucketUsage(b: QuotaBucketView): string {
  // 不编造百分比：used/limit 缺失时只显示 unknown（spec AT-034）。
  if (typeof b.used === 'number' && typeof b.limit === 'number' && b.limit > 0) {
    return `${b.used}/${b.limit} (${((b.used / b.limit) * 100).toFixed(1)}%)`;
  }
  return 'unknown（provider 未上报用量）';
}

export function OpsPanel() {
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
    return <div className="banner err">Ops 数据不可用: {error}</div>;
  }
  if (!status) return <p className="muted">Loading ops…</p>;

  return (
    <div className="ops-panel">
      {error && <div className="banner err">{error}（显示上次成功数据）</div>}

      <Block title="Factory 三轴状态（§29.1 全局 Strip）">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { k: 'control', label: '控制', v: status.control },
            { k: 'health', label: '健康', v: status.health },
            { k: 'capacity', label: '容量', v: status.capacity },
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
          <div>ACK 门控显示: {status.display}</div>
          <div className="muted">
            待 ACK worker: {status.pending_acks.length > 0 ? status.pending_acks.join(', ') : '无'} · 更新于 {fmtTime(status.updated_at)}
          </div>
        </div>
      </Block>

      <Block title="Watchdog 健康（§30）">
        <p style={{ margin: '4px 0' }}>
          自身健康: <b>{watchdog?.selfHealth ?? '未知'}</b>
          <span className="muted">（ok = 心跳正常；degraded = 出现缺失 tick）</span>
        </p>
      </Block>

      <Block title="审计链完整性（§32）">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={verifyChain}
            disabled={chainState === 'loading'}
            title="拉取全链验证：服务端从 genesis 锚定验证整条审计链，不分页（F33）。角色要求 operator+。"
          >
            {chainState === 'loading' ? '验证中…' : '拉取全链验证'}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            {chainState === 'idle' && '尚未验证'}
            {chainState === 'loading' && '正在从 genesis 拉取全链…'}
          </span>
        </div>
        {chainState === 'ok' && chain && (
          <p style={{ margin: '8px 0 0', color: 'green' }}>
            ✅ 链完整：已验证 {chain.verifiedCount} 条
            {chain.legacyCount > 0 && (
              <span className="muted">（{chain.legacyCount} 条 legacy 记录跳过，不影响链完整性）</span>
            )}
          </p>
        )}
        {chainState === 'broken' && chain && (
          <div className="banner err" style={{ marginTop: 8 }}>
            ❌ 审计链断裂：首个失败位于追加序下标 {chain.brokenAt}（按 ORDER BY ts, rowid，非列表新在前序）
            —— 断裂前 {chain.verifiedCount} 条已验证，断裂后的记录不可信。detection-not-prevention：链阻止不了 DB 写者，它让篡改显形并定位。
          </div>
        )}
        {chainState === 'error' && (
          <div className="banner err" style={{ marginTop: 8 }}>
            验证请求失败: {chainError}（权限不足时会是 403：端点要求 operator+ 角色）
          </div>
        )}
      </Block>

      <Block title={`Quota Buckets 用量（§27） — ${buckets.length} 个`}>
        {buckets.length === 0 ? (
          <p className="muted">暂无 bucket 记录（provider 未上报）。</p>
        ) : (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr className="muted" style={{ textAlign: 'left' }}>
                <th>Provider 账号</th>
                <th>Bucket</th>
                <th>用量</th>
                <th>Auth</th>
                <th>新鲜度</th>
                <th>重置时间</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={`${b.providerAccountId}|${b.workspaceId}|${b.limitBucket}`}>
                  <td>{b.providerAccountId}</td>
                  <td>{b.limitBucket}</td>
                  <td>{bucketUsage(b)}</td>
                  <td>{b.authState}</td>
                  <td>{b.freshness}</td>
                  <td>{b.resetAt ? fmtTime(b.resetAt) : 'unknown'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Block>

      <Block title={`Incidents（§33） — ${incidents.length} 条`}>
        {incidents.length === 0 ? (
          <p className="muted">当前无 incident。</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {incidents.map((i) => (
              <li key={i.id} style={{ marginBottom: 6 }}>
                <b>[{i.severity}]</b> {i.title}{' '}
                <span className="muted">
                  {i.id} · {i.status} · 发现于 {fmtTime(i.detectedAt)} · 更新于 {fmtTime(i.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  );
}

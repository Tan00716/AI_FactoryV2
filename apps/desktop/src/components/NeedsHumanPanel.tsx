import { useCallback, useEffect, useState } from 'react';
import { api, type NeedsHumanRecord } from '../api';

/**
 * §81 needs-human 升级记录的只读面板（Batch 50 起）。
 * - GET /api/needs-human?status=open（viewer 角色）：列出 OPEN 记录 ——
 *   trigger 类型（reason / reasonZh）、narrative 全文、创建时间。
 * - narrative 存在服务端返回的 detailJson（JSON 字符串）的 `narrative`
 *   键中（Batch 44–45：诚实限定语已持久化）。解析失败或无该键时如实
 *   呈现"服务端未提供"，不做推断。
 * - 故意不提供 acknowledge/resolve 按钮：解决动作是 operator 写操作
 *   （POST /api/needs-human/:id/resolve），桌面不引入未经验证的写路径。
 *   需要解决记录的人请走服务端 API 或未来的 operator 流程。
 */

function fmtTime(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '—';
  const d = new Date(epochMs);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/** 从 detailJson（JSON 字符串）中提取 narrative；失败或无键时返回 null。 */
function extractNarrative(rec: NeedsHumanRecord): string | null {
  try {
    const detail = JSON.parse(rec.detailJson) as Record<string, unknown>;
    const n = detail['narrative'];
    return typeof n === 'string' && n.length > 0 ? n : null;
  } catch {
    return null;
  }
}

function severityLabel(s: NeedsHumanRecord['severity']): string {
  switch (s) {
    case 'critical': return '严重';
    case 'high': return '高';
    case 'medium': return '中';
    default: return s;
  }
}

export function NeedsHumanPanel() {
  const [items, setItems] = useState<NeedsHumanRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setErr('');
    try {
      const res = await api.needsHuman('open');
      setItems(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (e) {
      setErr(`needs-human 列表不可用：${(e as Error).message}`);
    } finally {
      setLoaded(true);
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Needs Human</h2>
        <span className="muted">§81 人工升级记录（只读）</span>
        <button disabled={busy} onClick={() => void load()}>
          {busy ? '刷新中…' : '刷新'}
        </button>
      </div>
      <p className="muted">
        列出状态为 OPEN 的升级请求 —— 等待人工处理的行。
        本面板只读：acknowledge / resolve 请走服务端 API
        （<code>POST /api/needs-human/:id/resolve</code>），桌面不提供写操作。
      </p>
      {!loaded ? (
        <p className="muted">加载中…</p>
      ) : err ? (
        <div className="banner err">{err}</div>
      ) : items.length === 0 ? (
        <div className="card">
          <div className="card-title">当前没有 OPEN 的升级记录</div>
          <p className="muted">
            这只表示没有等待人工处理的行 —— 记录只会在服务端真实路径触发时
            产生（§81 的 8 个触发器：ai-disagreement、budget-exceeded、
            repeated-failure、high-risk-deployment、policy-violation、
            security-issue、requirement-ambiguity、irrecoverable-env-error）。
            空列表不是"机制关闭"的证据，也不是"功能缺失"。
          </p>
        </div>
      ) : (
        <>
          <p className="muted">共 {total} 条 OPEN 记录（按触发时间倒序）：</p>
          {items.map((rec) => {
            const narrative = extractNarrative(rec);
            return (
              <div className="card" key={rec.id}>
                <div className="card-top">
                  <span className="card-title">{rec.reason}</span>
                  <span className="card-meta">
                    {rec.reasonZh} · 严重度 {severityLabel(rec.severity)}
                  </span>
                </div>
                <div className="card-meta">
                  触发于 {fmtTime(rec.raisedAt)} · 来源 {rec.source} ·
                  解决需 {rec.requiredDeciderLevel} 级别
                  {rec.recipient ? ` · 接收者 ${rec.recipient}` : ''}
                </div>
                <p>
                  {narrative ?? (
                    <span className="muted">
                      （服务端未提供 narrative —— 该记录的 detailJson 中无
                      narrative 字段，不做推断）
                    </span>
                  )}
                </p>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

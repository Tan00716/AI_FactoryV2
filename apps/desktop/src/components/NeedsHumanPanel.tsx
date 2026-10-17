import { useCallback, useEffect, useState } from 'react';
import { api, type NeedsHumanRecord } from '../api';
import { useLang, type TFunc } from '../i18n';

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

function severityLabel(s: NeedsHumanRecord['severity'], t: TFunc): string {
  switch (s) {
    case 'critical': return t('needshuman.sevCritical');
    case 'high': return t('needshuman.sevHigh');
    case 'medium': return t('needshuman.sevMedium');
    default: return s;
  }
}

export function NeedsHumanPanel() {
  const { t } = useLang();
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
      setErr(t('needshuman.loadFailed', { message: (e as Error).message }));
    } finally {
      setLoaded(true);
      setBusy(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{t('needshuman.title')}</h2>
        <span className="muted">{t('needshuman.subtitle')}</span>
        <button disabled={busy} onClick={() => void load()}>
          {busy ? t('needshuman.refreshing') : t('needshuman.refresh')}
        </button>
      </div>
      <p className="muted">{t('needshuman.desc')}</p>
      {!loaded ? (
        <p className="muted">{t('needshuman.loading')}</p>
      ) : err ? (
        <div className="banner err">{err}</div>
      ) : items.length === 0 ? (
        <div className="card">
          <div className="card-title">{t('needshuman.emptyTitle')}</div>
          <p className="muted">{t('needshuman.emptyBody')}</p>
        </div>
      ) : (
        <>
          <p className="muted">{t('needshuman.listHead', { total })}</p>
          {items.map((rec) => {
            const narrative = extractNarrative(rec);
            return (
              <div className="card" key={rec.id}>
                <div className="card-top">
                  <span className="card-title">{rec.reason}</span>
                  <span className="card-meta">
                    {rec.reasonZh} · {t('needshuman.severity', { sev: severityLabel(rec.severity, t) })}
                  </span>
                </div>
                <div className="card-meta">
                  {t('needshuman.meta', {
                    time: fmtTime(rec.raisedAt),
                    source: rec.source,
                    level: rec.requiredDeciderLevel,
                  })}
                  {rec.recipient ? t('needshuman.recipient', { name: rec.recipient }) : ''}
                </div>
                <p>
                  {narrative ?? (
                    <span className="muted">{t('needshuman.noNarrative')}</span>
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

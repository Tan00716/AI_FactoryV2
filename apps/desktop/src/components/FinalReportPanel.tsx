import { useCallback, useEffect, useState } from 'react';
import { api, type FinalReport } from '../api';

/**
 * Final Report 面板（§39）：按项目调用 GET /api/projects/:id/final-report，
 * 展示服务端从 DB 真实记录汇编的报告各段（任务/证据/审批/进度与 AOCR/
 * 未决项/审计摘要）与 contentHash。无数据段严格按服务端返回呈现
 * （available:false 时显示其 note 原文），前端不补数、不推断。
 * Markdown 导出走同一端点的 ?format=md 渲染（与 JSON 同一汇编对象），
 * 下载方式沿用 ProjectPanel 的 Blob 惯例。
 */

const MAX_ROWS = 100;

function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function countsLine(rec: Record<string, number>): string {
  const entries = Object.entries(rec);
  return entries.length === 0 ? '—' : entries.map(([k, v]) => `${k} ${v}`).join('，');
}

export function FinalReportPanel({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [report, setReport] = useState<FinalReport | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [mdBusy, setMdBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const { report: r } = await api.finalReport(projectId);
      setReport(r);
    } catch (e) {
      setReport(null);
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const onDownloadMd = async () => {
    setMdBusy(true);
    setErr('');
    try {
      const md = await api.finalReportMarkdown(projectId);
      downloadText(`final-report-${projectName || projectId}.md`, md);
    } catch (e) {
      setErr(`Markdown 导出失败：${(e as Error).message}`);
    } finally {
      setMdBusy(false);
    }
  };

  const x = report?.extensions;

  return (
    <div className="panel">
      <h2>
        Final Report{' '}
        <span className="muted">§39 · 项目 {projectName}（{projectId}）</span>
      </h2>
      <div className="row">
        <button onClick={() => void load()} disabled={loading}>
          {loading ? '生成中…' : '刷新报告'}
        </button>
        <button onClick={() => void onDownloadMd()} disabled={mdBusy || !report}>
          {mdBusy ? '导出中…' : '⬇ 下载 Markdown'}
        </button>
        <span className="muted">报告由服务端在请求时从数据库实时汇编，每次生成都会写入审计。</span>
      </div>
      {err && <div className="banner err">{err}</div>}
      {!report && !err && <p className="muted">Loading final report…</p>}

      {report && x && (
        <div>
          <section>
            <h3>{report.title}</h3>
            <p>{report.summary}</p>
            <p className="muted" style={{ fontSize: 12 }}>
              生成时间：{fmtTime(report.meta.generatedAt)} · 数据截止：{fmtTime(report.meta.dataThrough)} ·
              内容哈希（{report.meta.hashAlgorithm}）：
              <code title={report.meta.contentHash}> {report.meta.contentHash}</code>
            </p>
          </section>

          <section>
            <h3>指标</h3>
            <table className="data-table">
              <tbody>
                {Object.entries(report.metrics).map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{v === null ? '无数据' : String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3>任务（{x.tasks.total}）</h3>
            {!x.tasks.available ? (
              <p className="muted">{x.tasks.note ?? '无数据：该项目暂无任务记录'}</p>
            ) : (
              <div>
                <p className="muted">
                  终态 {x.tasks.terminal} · 未终结 {x.tasks.open} · 按状态：{countsLine(x.tasks.byStatus)}
                </p>
                <table className="data-table">
                  <thead>
                    <tr><th>任务</th><th>标题</th><th>状态</th><th>优先级</th><th>风险</th><th>完成时间</th></tr>
                  </thead>
                  <tbody>
                    {x.tasks.items.slice(0, MAX_ROWS).map((t) => (
                      <tr key={t.id}>
                        <td><code>{t.id}</code></td>
                        <td>{t.title}</td>
                        <td>{t.status}</td>
                        <td>{t.priority}</td>
                        <td>{t.risk}</td>
                        <td>{fmtTime(t.completedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {x.tasks.items.length > MAX_ROWS && (
                  <p className="muted">…仅显示前 {MAX_ROWS} 条，共 {x.tasks.items.length} 条</p>
                )}
              </div>
            )}
          </section>

          <section>
            <h3>证据（{x.evidence.total}）</h3>
            {!x.evidence.available ? (
              <p className="muted">{x.evidence.note ?? '无数据：该项目暂无证据记录'}</p>
            ) : (
              <div>
                <p className="muted">
                  已封存 {x.evidence.sealed} · 带 requirement pin {x.evidence.withRequirementPin} ·
                  未记录 pin {x.evidence.withoutRequirementPin} · 按类型：{countsLine(x.evidence.byType)}
                </p>
                <table className="data-table">
                  <thead>
                    <tr><th>证据</th><th>任务</th><th>类型</th><th>标题</th><th>状态</th><th>Requirement Pin</th><th>封存时间</th></tr>
                  </thead>
                  <tbody>
                    {x.evidence.items.slice(0, MAX_ROWS).map((ev) => (
                      <tr key={ev.id}>
                        <td><code>{ev.id}</code></td>
                        <td><code>{ev.taskId}</code></td>
                        <td>{ev.type}</td>
                        <td>{ev.title}</td>
                        <td>{ev.status}</td>
                        <td>{ev.requirementVersion ?? '—'}</td>
                        <td>{fmtTime(ev.sealedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {x.evidence.items.length > MAX_ROWS && (
                  <p className="muted">…仅显示前 {MAX_ROWS} 条，共 {x.evidence.items.length} 条</p>
                )}
              </div>
            )}
          </section>

          <section>
            <h3>审批（{x.approvals.total}）</h3>
            {!x.approvals.available ? (
              <p className="muted">{x.approvals.note ?? '无数据：该项目暂无审批记录'}</p>
            ) : (
              <div>
                <p>
                  <span className="pill ok">APPROVED {x.approvals.decisions.approved}</span>{' '}
                  <span className="pill">REJECTED {x.approvals.decisions.rejected}</span>{' '}
                  <span className="pill warn">PENDING {x.approvals.decisions.pending}</span>{' '}
                  <span className="pill">WAIVED {x.approvals.waived.count}（§23.4 豁免，单列，不计入通过）</span>
                </p>
                <table className="data-table">
                  <thead>
                    <tr><th>审批</th><th>任务</th><th>动作</th><th>状态</th><th>决定</th><th>决定人</th><th>决定时间</th></tr>
                  </thead>
                  <tbody>
                    {x.approvals.items.slice(0, MAX_ROWS).map((a) => (
                      <tr key={a.approvalId}>
                        <td><code>{a.approvalId}</code></td>
                        <td><code>{a.taskId}</code></td>
                        <td>{a.action}</td>
                        <td>{a.status}</td>
                        <td>{a.decision || 'PENDING'}</td>
                        <td>{a.decidedBy || '—'}</td>
                        <td>{fmtTime(a.decidedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {x.approvals.waived.count > 0 && (
                  <div>
                    <h4>豁免（WAIVED，§23.4 例外授权）</h4>
                    <table className="data-table">
                      <thead>
                        <tr><th>授权</th><th>任务</th><th>动作</th><th>授权人</th><th>原失败原因</th><th>时间</th></tr>
                      </thead>
                      <tbody>
                        {x.approvals.waived.items.map((w) => (
                          <tr key={w.grantId}>
                            <td><code>{w.grantId}</code></td>
                            <td><code>{w.taskId}</code></td>
                            <td>{w.action}</td>
                            <td>{w.grantedBy}</td>
                            <td>{w.failureReason}</td>
                            <td>{fmtTime(w.ts)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>

          <section>
            <h3>进度与 AOCR</h3>
            <ul className="plain">
              <li>
                任务完成率：
                {x.progress.taskCompletionPercent === null
                  ? '无数据'
                  : `${x.progress.taskCompletionPercent}%`}
              </li>
              <li>
                AOCR（授权结果完成率）：
                {x.progress.aocr.ratePercent === null
                  ? '无数据'
                  : `${x.progress.aocr.ratePercent}%`}
                （获准 {x.progress.aocr.authorizedTotal}，其中完成 {x.progress.aocr.authorizedCompleted}）
              </li>
              {x.progress.aocr.note && <li className="muted">AOCR 说明：{x.progress.aocr.note}</li>}
              <li className="muted">权重计划进度：{x.progress.planBased.note}</li>
            </ul>
          </section>

          <section>
            <h3>未决事项（{x.openItems.total}）</h3>
            {report.followUps.length === 0 ? (
              <p className="muted">无未决事项。</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {report.followUps.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            )}
          </section>

          <section>
            <h3>审计摘要（{x.auditSummary.totalEvents}）</h3>
            {!x.auditSummary.available ? (
              <p className="muted">{x.auditSummary.note ?? '无数据：无与该项目相关的审计记录'}</p>
            ) : (
              <div>
                <p className="muted">按动作：{countsLine(x.auditSummary.byAction)}</p>
                {x.auditSummary.recent.length > 0 && (
                  <table className="data-table">
                    <thead>
                      <tr><th>时间</th><th>参与者</th><th>动作</th><th>实体</th></tr>
                    </thead>
                    <tbody>
                      {x.auditSummary.recent.map((r, i) => (
                        <tr key={i}>
                          <td>{fmtTime(r.ts)}</td>
                          <td>{r.actor}</td>
                          <td>{r.action}</td>
                          <td><code>{r.entityType}:{r.entityId}</code></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

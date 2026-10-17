import { useCallback, useEffect, useState } from 'react';
import { api, type FinalReport } from '../api';
import { useLang } from '../i18n';

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

function countsLine(rec: Record<string, number>, sep: string): string {
  const entries = Object.entries(rec);
  return entries.length === 0 ? '—' : entries.map(([k, v]) => `${k} ${v}`).join(sep);
}

export function FinalReportPanel({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const { t } = useLang();
  const [report, setReport] = useState<FinalReport | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [mdBusy, setMdBusy] = useState(false);
  const sep = t('finalreport.sep');

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
      setErr(t('finalreport.mdExportFailed', { message: (e as Error).message }));
    } finally {
      setMdBusy(false);
    }
  };

  const x = report?.extensions;

  return (
    <div className="panel">
      <h2>
        Final Report{' '}
        <span className="muted">{t('finalreport.subtitle', { name: projectName, id: projectId })}</span>
      </h2>
      <div className="row">
        <button onClick={() => void load()} disabled={loading}>
          {loading ? t('finalreport.generating') : t('finalreport.refresh')}
        </button>
        <button onClick={() => void onDownloadMd()} disabled={mdBusy || !report}>
          {mdBusy ? t('finalreport.exporting') : t('finalreport.downloadMd')}
        </button>
        <span className="muted">{t('finalreport.reportNote')}</span>
      </div>
      {err && <div className="banner err">{err}</div>}
      {!report && !err && <p className="muted">{t('finalreport.loading')}</p>}

      {report && x && (
        <div>
          <section>
            <h3>{report.title}</h3>
            <p>{report.summary}</p>
            <p className="muted" style={{ fontSize: 12 }}>
              {t('finalreport.metaLine', { generatedAt: fmtTime(report.meta.generatedAt), dataThrough: fmtTime(report.meta.dataThrough), algo: report.meta.hashAlgorithm })}
              <code title={report.meta.contentHash}> {report.meta.contentHash}</code>
            </p>
          </section>

          <section>
            <h3>{t('finalreport.metrics')}</h3>
            <table className="data-table">
              <tbody>
                {Object.entries(report.metrics).map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{v === null ? t('finalreport.noData') : String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3>{t('finalreport.tasks', { total: x.tasks.total })}</h3>
            {!x.tasks.available ? (
              <p className="muted">{x.tasks.note ?? t('finalreport.tasksEmpty')}</p>
            ) : (
              <div>
                <p className="muted">
                  {t('finalreport.tasksLine', { terminal: x.tasks.terminal, open: x.tasks.open, line: countsLine(x.tasks.byStatus, sep) })}
                </p>
                <table className="data-table">
                  <thead>
                    <tr><th>{t('finalreport.th.task')}</th><th>{t('finalreport.th.title')}</th><th>{t('finalreport.th.status')}</th><th>{t('finalreport.th.priority')}</th><th>{t('finalreport.th.risk')}</th><th>{t('finalreport.th.completedAt')}</th></tr>
                  </thead>
                  <tbody>
                    {x.tasks.items.slice(0, MAX_ROWS).map((task) => (
                      <tr key={task.id}>
                        <td><code>{task.id}</code></td>
                        <td>{task.title}</td>
                        <td>{task.status}</td>
                        <td>{task.priority}</td>
                        <td>{task.risk}</td>
                        <td>{fmtTime(task.completedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {x.tasks.items.length > MAX_ROWS && (
                  <p className="muted">{t('finalreport.truncated', { max: MAX_ROWS, total: x.tasks.items.length })}</p>
                )}
              </div>
            )}
          </section>

          <section>
            <h3>{t('finalreport.evidence', { total: x.evidence.total })}</h3>
            {!x.evidence.available ? (
              <p className="muted">{x.evidence.note ?? t('finalreport.evidenceEmpty')}</p>
            ) : (
              <div>
                <p className="muted">
                  {t('finalreport.evidenceLine', { sealed: x.evidence.sealed, withPin: x.evidence.withRequirementPin, withoutPin: x.evidence.withoutRequirementPin, line: countsLine(x.evidence.byType, sep) })}
                </p>
                <table className="data-table">
                  <thead>
                    <tr><th>{t('finalreport.th.evidence')}</th><th>{t('finalreport.th.task')}</th><th>{t('finalreport.th.type')}</th><th>{t('finalreport.th.title')}</th><th>{t('finalreport.th.status')}</th><th>{t('finalreport.th.reqPin')}</th><th>{t('finalreport.th.sealedAt')}</th></tr>
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
                  <p className="muted">{t('finalreport.truncated', { max: MAX_ROWS, total: x.evidence.items.length })}</p>
                )}
              </div>
            )}
          </section>

          <section>
            <h3>{t('finalreport.approvals', { total: x.approvals.total })}</h3>
            {!x.approvals.available ? (
              <p className="muted">{x.approvals.note ?? t('finalreport.approvalsEmpty')}</p>
            ) : (
              <div>
                <p>
                  <span className="pill ok">APPROVED {x.approvals.decisions.approved}</span>{' '}
                  <span className="pill">REJECTED {x.approvals.decisions.rejected}</span>{' '}
                  <span className="pill warn">PENDING {x.approvals.decisions.pending}</span>{' '}
                  <span className="pill">WAIVED {x.approvals.waived.count}{t('finalreport.waivedNote')}</span>
                </p>
                <table className="data-table">
                  <thead>
                    <tr><th>{t('finalreport.th.approval')}</th><th>{t('finalreport.th.task')}</th><th>{t('finalreport.th.action')}</th><th>{t('finalreport.th.status')}</th><th>{t('finalreport.th.decision')}</th><th>{t('finalreport.th.decidedBy')}</th><th>{t('finalreport.th.decidedAt')}</th></tr>
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
                    <h4>{t('finalreport.waivedTitle')}</h4>
                    <table className="data-table">
                      <thead>
                        <tr><th>{t('finalreport.th.grant')}</th><th>{t('finalreport.th.task')}</th><th>{t('finalreport.th.action')}</th><th>{t('finalreport.th.grantedBy')}</th><th>{t('finalreport.th.failureReason')}</th><th>{t('finalreport.th.time')}</th></tr>
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
            <h3>{t('finalreport.progress')}</h3>
            <ul className="plain">
              <li>
                {t('finalreport.completionRate')}
                {x.progress.taskCompletionPercent === null
                  ? t('finalreport.noData')
                  : `${x.progress.taskCompletionPercent}%`}
              </li>
              <li>
                {t('finalreport.aocrLine')}
                {x.progress.aocr.ratePercent === null
                  ? t('finalreport.noData')
                  : `${x.progress.aocr.ratePercent}%`}
                {t('finalreport.aocrDetail', { total: x.progress.aocr.authorizedTotal, completed: x.progress.aocr.authorizedCompleted })}
              </li>
              {x.progress.aocr.note && <li className="muted">{t('finalreport.aocrNote', { note: x.progress.aocr.note })}</li>}
              <li className="muted">{t('finalreport.planNote', { note: x.progress.planBased.note })}</li>
            </ul>
          </section>

          <section>
            <h3>{t('finalreport.openItems', { total: x.openItems.total })}</h3>
            {report.followUps.length === 0 ? (
              <p className="muted">{t('finalreport.noOpenItems')}</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {report.followUps.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            )}
          </section>

          <section>
            <h3>{t('finalreport.auditSummary', { total: x.auditSummary.totalEvents })}</h3>
            {!x.auditSummary.available ? (
              <p className="muted">{x.auditSummary.note ?? t('finalreport.auditEmpty')}</p>
            ) : (
              <div>
                <p className="muted">{t('finalreport.auditByAction', { line: countsLine(x.auditSummary.byAction, sep) })}</p>
                {x.auditSummary.recent.length > 0 && (
                  <table className="data-table">
                    <thead>
                      <tr><th>{t('finalreport.th.time')}</th><th>{t('finalreport.th.actor')}</th><th>{t('finalreport.th.action')}</th><th>{t('finalreport.th.entity')}</th></tr>
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

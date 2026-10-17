import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type ResumeRunResponse,
  type RunManifest,
  type RuntimeRunListItem,
} from '../api';
import { RunCheckpointsSection, useRunCheckpoints } from './RunCheckpointsView';
import { useLang } from '../i18n';

/**
 * Observatory（Batch 16）— 全局运行观测面。
 *
 * 数据全部来自服务端真实记录：列表行由 GET /api/runtime/runs 在
 * 服务端 join 好（manifest 关键列 / checkpoint 实时计数 / 本进程
 * live 标记 / 项目解析），本面板不逐行补拉。展开行时才取该 run 的
 * 全量 manifest（GET /:id/manifest）与 checkpoints（共享组件）。
 *
 * 诚实口径：
 *  - 状态 RUNNING 且 live=false 的是中断遗留（执行它的进程已不在），
 *    标「可能已中断」——依据是服务端 live 字段，不凭创建时间臆测；
 *  - 无 manifest 的遗留 run 明确标「无 manifest」，不拿 run 记录
 *    反推补数；
 *  - 恢复（§28.4）是运维动作：按钮旁明示将创建一个新的恢复 run；
 *    服务端的逐项 checks 结果（通过/未通过及 detail 原文）如实
 *    呈现，拒绝就是拒绝，不粉饰为成功。
 */

type ManifestState =
  | { phase: 'loading' }
  | { phase: 'ready'; manifest: RunManifest }
  | { phase: 'error'; message: string };

type ResumeState =
  | { phase: 'pending' }
  | { phase: 'answered'; status: number; body: ResumeRunResponse }
  | { phase: 'unreachable'; message: string };

function fmtTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function recordEntries(rec: Record<string, number>): string {
  const keys = Object.keys(rec);
  return keys.length === 0 ? '—' : keys.map((k) => `${k}=${rec[k]}`).join(', ');
}

/** §28.4 逐项 checks 的原样呈现（成功响应里同样带 checks）。 */
function ChecksList({ body }: { body: ResumeRunResponse }) {
  const { t } = useLang();
  const checks = body.checks ?? {};
  const names = Object.keys(checks);
  if (names.length === 0) return null;
  return (
    <ul className="plain">
      {names.map((name) => {
        const c = checks[name];
        const pending = Array.isArray(c['pending'])
          ? (c['pending'] as Array<{ id: string; tool: string }>)
          : null;
        return (
          <li key={name}>
            <span className={c.ok ? 'ok' : 'err'}>{c.ok ? '✓' : '✗'}</span>{' '}
            <code>{name}</code> — {c.detail}
            {pending && pending.length > 0 && (
              <span className="muted">
                {' '}（{pending.map((p) => `${p.tool} ${p.id.slice(0, 8)}…`).join(t('observatory.pendingSep'))}）
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ResumeResultBlock({ state }: { state: ResumeState }) {
  const { t } = useLang();
  if (state.phase === 'pending') return <p className="muted">{t('observatory.resumePending')}</p>;
  if (state.phase === 'unreachable') {
    return <div className="banner err">{t('observatory.resumeUnreachable', { message: state.message })}</div>;
  }
  const { status, body } = state;
  if (status === 202 && body.id) {
    return (
      <div>
        <p className="ok">
          {t('observatory.resumeCreated')}<code title={body.id}>{body.id}</code>
          {body.resumedFrom && (
            <span className="muted">
              {' '}{t('observatory.resumeCreatedNote', {
                step: body.resumedFrom.stepPosition,
                time: new Date(body.resumedFrom.capturedAt).toLocaleString(),
              })}
            </span>
          )}
        </p>
        {body.note && <p className="muted">{t('observatory.serverNote', { note: body.note })}</p>}
        {body.budgetBaseline && (
          <p className="muted">{t('observatory.budgetBaseline', { entries: recordEntries(body.budgetBaseline) })}</p>
        )}
        <ChecksList body={body} />
      </div>
    );
  }
  return (
    <div>
      <div className="banner err">
        {t('observatory.resumeRejected', { status, error: body.error ?? t('observatory.noErrorDetail') })}
        {body.reason && <span>（reason: {body.reason}）</span>}
      </div>
      <ChecksList body={body} />
    </div>
  );
}

function ManifestDetail({ manifest }: { manifest: RunManifest }) {
  const { t } = useLang();
  const m = manifest;
  return (
    <table className="data-table">
      <tbody>
        <tr>
          <th>{t('observatory.row.driver')}</th>
          <td>
            {m.driver.kind} · adapter <code>{m.driver.adapter}</code> ·{' '}
            routeRequest {m.driver.routeRequestProvided ? t('observatory.has') : t('observatory.hasNot')}
          </td>
          <th>{t('observatory.row.model')}</th>
          <td>
            {m.model ?? '—'}
            {m.modelSource && <span className="muted">{t('observatory.modelSource', { source: m.modelSource })}</span>}
          </td>
        </tr>
        <tr>
          <th>{t('observatory.row.final')}</th>
          <td>
            <span className="pill">{m.status}</span> outcome: {m.outcome ?? '—'} ·
            steps: {m.steps ?? '—'} · {t('observatory.finishedAt', { time: fmtTime(m.finishedAt) })}
            {m.error && <span className="err"> · error: {m.error}</span>}
          </td>
          <th>{t('observatory.row.tools')}</th>
          <td>{m.grantedTools.length ? m.grantedTools.join(', ') : t('observatory.noTools')}</td>
        </tr>
        <tr>
          <th>{t('observatory.row.budgetLimits')}</th>
          <td>
            loop: maxSteps={m.budgetLimits.loop.maxSteps}, timeMs={m.budgetLimits.loop.timeMs},
            maxRetries={m.budgetLimits.loop.maxRetries}
            <br />
            extended: {recordEntries(m.budgetLimits.extended)}
          </td>
          <th>{t('observatory.row.budgetUsage')}</th>
          <td>
            {m.budgetUsage
              ? recordEntries(m.budgetUsage)
              : t('observatory.usageIncomplete')}
          </td>
        </tr>
        <tr>
          <th>{t('observatory.row.intents')}</th>
          <td>
            {m.intents
              ? <>{t('observatory.intentsSummary', { total: m.intents.total, entries: recordEntries(m.intents.byStatus) })}</>
              : t('observatory.incomplete')}
          </td>
          <th>{t('observatory.row.evidence')}</th>
          <td>
            {m.evidence
              ? <>{t('observatory.evidenceSummary', { count: m.evidence.count, entries: recordEntries(m.evidence.byType) })}</>
              : t('observatory.incomplete')}
          </td>
        </tr>
        <tr>
          <th>{t('observatory.row.checkpoints')}</th>
          <td>
            {m.checkpoints
              ? m.checkpoints.count === 0
                ? t('observatory.zeroCheckpoints')
                : t('observatory.checkpointsRange', {
                    count: m.checkpoints.count,
                    first: m.checkpoints.firstStep ?? '—',
                    last: m.checkpoints.lastStep ?? '—',
                  })
              : t('observatory.incomplete')}
          </td>
          <th>{t('observatory.row.contextHash')}</th>
          <td><code title={m.contextManifestHash}>{m.contextManifestHash.slice(0, 16)}…</code></td>
        </tr>
      </tbody>
    </table>
  );
}

export function ObservatoryPanel() {
  const { t } = useLang();
  const [rows, setRows] = useState<RuntimeRunListItem[] | null>(null);
  const [err, setErr] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [manifests, setManifests] = useState<Record<string, ManifestState>>({});
  const [resumes, setResumes] = useState<Record<string, ResumeState>>({});

  const ckpts = useRunCheckpoints(expandedId);

  const load = useCallback(async () => {
    setErr('');
    try {
      const res = await api.runs();
      setRows(res.runs ?? []);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const expand = useCallback(
    (row: RuntimeRunListItem) => {
      if (expandedId === row.id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(row.id);
      // 全量 manifest 只对有 manifest 的 run 取；遗留 run 的缺失列表行
      // 已如实标明，不发一个注定 404 的请求再把 404 当新闻。
      if (row.manifest !== null && !manifests[row.id]) {
        setManifests((s) => ({ ...s, [row.id]: { phase: 'loading' } }));
        api
          .runManifest(row.id)
          .then((manifest) =>
            setManifests((s) => ({ ...s, [row.id]: { phase: 'ready', manifest } })),
          )
          .catch((e: Error) =>
            setManifests((s) => ({
              ...s,
              [row.id]: { phase: 'error', message: e.message },
            })),
          );
      }
    },
    [expandedId, manifests],
  );

  const doResume = useCallback(
    async (row: RuntimeRunListItem) => {
      setExpandedId(row.id);
      setResumes((s) => ({ ...s, [row.id]: { phase: 'pending' } }));
      try {
        const { status, body } = await api.resumeRun(row.id);
        setResumes((s) => ({ ...s, [row.id]: { phase: 'answered', status, body } }));
        if (status === 202) void load();
      } catch (e) {
        setResumes((s) => ({
          ...s,
          [row.id]: { phase: 'unreachable', message: (e as Error).message },
        }));
      }
    },
    [load],
  );

  const byStatus = new Map<string, number>();
  for (const r of rows ?? []) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  const leftovers = (rows ?? []).filter((r) => r.status === 'RUNNING' && !r.live).length;

  return (
    <div className="panel">
      <h2>
        Observatory <span className="muted">{t('observatory.subtitle')}</span>
      </h2>
      {err && <div className="banner err">{t('observatory.loadFailed', { message: err })}</div>}
      <div className="row">
        <button onClick={() => void load()}>{t('observatory.refresh')}</button>
        {rows !== null && (
          <span className="muted">
            {t('observatory.summary', { count: rows.length })}
            {[...byStatus.entries()].map(([s, n]) => ` · ${s} ${n}`).join('')}
            {leftovers > 0 && t('observatory.leftovers', { n: leftovers })}
          </span>
        )}
      </div>

      {rows === null && !err && <p className="muted">{t('observatory.loadingRuns')}</p>}
      {rows !== null && rows.length === 0 && (
        <p className="muted">
          {t('observatory.empty')}
        </p>
      )}

      {rows !== null && rows.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('observatory.col.run')}</th><th>{t('observatory.col.status')}</th>
              <th>{t('observatory.col.agent')}</th><th>{t('observatory.col.task')}</th>
              <th>{t('observatory.col.project')}</th><th>{t('observatory.col.createdAt')}</th>
              <th>{t('observatory.col.model')}</th><th>{t('observatory.col.intents')}</th>
              <th>{t('observatory.col.checkpoints')}</th><th>{t('observatory.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const expanded = expandedId === row.id;
              const resumable = row.checkpointCount > 0 && !row.live;
              const resume = resumes[row.id];
              return [
                <tr key={row.id}>
                  <td><code title={row.id}>{row.id.slice(0, 8)}…</code></td>
                  <td>
                    <span className="pill">{row.status}</span>{' '}
                    {row.status === 'RUNNING' &&
                      (row.live ? (
                        <span className="pill ok">{t('observatory.live')}</span>
                      ) : (
                        <span className="pill warn">{t('observatory.maybeInterrupted')}</span>
                      ))}
                  </td>
                  <td><code title={row.agentId}>{row.agentId.slice(0, 8)}…</code></td>
                  <td><code title={row.taskId}>{row.taskId.slice(0, 8)}…</code></td>
                  <td>
                    {row.projectName ?? row.projectId ?? (
                      <span className="muted">{t('observatory.unresolvable')}</span>
                    )}
                  </td>
                  <td>{fmtTime(row.createdAt)}</td>
                  <td>
                    {row.manifest ? (
                      <>
                        {row.manifest.model ?? '—'}
                        {row.manifest.modelSource && (
                          <span className="muted">{t('observatory.modelSource', { source: row.manifest.modelSource })}</span>
                        )}
                      </>
                    ) : (
                      <span className="pill warn">{t('observatory.noManifest')}</span>
                    )}
                  </td>
                  <td>
                    {row.manifest && row.manifest.intentsTotal !== null ? (
                      <>
                        {row.manifest.intentsTotal}
                        <span className="muted">
                          （DENIED {row.manifest.intentsByStatus?.DENIED ?? 0}）
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{row.checkpointCount}</td>
                  <td>
                    <button onClick={() => expand(row)}>{expanded ? t('observatory.collapse') : t('observatory.expand')}</button>
                    {resumable && (
                      <>
                        {' '}
                        <button
                          onClick={() => void doResume(row)}
                          disabled={resume?.phase === 'pending'}
                        >
                          {resume?.phase === 'pending' ? t('observatory.resuming') : t('observatory.resumeBtn')}
                        </button>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {t('observatory.resumeHint')}
                        </div>
                      </>
                    )}
                  </td>
                </tr>,
                expanded && (
                  <tr key={`${row.id}-detail`}>
                    <td colSpan={10}>
                      <p className="muted" style={{ fontSize: 12 }}>
                        run <code>{row.id}</code>{' '}
                        {t('observatory.runMeta', {
                          outcome: row.outcome ?? '—',
                          steps: row.steps,
                          finishedAt: fmtTime(row.finishedAt),
                          evidence: row.evidence.length,
                          handoffs: row.handoffs.length,
                        })}
                        {row.error && <span className="err"> · error: {row.error}</span>}
                      </p>

                      <h4>{t('observatory.manifestTitle')}</h4>
                      {row.manifest === null ? (
                        <p className="muted">
                          {t('observatory.noManifestNote')}
                        </p>
                      ) : manifests[row.id]?.phase === 'ready' ? (
                        <ManifestDetail
                          manifest={(manifests[row.id] as { phase: 'ready'; manifest: RunManifest }).manifest}
                        />
                      ) : manifests[row.id]?.phase === 'error' ? (
                        <div className="banner err">
                          {t('observatory.manifestFailed', {
                            message: (manifests[row.id] as { phase: 'error'; message: string }).message,
                          })}
                        </div>
                      ) : (
                        <p className="muted">{t('observatory.loadingManifest')}</p>
                      )}

                      <RunCheckpointsSection
                        checkpoints={ckpts.checkpoints}
                        latest={ckpts.latest}
                        error={ckpts.error}
                        onRefresh={() => void ckpts.reload()}
                      />

                      {resume && (
                        <div>
                          <h4>{t('observatory.resumeTitle')}</h4>
                          <ResumeResultBlock state={resume} />
                        </div>
                      )}
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

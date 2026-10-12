import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type ResumeRunResponse,
  type RunManifest,
  type RuntimeRunListItem,
} from '../api';
import { RunCheckpointsSection, useRunCheckpoints } from './RunCheckpointsView';

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
                {' '}（{pending.map((p) => `${p.tool} ${p.id.slice(0, 8)}…`).join('、')}）
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ResumeResultBlock({ state }: { state: ResumeState }) {
  if (state.phase === 'pending') return <p className="muted">恢复请求已发出，等待服务端重校验…</p>;
  if (state.phase === 'unreachable') {
    return <div className="banner err">恢复请求未达服务端：{state.message}</div>;
  }
  const { status, body } = state;
  if (status === 202 && body.id) {
    return (
      <div>
        <p className="ok">
          已创建新的恢复 run：<code title={body.id}>{body.id}</code>
          {body.resumedFrom && (
            <span className="muted">
              {' '}（自原 run 步位 {body.resumedFrom.stepPosition} 的检查点恢复，
              捕获于 {new Date(body.resumedFrom.capturedAt).toLocaleString()}）
            </span>
          )}
        </p>
        {body.note && <p className="muted">服务端说明：{body.note}</p>}
        {body.budgetBaseline && (
          <p className="muted">承接的预算基线：{recordEntries(body.budgetBaseline)}</p>
        )}
        <ChecksList body={body} />
      </div>
    );
  }
  return (
    <div>
      <div className="banner err">
        恢复被拒绝（HTTP {status}）：{body.error ?? '服务端未给出错误说明'}
        {body.reason && <span>（reason: {body.reason}）</span>}
      </div>
      <ChecksList body={body} />
    </div>
  );
}

function ManifestDetail({ manifest }: { manifest: RunManifest }) {
  const m = manifest;
  return (
    <table className="data-table">
      <tbody>
        <tr>
          <th>驱动</th>
          <td>
            {m.driver.kind} · adapter <code>{m.driver.adapter}</code> ·{' '}
            routeRequest {m.driver.routeRequestProvided ? '有' : '无'}
          </td>
          <th>模型</th>
          <td>
            {m.model ?? '—'}
            {m.modelSource && <span className="muted">（来源：{m.modelSource}）</span>}
          </td>
        </tr>
        <tr>
          <th>终局</th>
          <td>
            <span className="pill">{m.status}</span> outcome: {m.outcome ?? '—'} ·
            steps: {m.steps ?? '—'} · 完成于 {fmtTime(m.finishedAt)}
            {m.error && <span className="err"> · error: {m.error}</span>}
          </td>
          <th>授权工具</th>
          <td>{m.grantedTools.length ? m.grantedTools.join(', ') : '（无——未授予任何工具）'}</td>
        </tr>
        <tr>
          <th>预算上限</th>
          <td>
            loop: maxSteps={m.budgetLimits.loop.maxSteps}, timeMs={m.budgetLimits.loop.timeMs},
            maxRetries={m.budgetLimits.loop.maxRetries}
            <br />
            extended: {recordEntries(m.budgetLimits.extended)}
          </td>
          <th>预算用量</th>
          <td>
            {m.budgetUsage
              ? recordEntries(m.budgetUsage)
              : '—（run 未终结，manifest 完成块尚未补全）'}
          </td>
        </tr>
        <tr>
          <th>Intents</th>
          <td>
            {m.intents
              ? <>共 {m.intents.total} 条 — {recordEntries(m.intents.byStatus)}</>
              : '—（未补全）'}
          </td>
          <th>证据</th>
          <td>
            {m.evidence
              ? <>共 {m.evidence.count} 条 — {recordEntries(m.evidence.byType)}</>
              : '—（未补全）'}
          </td>
        </tr>
        <tr>
          <th>Checkpoints</th>
          <td>
            {m.checkpoints
              ? m.checkpoints.count === 0
                ? '0 条'
                : `${m.checkpoints.count} 条（步位 ${m.checkpoints.firstStep ?? '—'}..${m.checkpoints.lastStep ?? '—'}）`
              : '—（未补全）'}
          </td>
          <th>上下文哈希</th>
          <td><code title={m.contextManifestHash}>{m.contextManifestHash.slice(0, 16)}…</code></td>
        </tr>
      </tbody>
    </table>
  );
}

export function ObservatoryPanel() {
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
        Observatory <span className="muted">全局运行观测 · §24–28 · manifests / checkpoints / resume</span>
      </h2>
      {err && <div className="banner err">run 列表不可用：{err}</div>}
      <div className="row">
        <button onClick={() => void load()}>刷新</button>
        {rows !== null && (
          <span className="muted">
            共 {rows.length} 个 run
            {[...byStatus.entries()].map(([s, n]) => ` · ${s} ${n}`).join('')}
            {leftovers > 0 && ` · 其中 ${leftovers} 个 RUNNING 记录无本进程执行（可能已中断）`}
          </span>
        )}
      </div>

      {rows === null && !err && <p className="muted">Loading runs…</p>}
      {rows !== null && rows.length === 0 && (
        <p className="muted">
          尚无任何 run 记录。run 由 Orchestrate 页签或 POST /api/runtime/runs 发起后会出现在这里。
        </p>
      )}

      {rows !== null && rows.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Run</th><th>状态</th><th>Agent</th><th>Task</th><th>项目</th>
              <th>创建时间</th><th>模型</th><th>Intents</th><th>Checkpoints</th><th>操作</th>
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
                        <span className="pill ok">本进程执行中</span>
                      ) : (
                        <span className="pill warn">可能已中断</span>
                      ))}
                  </td>
                  <td><code title={row.agentId}>{row.agentId.slice(0, 8)}…</code></td>
                  <td><code title={row.taskId}>{row.taskId.slice(0, 8)}…</code></td>
                  <td>
                    {row.projectName ?? row.projectId ?? (
                      <span className="muted">不可解析</span>
                    )}
                  </td>
                  <td>{fmtTime(row.createdAt)}</td>
                  <td>
                    {row.manifest ? (
                      <>
                        {row.manifest.model ?? '—'}
                        {row.manifest.modelSource && (
                          <span className="muted">（{row.manifest.modelSource}）</span>
                        )}
                      </>
                    ) : (
                      <span className="pill warn">无 manifest</span>
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
                    <button onClick={() => expand(row)}>{expanded ? '收起' : '详情'}</button>
                    {resumable && (
                      <>
                        {' '}
                        <button
                          onClick={() => void doResume(row)}
                          disabled={resume?.phase === 'pending'}
                        >
                          {resume?.phase === 'pending' ? '恢复中…' : '从检查点恢复'}
                        </button>
                        <div className="muted" style={{ fontSize: 11 }}>
                          将创建一个新的恢复 run（原 run 不复活）
                        </div>
                      </>
                    )}
                  </td>
                </tr>,
                expanded && (
                  <tr key={`${row.id}-detail`}>
                    <td colSpan={10}>
                      <p className="muted" style={{ fontSize: 12 }}>
                        run <code>{row.id}</code> · outcome: {row.outcome ?? '—'} ·
                        steps: {row.steps} · 完成于 {fmtTime(row.finishedAt)} ·
                        证据 {row.evidence.length} 条 · handoffs {row.handoffs.length} 次
                        {row.error && <span className="err"> · error: {row.error}</span>}
                      </p>

                      <h4>Run Manifest（Batch 15）</h4>
                      {row.manifest === null ? (
                        <p className="muted">
                          该 run 无 manifest——它是清单接线前的遗留 run，服务端不回填、
                          不编造（GET /manifest 返回 404）。上方列表字段即其全部已知记录。
                        </p>
                      ) : manifests[row.id]?.phase === 'ready' ? (
                        <ManifestDetail
                          manifest={(manifests[row.id] as { phase: 'ready'; manifest: RunManifest }).manifest}
                        />
                      ) : manifests[row.id]?.phase === 'error' ? (
                        <div className="banner err">
                          manifest 不可用：
                          {(manifests[row.id] as { phase: 'error'; message: string }).message}
                        </div>
                      ) : (
                        <p className="muted">Loading manifest…</p>
                      )}

                      <RunCheckpointsSection
                        checkpoints={ckpts.checkpoints}
                        latest={ckpts.latest}
                        error={ckpts.error}
                        onRefresh={() => void ckpts.reload()}
                      />

                      {resume && (
                        <div>
                          <h4>从检查点恢复（§28.4）</h4>
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

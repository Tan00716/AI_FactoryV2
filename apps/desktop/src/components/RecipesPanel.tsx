/**
 * RecipesPanel — deterministic recipe-based code migration library &
 * workflow (Amazon Q `/transform` / OpenRewrite style, zero-model):
 * pick a recipe → generate a plan (per-file diff preview, nothing is
 * written) → plan goes through the central approval system → execute
 * applies the planned bytes verbatim → verify commands run and their
 * exit codes decide the verdict. Anything a recipe does not cover is
 * shown in an explicit unhandled list.
 * Wired to apps/server/src/routes/recipes.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api as coreApi, authHeaders, type TaskSummary } from '../api';
import { useLang } from '../i18n';

// ------------------------------------------------------------- API ----

export interface RecipeSummary {
  name: string;
  version: string;
  description: string;
  tags: string[];
  source: 'builtin' | 'custom';
  opCount: number;
  verify: { build?: string; test?: string } | null;
  notes: string | null;
}

export interface PlannedOpDetail {
  opIndex: number;
  op: string;
  file: string;
  status: 'applied' | 'no-match' | 'error';
  note: string;
  diff: string | null;
}

export interface PlannedFile {
  file: string;
  beforeSha256: string;
  existsBefore: boolean;
  afterContent: string | null;
  diff: string | null;
  ops: PlannedOpDetail[];
  willChange: boolean;
}

export interface UnhandledItem {
  file?: string;
  opIndex?: number;
  reason: string;
}

export interface RecipePlanView {
  recipeName: string;
  recipeVersion: string;
  projectPath: string;
  applicable: boolean;
  notes: string[];
  files: PlannedFile[];
  unhandled: UnhandledItem[];
  appliedOps: number;
  noMatchOps: number;
  errorOps: number;
}

export interface VerifyResult {
  kind: 'build' | 'test';
  command: string;
  ok: boolean;
  exitCode: number;
  ms: number;
  output: string;
}

export interface RecipeRun {
  id: string;
  recipeName: string;
  recipeVersion: string;
  projectPath: string;
  taskId?: string;
  status: 'planned' | 'approval-pending' | 'executing' | 'verifying' | 'done' | 'failed' | 'rejected';
  plan: RecipePlanView;
  approvalId?: string;
  verifyResults: VerifyResult[];
  failReason?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecipeRunSummary {
  id: string;
  recipeName: string;
  status: string;
  approvalId: string | null;
  appliedOps: number;
  errorOps: number;
  unhandled: number;
  failReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecipesApi {
  recipes(): Promise<{ recipes: RecipeSummary[] }>;
  plan(recipeName: string, projectPath: string, taskId?: string): Promise<{ run: RecipeRun }>;
  runs(): Promise<{ runs: RecipeRunSummary[] }>;
  runDetail(id: string): Promise<{ run: RecipeRun; approvalStatus: string | null }>;
  requestApproval(id: string): Promise<{ approvalId: string; run: RecipeRunSummary }>;
  execute(id: string, approvalId: string): Promise<{ run: RecipeRun }>;
  deleteRun(id: string): Promise<{ removed: boolean }>;
}

export function createRecipesApi(base: string): RecipesApi {
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
    });
    const body = (await res.json()) as T & { error?: string; message?: string };
    if (!res.ok) {
      const e = new Error((body.message as string) ?? (body.error as string) ?? `HTTP ${res.status}`) as Error & {
        status: number;
      };
      e.status = res.status;
      throw e;
    }
    return body;
  }
  return {
    recipes: () => req<{ recipes: RecipeSummary[] }>('/recipes'),
    plan: (recipeName, projectPath, taskId) =>
      req<{ run: RecipeRun }>('/recipes/plan', {
        method: 'POST',
        body: JSON.stringify({ recipeName, projectPath, ...(taskId ? { taskId } : {}) }),
      }),
    runs: () => req<{ runs: RecipeRunSummary[] }>('/recipes/runs'),
    runDetail: (id) => req<{ run: RecipeRun; approvalStatus: string | null }>(`/recipes/runs/${encodeURIComponent(id)}`),
    requestApproval: (id) =>
      req<{ approvalId: string; run: RecipeRunSummary }>(`/recipes/runs/${encodeURIComponent(id)}/request-approval`, { method: 'POST' }),
    execute: (id, approvalId) =>
      req<{ run: RecipeRun }>(`/recipes/runs/${encodeURIComponent(id)}/execute`, {
        method: 'POST',
        body: JSON.stringify({ approvalId }),
      }),
    deleteRun: (id) => req<{ removed: boolean }>(`/recipes/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}

// ------------------------------------------------------------ panel ----

const STATUS_COLORS: Record<string, string> = {
  planned: 'var(--muted, #8b949e)',
  'approval-pending': '#d29922',
  executing: '#d29922',
  verifying: '#d29922',
  done: '#3fb950',
  failed: '#f85149',
  rejected: '#f85149',
  applied: '#3fb950',
  'no-match': '#d29922',
  error: '#f85149',
};

export function RecipesPanel({ api }: { api: RecipesApi }) {
  const { t } = useLang();
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [runs, setRuns] = useState<RecipeRunSummary[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [projectPath, setProjectPath] = useState<string>(() => localStorage.getItem('recipes.projectPath') ?? '');
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [taskId, setTaskId] = useState('');
  const [detail, setDetail] = useState<{ run: RecipeRun; approvalStatus: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, list, ts] = await Promise.all([api.recipes(), api.runs(), coreApi.tasks()]);
      setRecipes(r.recipes);
      setRuns(list.runs);
      setTasks(ts);
      setSelected((prev) => prev || r.recipes[0]?.name || '');
      setTaskId((prev) => prev || ts[0]?.id || '');
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('recipes.loadFailed'));
    }
  }, [api, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (projectPath) localStorage.setItem('recipes.projectPath', projectPath);
  }, [projectPath]);

  const loadRun = useCallback(
    async (id: string) => {
      try {
        const d = await api.runDetail(id);
        setDetail(d);
        return d;
      } catch (e) {
        setErr(e instanceof Error ? e.message : t('recipes.loadFailed'));
        return null;
      }
    },
    [api, t],
  );

  // Poll while an approval is pending so the Execute button lights up
  // as soon as the decision lands in the Approvals tab.
  useEffect(() => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
    if (detail && detail.run.status === 'approval-pending') {
      pollRef.current = window.setInterval(() => void loadRun(detail.run.id), 3000);
    }
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [detail, loadRun]);

  const guard = async (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('recipes.opFailed'));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const onPlan = () =>
    void guard(async () => {
      if (!selected) return;
      const r = await api.plan(selected, projectPath.trim(), taskId || undefined);
      const d = await api.runDetail(r.run.id);
      setDetail(d);
    });

  const onRequestApproval = () =>
    void guard(async () => {
      if (!detail) return;
      await api.requestApproval(detail.run.id);
      await loadRun(detail.run.id);
    });

  const onExecute = () =>
    void guard(async () => {
      if (!detail || !detail.run.approvalId) return;
      await api.execute(detail.run.id, detail.run.approvalId);
      await loadRun(detail.run.id);
    });

  const onDeleteRun = (id: string) =>
    void guard(async () => {
      await api.deleteRun(id);
      if (detail?.run.id === id) setDetail(null);
    });

  const sel = recipes.find((r) => r.name === selected);
  const canExecute =
    detail &&
    detail.run.approvalId &&
    detail.approvalStatus === 'APPROVED' &&
    (detail.run.status === 'planned' || detail.run.status === 'approval-pending');

  return (
    <div style={{ padding: 12, overflowY: 'auto', height: '100%' }}>
      <h3 style={{ margin: '0 0 8px' }}>{t('recipes.title')}</h3>
      {err && <div className="banner err">{err}</div>}
      <div className="muted" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.6 }}>
        {t('recipes.honestNote')}
      </div>

      {/* ---------------- library ---------------- */}
      <h4 style={{ margin: '0 0 6px' }}>{t('recipes.library')}</h4>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        {recipes.map((r) => (
          <button
            key={r.name}
            onClick={() => setSelected(r.name)}
            style={{
              textAlign: 'left',
              padding: '8px 10px',
              borderRadius: 6,
              border: selected === r.name ? '1px solid #d29922' : '1px solid var(--border, #30363d)',
              background: selected === r.name ? 'rgba(210,153,34,0.08)' : undefined,
              width: 300,
              cursor: 'pointer',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              {r.name} <span className="muted">v{r.version} · {r.source === 'builtin' ? t('recipes.builtin') : t('recipes.custom')}</span>
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginTop: 2 }}>{r.description}</div>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              {t('recipes.ops')}: {r.opCount} · {r.tags.join(', ')}
            </div>
          </button>
        ))}
        {recipes.length === 0 && <div className="muted">{t('recipes.noRecipes')}</div>}
      </div>
      {sel && (
        <div style={{ marginBottom: 12 }}>
          {sel.notes && (
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
              ⚠ {sel.notes}
            </div>
          )}
        </div>
      )}

      {/* ---------------- plan ---------------- */}
      <h4 style={{ margin: '0 0 6px' }}>{t('recipes.newPlan')}</h4>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={busy} style={{ padding: 6, borderRadius: 4, maxWidth: 320 }}>
          <option value="">{t('recipes.noTaskSelected')}</option>
          {tasks.map((tk) => (
            <option key={tk.id} value={tk.id}>{tk.title} ({tk.id})</option>
          ))}
        </select>
        <input
          type="text"
          placeholder={t('recipes.projectPathPh')}
          value={projectPath}
          onChange={(e) => setProjectPath(e.target.value)}
          style={{ flex: 1, padding: 6, borderRadius: 4, minWidth: 260 }}
        />
        <button className="btn" disabled={busy || !selected || !projectPath.trim()} onClick={onPlan}>
          {t('recipes.generatePlan')}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        {t('recipes.bindTaskHint')} {t('recipes.projectRootsHint')}
      </div>

      {detail && (
        <div style={{ border: '1px solid var(--border, #30363d)', borderRadius: 6, padding: 10, marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong>{detail.run.recipeName}</strong>
            <span style={{ color: STATUS_COLORS[detail.run.status] ?? undefined, fontSize: 12 }}>
              {t(`recipes.status.${detail.run.status}`)}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>{detail.run.projectPath}</span>
            {detail.run.taskId && <span className="muted" style={{ fontSize: 12 }}>{t('recipes.bindTask')}: <code>{detail.run.taskId}</code></span>}
          </div>
          {!detail.run.plan.applicable && (
            <div className="banner err" style={{ marginTop: 8 }}>{detail.run.plan.notes.join(' ')}</div>
          )}
          <div className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
            {t('recipes.planSummary')}: {t('recipes.appliedOps')} {detail.run.plan.appliedOps} · {t('recipes.noMatchOps')}{' '}
            {detail.run.plan.noMatchOps} · {t('recipes.errorOps')} {detail.run.plan.errorOps} · {t('recipes.unhandledCount')}{' '}
            {detail.run.plan.unhandled.length}
          </div>

          {/* per-file plans + diffs */}
          {detail.run.plan.files.map((pf) => (
            <details key={pf.file} open style={{ margin: '8px 0' }}>
              <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                {pf.file} {pf.willChange ? `— ${t('recipes.willChange')}` : `— ${t('recipes.noChange')}`}
              </summary>
              <div style={{ marginLeft: 12, marginTop: 4 }}>
                {pf.ops.map((op) => (
                  <div key={op.opIndex} style={{ fontSize: 12, marginBottom: 2 }}>
                    <span style={{ color: STATUS_COLORS[op.status] }}>●</span> #{op.opIndex + 1} {op.op} — {op.note}
                  </div>
                ))}
                {pf.diff && (
                  <pre
                    style={{
                      background: 'var(--code-bg, #0d1117)',
                      borderRadius: 4,
                      padding: 8,
                      fontSize: 11,
                      overflowX: 'auto',
                      whiteSpace: 'pre-wrap',
                      margin: '6px 0',
                    }}
                  >
                    {pf.diff}
                  </pre>
                )}
              </div>
            </details>
          ))}

          {/* unhandled list — never silent */}
          {detail.run.plan.unhandled.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{t('recipes.unhandled')}</div>
              <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
                {detail.run.plan.unhandled.map((u, i) => (
                  <li key={i}>
                    {u.file ? <code>{u.file}</code> : null} {u.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* approval + execute */}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {!detail.run.approvalId && detail.run.taskId && detail.run.plan.applicable && detail.run.plan.errorOps === 0 && (
              <button className="btn" disabled={busy} onClick={onRequestApproval}>
                {t('recipes.requestApproval')}
              </button>
            )}
            {detail.run.approvalId && (
              <span style={{ fontSize: 12 }}>
                {t('recipes.approval')}: <code>{detail.run.approvalId}</code> —{' '}
                {detail.approvalStatus ?? t('recipes.approvalUnknown')}
                {detail.run.status === 'approval-pending' && detail.approvalStatus !== 'APPROVED' && (
                  <span className="muted"> · {t('recipes.decideHint')}</span>
                )}
              </span>
            )}
            <button className="btn" disabled={busy || !canExecute} onClick={onExecute}>
              {busy ? t('recipes.executing') : t('recipes.execute')}
            </button>
          </div>

          {/* verify results */}
          {detail.run.verifyResults.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{t('recipes.verify')}</div>
              {detail.run.verifyResults.map((v, i) => (
                <details key={i} style={{ margin: '4px 0' }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12 }}>
                    <span style={{ color: v.ok ? '#3fb950' : '#f85149' }}>●</span> {v.kind}: <code>{v.command}</code> — exit {v.exitCode} ({v.ms}ms)
                  </summary>
                  <pre style={{ fontSize: 11, overflowX: 'auto', whiteSpace: 'pre-wrap', margin: '4px 0' }}>{v.output}</pre>
                </details>
              ))}
            </div>
          )}
          {detail.run.failReason && <div className="banner err" style={{ marginTop: 8 }}>{detail.run.failReason}</div>}
        </div>
      )}

      {/* ---------------- runs ---------------- */}
      <h4 style={{ margin: '0 0 6px' }}>{t('recipes.runs')}</h4>
      {runs.length === 0 && <div className="muted">{t('recipes.noRuns')}</div>}
      {runs.map((r) => (
        <div
          key={r.id}
          style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border, #30363d)', fontSize: 13 }}
        >
          <span style={{ fontWeight: 600 }}>{r.recipeName}</span>
          <span style={{ color: STATUS_COLORS[r.status] ?? undefined }}>{t(`recipes.status.${r.status}`) ?? r.status}</span>
          <span className="muted" style={{ fontSize: 12 }}>{r.createdAt}</span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => void loadRun(r.id)}>{t('recipes.showDetail')}</button>
          <button className="btn" disabled={busy} onClick={() => onDeleteRun(r.id)}>{t('recipes.delete')}</button>
        </div>
      ))}
    </div>
  );
}

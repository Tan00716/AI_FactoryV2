/**
 * ChangesPanel — spec §66 (AI Change Review UI).
 *
 * Every AI code modification is visible: changes are assembled server-side
 * from the task/* branches of a git repo (routes/changes.ts) with the file
 * list, diff summary, reason (commit message), related tests and evidence
 * links. Each change carries Accept / Reject / Revert buttons; "View Diff"
 * opens the Monaco DiffEditor (DiffViewer.tsx).
 */
import { useCallback, useEffect, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang } from '../i18n';
import { DiffViewer } from './DiffViewer';

const API_BASE = defaultApiBase();

// ------------------------------------------------------------- API ----

export interface ChangeFile {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ChangeItem {
  id: string;
  branch: string;
  title: string;
  reason: string;
  author: string;
  date: string;
  files: ChangeFile[];
  additions: number;
  deletions: number;
  diffSummary: string;
  relatedTests: string[];
  evidenceLinks: { id: string; type: string; title: string; status: string }[];
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'REVERTED';
  taskId: string | null;
}

export interface ChangesApi {
  list(repo?: string): Promise<{ repo: string; changes: ChangeItem[] }>;
  accept(id: string, repo?: string): Promise<{ ok: boolean; status: string }>;
  reject(id: string, repo?: string): Promise<{ ok: boolean; status: string }>;
  revert(id: string, repo?: string): Promise<{ ok: boolean; status: string; revertSha?: string }>;
}

export function createChangesApi(base: string): ChangesApi {
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
    });
    const body = (await res.json()) as T;
    if (!res.ok) {
      const err = body as { error?: string };
      const e = new Error(err.error ?? `HTTP ${res.status}`) as Error & { status: number };
      e.status = res.status;
      throw e;
    }
    return body;
  }
  const repoQ = (repo?: string) => (repo ? `?repo=${encodeURIComponent(repo)}` : '');
  return {
    list: (repo) => req<{ repo: string; changes: ChangeItem[] }>(`/changes${repoQ(repo)}`),
    accept: (id, repo) =>
      req<{ ok: boolean; status: string }>(`/changes/${id}/accept${repoQ(repo)}`, { method: 'POST', body: '{}' }),
    reject: (id, repo) =>
      req<{ ok: boolean; status: string }>(`/changes/${id}/reject${repoQ(repo)}`, { method: 'POST', body: '{}' }),
    revert: (id, repo) =>
      req<{ ok: boolean; status: string; revertSha?: string }>(
        `/changes/${id}/revert${repoQ(repo)}`,
        { method: 'POST', body: '{}' },
      ),
  };
}

// ------------------------------------------------------------ panel ----

const STATUS_COLORS: Record<ChangeItem['status'], string> = {
  PENDING: 'var(--border)',
  ACCEPTED: 'var(--green)',
  REJECTED: 'var(--red)',
  REVERTED: 'var(--yellow)',
};

type DetailTab = 'reason' | 'tests' | 'evidence' | null;

export function ChangesPanel({ api }: { api: ChangesApi }) {
  const { t } = useLang();
  const [repo, setRepo] = useState('');
  const [resolvedRepo, setResolvedRepo] = useState('');
  const [changes, setChanges] = useState<ChangeItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, DetailTab>>({});
  const [diff, setDiff] = useState<{ changeId: string; file: string; title: string } | null>(null);

  const refresh = useCallback(async () => {
    setErr(null);
    setBusy(true);
    try {
      const { repo: r, changes: c } = await api.list(repo || undefined);
      setResolvedRepo(r);
      setChanges(c);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('changes.loadFailed'));
    } finally {
      setBusy(false);
    }
  }, [api, repo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setErr(null);
    setBusyId(id);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('changes.actionFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const toggleDetail = (id: string, tab: Exclude<DetailTab, null>) =>
    setDetail((d) => ({ ...d, [id]: d[id] === tab ? null : tab }));

  return (
    <div style={{ padding: 12, overflowY: 'auto', height: '100%' }}>
      <h3 style={{ margin: '0 0 8px' }}>
        {t('changes.title')} <span className="muted">§66</span>
      </h3>
      <ShadowSection />
      {err && <div className="banner err">{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          type="text"
          placeholder={t('changes.repoPlaceholder')}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          style={{ flex: 1, padding: 6, borderRadius: 4 }}
        />
        <button onClick={() => void refresh()} disabled={busy}>
          {busy ? t('changes.loading') : t('changes.refresh')}
        </button>
      </div>
      {resolvedRepo && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Repo: <span style={{ fontFamily: 'monospace' }}>{resolvedRepo}</span> ·{' '}
          {t('changes.changeCount', { count: changes.length, plural: changes.length === 1 ? '' : 's' })}
        </div>
      )}
      {changes.length === 0 && !busy && (
        <div className="muted">{t('changes.emptyPrefix')}<span style={{ fontFamily: 'monospace' }}>task/*</span>{t('changes.emptySuffix')}</div>
      )}

      {changes.map((c) => {
        const active = detail[c.id] ?? null;
        const working = busyId === c.id;
        return (
          <div
            key={c.id}
            style={{
              border: '1px solid var(--border)',
              borderLeft: `3px solid ${STATUS_COLORS[c.status]}`,
              borderRadius: 6,
              padding: 10,
              marginBottom: 10,
              background: 'var(--bg2)',
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span className="pill" style={{ borderColor: STATUS_COLORS[c.status] }}>{c.status}</span>
              <b style={{ flex: 1 }}>{c.title}</b>
              <span className="muted" style={{ fontSize: 11, fontFamily: 'monospace' }}>
                {c.id.slice(0, 8)}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              <span style={{ fontFamily: 'monospace' }}>{c.branch}</span> · {c.author} ·{' '}
              {new Date(c.date).toLocaleString()} · {c.diffSummary}
              {c.taskId && (
                <>
                  {t('changes.taskRef')}<span style={{ fontFamily: 'monospace' }}>{c.taskId.slice(0, 8)}</span>
                </>
              )}
            </div>

            <div style={{ marginBottom: 8 }}>
              {c.files.map((f) => (
                <div key={f.path} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 2 }}>
                  <span style={{ fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {f.path}
                  </span>
                  {!f.binary && (
                    <span className="muted">
                      <span style={{ color: 'var(--green)' }}>+{f.additions}</span>{' '}
                      <span style={{ color: 'var(--red)' }}>−{f.deletions}</span>
                    </span>
                  )}
                  {f.binary && <span className="muted">{t('changes.binaryBadge')}</span>}
                  {!f.binary && (
                    <button
                      style={{ fontSize: 11 }}
                      onClick={() => setDiff({ changeId: c.id, file: f.path, title: c.title })}
                    >
                      {t('changes.viewDiff')}
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              <button style={{ fontSize: 12 }} onClick={() => toggleDetail(c.id, 'reason')}>
                {t('changes.viewReason')}
              </button>
              <button style={{ fontSize: 12 }} onClick={() => toggleDetail(c.id, 'tests')}>
                {t('changes.viewTests')} {c.relatedTests.length > 0 && <span className="pill">{c.relatedTests.length}</span>}
              </button>
              <button style={{ fontSize: 12 }} onClick={() => toggleDetail(c.id, 'evidence')}>
                {t('changes.viewEvidence')} {c.evidenceLinks.length > 0 && <span className="pill">{c.evidenceLinks.length}</span>}
              </button>
              <span style={{ flex: 1 }} />
              <button
                style={{ fontSize: 12 }}
                className="primary"
                disabled={working || c.status === 'ACCEPTED'}
                onClick={() => void act(c.id, () => api.accept(c.id, repo || undefined))}
              >
                {t('changes.accept')}
              </button>
              <button
                style={{ fontSize: 12 }}
                disabled={working || c.status === 'REJECTED'}
                onClick={() => void act(c.id, () => api.reject(c.id, repo || undefined))}
              >
                {t('changes.reject')}
              </button>
              <button
                style={{ fontSize: 12 }}
                disabled={working || c.status === 'REVERTED'}
                onClick={() => {
                  if (window.confirm(t('changes.confirmRevert', { id: c.id.slice(0, 8), title: c.title, branch: c.branch }))) {
                    void act(c.id, () => api.revert(c.id, repo || undefined));
                  }
                }}
              >
                {t('changes.revert')}
              </button>
            </div>

            {active === 'reason' && (
              <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', background: 'var(--bg3)', padding: 8, borderRadius: 4 }}>
                {c.reason || <span className="muted">{t('changes.noReason')}</span>}
              </pre>
            )}
            {active === 'tests' && (
              <div style={{ fontSize: 12, background: 'var(--bg3)', padding: 8, borderRadius: 4 }}>
                {c.relatedTests.length === 0 ? (
                  <span className="muted">{t('changes.noTestRefs')}</span>
                ) : (
                  c.relatedTests.map((t, i) => <div key={i} style={{ fontFamily: 'monospace' }}>🧪 {t}</div>)
                )}
              </div>
            )}
            {active === 'evidence' && (
              <div style={{ fontSize: 12, background: 'var(--bg3)', padding: 8, borderRadius: 4 }}>
                {c.evidenceLinks.length === 0 ? (
                  <span className="muted">{t('changes.noSealedEvidence')}</span>
                ) : (
                  c.evidenceLinks.map((e) => (
                    <div key={e.id}>
                      <span className="pill">{e.type}</span> {e.title}{' '}
                      <span className="muted">({e.status})</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}

      {diff && (
        <DiffViewer
          repo={repo}
          changeId={diff.changeId}
          file={diff.file}
          title={diff.title}
          onClose={() => setDiff(null)}
        />
      )}
    </div>
  );
}

// -------------------------------------------------- shadow checkpoints ----

/**
 * ShadowSection — third-wave task 7 (Cline sidecar style) shadow git
 * checkpoints. Independent of the §66 change-review list above and of the
 * W-D session checkpoints: a git-object snapshot layer with task-scoped
 * diffs and one-click Undo (pre-restore backup keeps the undo reversible).
 */

interface ShadowCheckpointView {
  id: string;
  workspaceId: string;
  taskId: string | null;
  label: string;
  auto: boolean;
  trigger: string;
  createdAt: string;
  sha: string;
  fileCount: number;
  additions: number;
  deletions: number;
  empty: boolean;
  skipped: { path: string; reason: string }[];
  skippedTotal: number;
}

interface ShadowConfigView {
  workspaceId: string;
  workspacePath: string;
  autoOnToolUse: boolean;
  autoOnRunStart: boolean;
}

async function shadowReq<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/shadow-checkpoints${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

function DiffPre({ text, truncated }: { text: string; truncated: boolean }) {
  const { t } = useLang();
  return (
    <div>
      <pre
        style={{
          fontSize: 12,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          background: 'var(--bg3)',
          padding: 8,
          borderRadius: 4,
          maxHeight: 320,
          overflowY: 'auto',
        }}
      >
        {text.split('\n').map((line, i) => (
          <div
            key={i}
            style={{
              color: line.startsWith('+') && !line.startsWith('+++')
                ? 'var(--green)'
                : line.startsWith('-') && !line.startsWith('---')
                  ? 'var(--red)'
                  : line.startsWith('@@')
                    ? 'var(--yellow)'
                    : undefined,
            }}
          >
            {line}
          </div>
        ))}
      </pre>
      {truncated && <div className="muted" style={{ fontSize: 11 }}>{t('shadow.diffTruncated')}</div>}
    </div>
  );
}

export function ShadowSection() {
  const { t } = useLang();
  const [open, setOpen] = useState(true);
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [label, setLabel] = useState('');
  const [taskFilter, setTaskFilter] = useState('');
  const [config, setConfig] = useState<ShadowConfigView | null>(null);
  const [autoTool, setAutoTool] = useState(false);
  const [autoRun, setAutoRun] = useState(false);
  const [list, setList] = useState<ShadowCheckpointView[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [diffCache, setDiffCache] = useState<Record<string, { diff: string; truncated: boolean }>>({});
  const [taskDiff, setTaskDiff] = useState<{ diff: string; truncated: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId.trim()) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await shadowReq<{ config: ShadowConfigView | null; checkpoints: ShadowCheckpointView[] }>(
        `?workspaceId=${encodeURIComponent(workspaceId.trim())}`,
      );
      setList(r.checkpoints);
      setConfig(r.config);
      if (r.config) {
        setWorkspacePath(r.config.workspacePath);
        setAutoTool(r.config.autoOnToolUse);
        setAutoRun(r.config.autoOnRunStart);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('shadow.loadFailed'));
    } finally {
      setBusy(false);
    }
  }, [workspaceId, t]);

  const saveConfig = async () => {
    setErr(null);
    try {
      const r = await shadowReq<{ config: ShadowConfigView }>('/config', {
        method: 'PUT',
        body: JSON.stringify({
          workspaceId: workspaceId.trim(),
          workspacePath: workspacePath.trim(),
          autoOnToolUse: autoTool,
          autoOnRunStart: autoRun,
        }),
      });
      setConfig(r.config);
      setNotice(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('shadow.actionFailed'));
    }
  };

  const snapshot = async () => {
    setErr(null);
    try {
      await shadowReq('', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: workspaceId.trim(),
          workspacePath: workspacePath.trim() || config?.workspacePath,
          taskId: taskFilter.trim() || undefined,
          label: label.trim() || undefined,
        }),
      });
      setLabel('');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('shadow.actionFailed'));
    }
  };

  const viewDiff = async (id: string) => {
    if (openDiff === id) {
      setOpenDiff(null);
      return;
    }
    setErr(null);
    try {
      if (!diffCache[id]) {
        const r = await shadowReq<{ diff: string; truncated: boolean }>(
          `/${id}/diff?workspaceId=${encodeURIComponent(workspaceId.trim())}`,
        );
        setDiffCache((c) => ({ ...c, [id]: { diff: r.diff, truncated: r.truncated } }));
      }
      setOpenDiff(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('shadow.actionFailed'));
    }
  };

  const viewTaskDiff = async () => {
    setErr(null);
    try {
      const r = await shadowReq<{ diff: string; truncated: boolean }>(
        `/task-diff?workspaceId=${encodeURIComponent(workspaceId.trim())}&taskId=${encodeURIComponent(taskFilter.trim())}`,
      );
      setTaskDiff({ diff: r.diff, truncated: r.truncated });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('shadow.actionFailed'));
    }
  };

  const undo = async (id: string) => {
    if (!window.confirm(t('shadow.undoConfirm'))) return;
    setErr(null);
    setNotice(null);
    try {
      const r = await shadowReq<{ restoredId: string; backup: ShadowCheckpointView | null; leftInPlace: string[] }>(
        `/${id}/restore`,
        {
          method: 'POST',
          body: JSON.stringify({ workspaceId: workspaceId.trim(), workspacePath: config?.workspacePath }),
        },
      );
      const parts = [t('shadow.restored')];
      if (r.backup) parts.push(`${t('shadow.backupNote')}: ${r.backup.id.slice(0, 12)}`);
      if (r.leftInPlace.length > 0) parts.push(`${t('shadow.leftInPlace')}: ${r.leftInPlace.slice(0, 5).join(', ')}`);
      setNotice(parts.join(' · '));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('shadow.actionFailed'));
    }
  };

  const shown = taskFilter.trim()
    ? list.filter((c) => (c.taskId ?? '').includes(taskFilter.trim()))
    : list;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginBottom: 12, background: 'var(--bg2)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: open ? 8 : 0 }}>
        <button style={{ fontSize: 12 }} onClick={() => setOpen((o) => !o)}>{open ? '▾' : '▸'}</button>
        <b>{t('shadow.title')}</b>
        <span className="muted" style={{ fontSize: 11 }}>sidecar git</span>
      </div>
      {open && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{t('shadow.desc')}</div>
          {err && <div className="banner err">{err}</div>}
          {notice && <div className="banner ok">{notice}</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <input
              type="text"
              placeholder={t('shadow.workspaceId')}
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              style={{ padding: 6, borderRadius: 4, width: 160 }}
            />
            <input
              type="text"
              placeholder={t('shadow.workspacePath')}
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              style={{ padding: 6, borderRadius: 4, flex: 1, minWidth: 220, fontFamily: 'monospace' }}
            />
            <button style={{ fontSize: 12 }} onClick={() => void refresh()} disabled={busy || !workspaceId.trim()}>
              {t('shadow.refresh')}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8, fontSize: 12 }}>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input type="checkbox" checked={autoTool} onChange={(e) => setAutoTool(e.target.checked)} />
              {t('shadow.autoOnToolUse')}
            </label>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
              {t('shadow.autoOnRunStart')}
            </label>
            <button style={{ fontSize: 12 }} onClick={() => void saveConfig()} disabled={!workspaceId.trim() || !workspacePath.trim()}>
              {t('shadow.saveConfig')}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <input
              type="text"
              placeholder={t('shadow.label')}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              style={{ padding: 6, borderRadius: 4, flex: 1, minWidth: 160 }}
            />
            <input
              type="text"
              placeholder={t('shadow.taskFilter')}
              value={taskFilter}
              onChange={(e) => setTaskFilter(e.target.value)}
              style={{ padding: 6, borderRadius: 4, width: 160, fontFamily: 'monospace' }}
            />
            <button style={{ fontSize: 12 }} className="primary" onClick={() => void snapshot()} disabled={!workspaceId.trim() || (!workspacePath.trim() && !config)}>
              {t('shadow.snapshot')}
            </button>
            <button style={{ fontSize: 12 }} onClick={() => void viewTaskDiff()} disabled={!workspaceId.trim() || !taskFilter.trim()}>
              {t('shadow.viewChanges')} (task)
            </button>
          </div>
          {taskDiff && (
            <div style={{ marginBottom: 8 }}>
              <DiffPre text={taskDiff.diff} truncated={taskDiff.truncated} />
              <button style={{ fontSize: 11, marginTop: 4 }} onClick={() => setTaskDiff(null)}>{t('shadow.hideDiff')}</button>
            </div>
          )}
          {shown.length === 0 && !busy && <div className="muted" style={{ fontSize: 12 }}>{t('shadow.noCheckpoints')}</div>}
          {shown.map((c) => (
            <div key={c.id} style={{ borderTop: '1px solid var(--border)', padding: '8px 0', fontSize: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                <span className="pill">{c.auto ? t('shadow.auto') : t('shadow.manual')}</span>
                {c.taskId && <span className="pill" style={{ fontFamily: 'monospace' }}>{c.taskId}</span>}
                <b style={{ flex: 1 }}>{c.label}</b>
                <span className="muted" style={{ fontFamily: 'monospace' }}>{c.id.slice(0, 12)}</span>
                <span className="muted">{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              <div className="muted" style={{ marginBottom: 4 }}>
                {c.empty ? t('shadow.empty') : (
                  <>{t('shadow.filesChanged', { count: c.fileCount })} · <span style={{ color: 'var(--green)' }}>+{c.additions}</span> <span style={{ color: 'var(--red)' }}>−{c.deletions}</span></>
                )}
                {c.skippedTotal > 0 && (
                  <> · {t('shadow.skipped')}: {c.skippedTotal} ({c.skipped.slice(0, 3).map((s) => s.path).join(', ')}{c.skippedTotal > 3 ? '…' : ''})</>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={{ fontSize: 11 }} onClick={() => void viewDiff(c.id)}>
                  {openDiff === c.id ? t('shadow.hideDiff') : t('shadow.viewChanges')}
                </button>
                <button style={{ fontSize: 11 }} onClick={() => void undo(c.id)}>
                  {t('shadow.undo')}
                </button>
              </div>
              {openDiff === c.id && diffCache[c.id] && (
                <div style={{ marginTop: 6 }}>
                  <DiffPre text={diffCache[c.id].diff} truncated={diffCache[c.id].truncated} />
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

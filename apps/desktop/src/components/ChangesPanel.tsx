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

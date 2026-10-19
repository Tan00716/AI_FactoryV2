import { useCallback, useEffect, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang } from '../i18n';

export interface SessionRecord {
  id: string;
  title: string;
  status: 'active' | 'archived';
  projectId: string | null;
  runIds: string[];
  taskIds: string[];
  checkpointIds: string[];
  worktreeId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionCheckpointRecord {
  id: string;
  sessionId: string;
  label: string;
  createdAt: string;
  createdBy: string;
  runResumePoints: Array<{ runId: string; stepPosition: number; capturedAt: number }>;
  codeRoot: string | null;
  gitHead: string | null;
  gitDiff: string | null;
  gitDiffTruncated: boolean;
  gitDiffNote: string;
}

export interface SessionApi {
  list(): Promise<{ sessions: SessionRecord[] }>;
  create(input: { title: string; projectId?: string }): Promise<{ session: SessionRecord }>;
  archive(id: string): Promise<{ session: SessionRecord }>;
  resume(id: string): Promise<{
    session: SessionRecord;
    tasks: Array<{ id: string; title: string; status?: string }>;
    runResumePoints: Array<{
      runId: string;
      stepPosition: number;
      capturedAt: number;
      resumeEndpoint: string;
      hasCheckpoint: boolean;
    }>;
    checkpointIds: string[];
    resumedAt: string;
  }>;
  listCheckpoints(id: string): Promise<{ checkpoints: SessionCheckpointRecord[] }>;
  createCheckpoint(
    id: string,
    input: { label?: string; codeRoot?: string },
  ): Promise<{ checkpoint: SessionCheckpointRecord }>;
  restoreCheckpoint(
    id: string,
    checkpointId: string,
  ): Promise<{ session: SessionRecord; codeApplied: boolean; codeApplyReason: string; preRestoreCheckpointId: string }>;
}

const DEFAULT_BASE = defaultApiBase();

/** Session worktrees (task 3): isolated git worktrees per parallel session. */
export interface SessionWorktreeRecord {
  id: string;
  name: string;
  projectPath: string;
  worktreePath: string;
  sessionId: string | null;
  branch: string | null;
  head: string | null;
  registered: boolean;
  createdBy: string;
  createdAt: string;
}

export interface SessionWorktreeApi {
  list(): Promise<{ worktrees: SessionWorktreeRecord[] }>;
  create(input: { projectPath: string; name: string; sessionId?: string }): Promise<{
    worktree: SessionWorktreeRecord;
    includeCopied: string[];
    includeSkipped: string[];
  }>;
  remove(id: string): Promise<{ removed: string }>;
  prune(): Promise<{ pruned: string[] }>;
  bindSession(sessionId: string, worktreeId: string): Promise<{ session: SessionRecord }>;
  unbindSession(sessionId: string): Promise<{ session: SessionRecord }>;
}

export function createSessionWorktreeApi(base: string = DEFAULT_BASE): SessionWorktreeApi {
  const req = async (path: string, init?: RequestInit) => {
    const r = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error((body['message'] as string) || (body['error'] as string) || `HTTP ${r.status}`);
    return body;
  };
  return {
    async list() {
      return (await req('/session-worktrees')) as { worktrees: SessionWorktreeRecord[] };
    },
    async create(input) {
      return (await req('/session-worktrees', {
        method: 'POST',
        body: JSON.stringify(input),
      })) as {
        worktree: SessionWorktreeRecord;
        includeCopied: string[];
        includeSkipped: string[];
      };
    },
    async remove(id: string) {
      return (await req(`/session-worktrees/${id}`, { method: 'DELETE' })) as { removed: string };
    },
    async prune() {
      return (await req('/session-worktrees/prune', { method: 'POST' })) as { pruned: string[] };
    },
    async bindSession(sessionId: string, worktreeId: string) {
      return (await req(`/sessions/${sessionId}/worktree`, {
        method: 'POST',
        body: JSON.stringify({ worktreeId }),
      })) as { session: SessionRecord };
    },
    async unbindSession(sessionId: string) {
      return (await req(`/sessions/${sessionId}/worktree`, { method: 'DELETE' })) as {
        session: SessionRecord;
      };
    },
  };
}

async function req<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export function createSessionApi(base: string = DEFAULT_BASE): SessionApi {
  return {
    list: () => req(base, '/sessions'),
    create: (input) => req(base, '/sessions', { method: 'POST', body: JSON.stringify(input) }),
    archive: (id) =>
      req(base, `/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST', body: '{}' }),
    resume: (id) =>
      req(base, `/sessions/${encodeURIComponent(id)}/resume`, { method: 'POST', body: '{}' }),
    listCheckpoints: (id) => req(base, `/sessions/${encodeURIComponent(id)}/checkpoints`),
    createCheckpoint: (id, input) =>
      req(base, `/sessions/${encodeURIComponent(id)}/checkpoints`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    restoreCheckpoint: (id, checkpointId) =>
      req(base, `/sessions/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`, {
        method: 'POST',
        body: '{}',
      }),
  };
}

export function WorktreeSection({
  wtApi,
  selectedSessionId,
  onChanged,
}: {
  wtApi: SessionWorktreeApi;
  selectedSessionId: string | null;
  onChanged: () => void;
}) {
  const { t } = useLang();
  const [worktrees, setWorktrees] = useState<SessionWorktreeRecord[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [projectPath, setProjectPath] = useState('');
  const [name, setName] = useState('');
  const [bindToSession, setBindToSession] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setError('');
      const r = await wtApi.list();
      setWorktrees(r.worktrees);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [wtApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      setError('');
      await fn();
      await refresh();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>{t('worktree.title')}</h3>
      <p className="muted">{t('worktree.desc')}</p>
      {error && <div className="error">{error}</div>}

      <div className="row">
        <input
          value={projectPath}
          onChange={(e) => setProjectPath(e.target.value)}
          placeholder={t('worktree.projectPath')}
          disabled={busy}
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('worktree.name')}
          disabled={busy}
        />
        <label className="muted">
          <input
            type="checkbox"
            checked={bindToSession}
            onChange={(e) => setBindToSession(e.target.checked)}
            disabled={busy || !selectedSessionId}
          />{' '}
          {t('worktree.bindToSession')}
        </label>
        <button
          disabled={busy || !projectPath.trim() || !name.trim()}
          onClick={() =>
            void run(async () => {
              await wtApi.create({
                projectPath: projectPath.trim(),
                name: name.trim(),
                sessionId: bindToSession && selectedSessionId ? selectedSessionId : undefined,
              });
              setProjectPath('');
              setName('');
            })
          }
        >
          {t('worktree.create')}
        </button>
        <button
          disabled={busy}
          onClick={() => void run(async () => { await wtApi.prune(); })}
          title={t('worktree.pruneHint')}
        >
          {t('worktree.prune')}
        </button>
      </div>

      {worktrees === null ? (
        <p className="muted">{t('worktree.loading')}</p>
      ) : worktrees.length === 0 ? (
        <p className="muted">{t('worktree.none')}</p>
      ) : (
        <ul className="list">
          {worktrees.map((w) => (
            <li key={w.id} className="list-item">
              <span>
                <strong>{w.name}</strong>{' '}
                <span className="muted">
                  {w.branch ?? t('worktree.detached')} · {(w.head ?? '—').slice(0, 8)}
                </span>
                <br />
                <span className="muted">{w.worktreePath}</span>
                {!w.registered && <span className="tag">{t('worktree.stale')}</span>}
                {w.sessionId && <span className="tag">{t('worktree.bound')}</span>}
              </span>
              <span className="row">
                {selectedSessionId && (
                  <button
                    disabled={busy}
                    onClick={() => void run(async () => { await wtApi.bindSession(selectedSessionId, w.id); })}
                    title={t('worktree.bindHint')}
                  >
                    {t('worktree.bind')}
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(t('worktree.removeConfirm', { name: w.name }))) return;
                    void run(async () => { await wtApi.remove(w.id); });
                  }}
                >
                  {t('worktree.remove')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SessionPanel({ sessionApi }: { sessionApi: SessionApi }) {
  const { t } = useLang();
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<SessionCheckpointRecord[] | null>(null);
  const [resumeInfo, setResumeInfo] = useState<string>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [cpLabel, setCpLabel] = useState('');
  const [cpCodeRoot, setCpCodeRoot] = useState('');
  const [notice, setNotice] = useState('');
  const [wtApi] = useState(() => createSessionWorktreeApi());

  const refresh = useCallback(async () => {
    try {
      setError('');
      const r = await sessionApi.list();
      setSessions(r.sessions);
      if (!selectedId && r.sessions.length > 0) setSelectedId(r.sessions[0].id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionApi, selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshCheckpoints = useCallback(async () => {
    if (!selectedId) return;
    try {
      const r = await sessionApi.listCheckpoints(selectedId);
      setCheckpoints(r.checkpoints);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionApi, selectedId]);

  useEffect(() => {
    setCheckpoints(null);
    setResumeInfo('');
    void refreshCheckpoints();
  }, [selectedId, refreshCheckpoints]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      setError('');
      setNotice('');
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="panel">
      <h2>{t('session.title')}</h2>
      <p className="muted">{t('session.desc')}</p>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="row">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder={t('session.titleLabel')}
          disabled={busy}
        />
        <button
          disabled={busy || !newTitle.trim()}
          onClick={() => void run(async () => {
            const r = await sessionApi.create({ title: newTitle.trim() });
            setNewTitle('');
            setSelectedId(r.session.id);
            await refresh();
          })}
        >
          {t('session.create')}
        </button>
      </div>

      {sessions === null ? (
        <p className="muted">{t('session.loading')}</p>
      ) : sessions.length === 0 ? (
        <p className="muted">{t('session.noSessions')}</p>
      ) : (
        <div className="row">
          <label>{t('session.select')}</label>
          <select value={selectedId ?? ''} onChange={(e) => setSelectedId(e.target.value)} disabled={busy}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                [{s.status === 'active' ? t('session.active') : t('session.archived')}] {s.title}
              </option>
            ))}
          </select>
          {selected && selected.status === 'active' && (
            <button
              disabled={busy}
              onClick={() => void run(async () => {
                await sessionApi.archive(selected.id);
                await refresh();
              })}
            >
              {t('session.archive')}
            </button>
          )}
          <button
            disabled={busy || !selectedId}
            onClick={() => void run(async () => {
              if (!selectedId) return;
              const r = await sessionApi.resume(selectedId);
              const lines = [
                `${r.session.title} — ${r.tasks.length} tasks, ${r.runResumePoints.length} runs`,
                ...r.runResumePoints.map(
                  (p) => `${p.runId.slice(0, 8)} step=${p.stepPosition} → POST ${p.resumeEndpoint}`,
                ),
              ];
              setResumeInfo(lines.join('\n'));
            })}
            title={t('session.resumeHint')}
          >
            {t('session.resume')}
          </button>
        </div>
      )}

      {resumeInfo && <pre className="resume-box">{resumeInfo}</pre>}

      {selected && selected.worktreeId && (
        <div className="card">
          <div className="row">
            <span>
              <strong>{t('worktree.boundSession')}</strong>{' '}
              <span className="muted">{selected.worktreeId}</span>
            </span>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await wtApi.unbindSession(selected.id);
                  await refresh();
                })
              }
            >
              {t('worktree.unbind')}
            </button>
          </div>
          <p className="muted">{t('worktree.boundHint')}</p>
        </div>
      )}

      {selected && (
        <div className="card">
          <h3>
            {t('session.checkpoints')} ({checkpoints?.length ?? '…'})
          </h3>
          <div className="row">
            <input
              value={cpLabel}
              onChange={(e) => setCpLabel(e.target.value)}
              placeholder={t('session.checkpointLabel')}
              disabled={busy}
            />
            <input
              value={cpCodeRoot}
              onChange={(e) => setCpCodeRoot(e.target.value)}
              placeholder={t('session.codeRoot')}
              disabled={busy}
            />
            <button
              disabled={busy}
              onClick={() => void run(async () => {
                if (!selectedId) return;
                await sessionApi.createCheckpoint(selectedId, {
                  label: cpLabel.trim() || undefined,
                  codeRoot: cpCodeRoot.trim() || undefined,
                });
                setCpLabel('');
                await refreshCheckpoints();
                await refresh();
              })}
            >
              {t('session.createCheckpoint')}
            </button>
          </div>
          {checkpoints === null ? (
            <p className="muted">{t('session.loading')}</p>
          ) : checkpoints.length === 0 ? (
            <p className="muted">{t('session.noCheckpoints')}</p>
          ) : (
            <ul className="list">
              {checkpoints.map((c) => (
                <li key={c.id} className="list-item">
                  <span>
                    <strong>{c.label}</strong> <span className="muted">{c.createdAt}</span>
                    {c.gitDiff && <span className="tag">[code]</span>}
                  </span>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (!selectedId) return;
                      if (!window.confirm(t('session.restoreConfirm'))) return;
                      void run(async () => {
                        const r = await sessionApi.restoreCheckpoint(selectedId, c.id);
                        setNotice(
                          r.codeApplied
                            ? t('session.codeApplied')
                            : t('session.codeNotApplied', { reason: r.codeApplyReason || '—' }),
                        );
                        await refreshCheckpoints();
                        await refresh();
                      });
                    }}
                  >
                    {t('session.restore')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <WorktreeSection wtApi={wtApi} selectedSessionId={selectedId} onChanged={() => void refresh()} />
    </div>
  );
}

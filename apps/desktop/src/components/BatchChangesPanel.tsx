/**
 * BatchChangesPanel — declarative multi-repo Batch Changes dashboard
 * (Sourcegraph Batch Changes style, zero-model).
 * Wired to apps/server/src/routes/batch-changes.ts via BatchChangesApi.
 */
import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '../api';
import { useLang } from '../i18n';
import { EmptyState } from './EmptyState';

// ------------------------------------------------------------- API ----

export interface BatchRepoReg {
  name: string;
  path: string;
  remoteUrl?: string;
  scope: string;
  addedBy: string;
  addedAt: string;
}

export interface BatchSummary {
  id: string;
  name: string;
  status: string;
  repoCount: number;
  counts: Record<string, number>;
  branch: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface BatchStepResult {
  name: string;
  kind: 'run' | 'edit';
  ok: boolean;
  exitCode?: number;
  ms: number;
  output?: string;
  error?: string;
}

export interface BatchRepoRun {
  name: string;
  path: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  branch?: string;
  head?: string;
  stepResults: BatchStepResult[];
  push: string;
  pr: string;
  error?: string;
}

export interface BatchDetail {
  id: string;
  name: string;
  status: string;
  spec: {
    name: string;
    repos: string[];
    branch: string;
    onFailure: string;
    branchExists: string;
    push: string;
    pr: boolean;
    steps: Array<{ name: string; kind: string }>;
  };
  repos: BatchRepoRun[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface BatchChangesApi {
  repos(): Promise<{ repos: BatchRepoReg[] }>;
  registerRepo(input: { name: string; path: string; remoteUrl?: string }): Promise<{ repo: BatchRepoReg }>;
  unregisterRepo(name: string): Promise<{ removed: boolean }>;
  validateSpec(specYaml: string): Promise<{ ok: boolean; spec: unknown; missingRepos: string[] }>;
  batches(): Promise<{ batches: BatchSummary[] }>;
  createBatch(specYaml: string): Promise<{ batch: BatchSummary }>;
  batchDetail(id: string): Promise<{ batch: BatchDetail }>;
  runBatch(id: string): Promise<{ batch: BatchSummary }>;
  retryRepo(id: string, repo: string): Promise<{ batch: BatchSummary }>;
  deleteBatch(id: string): Promise<{ removed: boolean }>;
}

export function createBatchChangesApi(base: string): BatchChangesApi {
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
    repos: () => req<{ repos: BatchRepoReg[] }>('/batch-changes/repos'),
    registerRepo: (input) =>
      req<{ repo: BatchRepoReg }>('/batch-changes/repos', { method: 'POST', body: JSON.stringify(input) }),
    unregisterRepo: (name) =>
      req<{ removed: boolean }>(`/batch-changes/repos/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    validateSpec: (specYaml) =>
      req<{ ok: boolean; spec: unknown; missingRepos: string[] }>('/batch-changes/validate', {
        method: 'POST',
        body: JSON.stringify({ specYaml }),
      }),
    batches: () => req<{ batches: BatchSummary[] }>('/batch-changes'),
    createBatch: (specYaml) =>
      req<{ batch: BatchSummary }>('/batch-changes', { method: 'POST', body: JSON.stringify({ specYaml }) }),
    batchDetail: (id) => req<{ batch: BatchDetail }>(`/batch-changes/${encodeURIComponent(id)}`),
    runBatch: (id) =>
      req<{ batch: BatchSummary }>(`/batch-changes/${encodeURIComponent(id)}/run`, { method: 'POST' }),
    retryRepo: (id, repo) =>
      req<{ batch: BatchSummary }>(`/batch-changes/${encodeURIComponent(id)}/retry/${encodeURIComponent(repo)}`, {
        method: 'POST',
      }),
    deleteBatch: (id) =>
      req<{ removed: boolean }>(`/batch-changes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}

// ------------------------------------------------------------ panel ----

const SAMPLE_SPEC = `name: 升级 lodash
branch: batch/lodash-4-17-21
onFailure: continue
branchExists: fail
push: skip
pr: false
repos:
  - repo-a
  - repo-b
steps:
  - name: bump lodash
    edit:
      file: package.json
      search: '"lodash": "4.17.20"'
      replace: '"lodash": "4.17.21"'
  - name: run tests
    run: npm test
    timeoutMs: 120000
`;

const STATUS_COLORS: Record<string, string> = {
  pending: 'var(--muted, #8b949e)',
  running: '#d29922',
  success: '#3fb950',
  failed: '#f85149',
  skipped: 'var(--muted, #8b949e)',
};

export function BatchChangesPanel({ api }: { api: BatchChangesApi }) {
  const { t } = useLang();
  const [repos, setRepos] = useState<BatchRepoReg[]>([]);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);

  const [regName, setRegName] = useState('');
  const [regPath, setRegPath] = useState('');
  const [regRemote, setRegRemote] = useState('');

  const [specYaml, setSpecYaml] = useState(SAMPLE_SPEC);
  const [validation, setValidation] = useState<{ ok: boolean; missingRepos: string[]; steps?: number } | null>(null);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const [r, b] = await Promise.all([api.repos(), api.batches()]);
      setRepos(r.repos);
      setBatches(b.batches);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('batch.loadFailed'));
    }
  }, [api, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      await refresh();
      if (detail) {
        try {
          const d = await api.batchDetail(detail.id);
          setDetail(d.batch);
        } catch {
          setDetail(null);
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('batch.opFailed'));
    } finally {
      setBusy(false);
    }
  };

  const onRunBatch = async (id: string) => {
    setRunningId(id);
    try {
      await run(() => api.runBatch(id).then(() => undefined));
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div style={{ padding: 12, overflowY: 'auto', height: '100%' }}>
      {batches.length === 0 && <EmptyState panel="batch" />}
      <h3 style={{ margin: '0 0 8px' }}>{t('batch.title')}</h3>
      {err && <div className="banner err">{err}</div>}
      <div className="muted" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.6 }}>
        {t('batch.honestNote')}
      </div>

      {/* ---------------- repos ---------------- */}
      <h4 style={{ margin: '0 0 6px' }}>{t('batch.repos')}</h4>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {t('batch.reposHint')}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder={t('batch.repoNamePh')}
          value={regName}
          onChange={(e) => setRegName(e.target.value)}
          style={{ padding: 6, borderRadius: 4, width: 140 }}
        />
        <input
          type="text"
          placeholder={t('batch.repoPathPh')}
          value={regPath}
          onChange={(e) => setRegPath(e.target.value)}
          style={{ flex: 1, padding: 6, borderRadius: 4, minWidth: 200 }}
        />
        <input
          type="text"
          placeholder={t('batch.remoteUrlPh')}
          value={regRemote}
          onChange={(e) => setRegRemote(e.target.value)}
          style={{ flex: 1, padding: 6, borderRadius: 4, minWidth: 160 }}
        />
        <button
          className="primary"
          disabled={busy || !regName.trim() || !regPath.trim()}
          onClick={() =>
            void run(() =>
              api
                .registerRepo({
                  name: regName.trim(),
                  path: regPath.trim(),
                  ...(regRemote.trim() ? { remoteUrl: regRemote.trim() } : {}),
                })
                .then(() => {
                  setRegName('');
                  setRegPath('');
                  setRegRemote('');
                }),
            )
          }
        >
          {t('batch.register')}
        </button>
      </div>
      {repos.length === 0 && <div className="muted">{t('batch.noRepos')}</div>}
      {repos.map((r) => (
        <div
          key={r.name}
          style={{
            border: '1px solid var(--border, #2d333b)',
            borderRadius: 6,
            padding: 8,
            marginBottom: 6,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 13 }}>
            <strong>{r.name}</strong>{' '}
            <span className="muted" style={{ fontSize: 12 }}>
              {r.path}
            </span>
            <div className="muted" style={{ fontSize: 11 }}>
              {r.scope} · {r.remoteUrl ? t('batch.hasRemote') : t('batch.noRemote')}
            </div>
          </div>
          <button disabled={busy} onClick={() => void run(() => api.unregisterRepo(r.name).then(() => undefined))}>
            {t('batch.unregister')}
          </button>
        </div>
      ))}

      {/* ---------------- new batch ---------------- */}
      <h4 style={{ margin: '16px 0 6px' }}>{t('batch.newBatch')}</h4>
      <textarea
        value={specYaml}
        onChange={(e) => setSpecYaml(e.target.value)}
        rows={16}
        spellCheck={false}
        style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: 8, borderRadius: 4, boxSizing: 'border-box' }}
      />
      <div className="btn-row" style={{ margin: '8px 0' }}>
        <button
          disabled={busy || !specYaml.trim()}
          onClick={() =>
            void run(async () => {
              const v = await api.validateSpec(specYaml);
              setValidation({ ok: v.ok, missingRepos: v.missingRepos });
            })
          }
        >
          {t('batch.validate')}
        </button>
        <button
          className="primary"
          disabled={busy || !specYaml.trim()}
          onClick={() =>
            void run(() =>
              api.createBatch(specYaml).then((r) => {
                setSpecYaml(SAMPLE_SPEC);
                setValidation(null);
                return api.batchDetail(r.batch.id).then((d) => setDetail(d.batch));
              }),
            )
          }
        >
          {t('batch.create')}
        </button>
      </div>
      {validation && (
        <div className={validation.ok ? 'banner ok' : 'banner err'} style={{ marginBottom: 8 }}>
          {validation.ok
            ? t('batch.validated')
            : `${t('batch.invalid')}: ${validation.missingRepos.map((m) => `${t('batch.missingRepo')}: ${m}`).join('; ')}`}
        </div>
      )}

      {/* ---------------- batches ---------------- */}
      <h4 style={{ margin: '16px 0 6px' }}>{t('batch.batches')}</h4>
      {batches.length === 0 && <div className="muted">{t('batch.noBatches')}</div>}
      {batches.map((b) => (
        <div
          key={b.id}
          style={{
            border: '1px solid var(--border, #2d333b)',
            borderRadius: 6,
            padding: 10,
            marginBottom: 8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div>
              <strong style={{ fontSize: 14 }}>{b.name}</strong>{' '}
              <span className="muted" style={{ fontSize: 12 }}>
                {t('batch.branch')}: {b.branch} · {b.repoCount} repos
              </span>
              <div style={{ fontSize: 12, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(b.counts).map(([s, n]) => (
                  <span key={s} style={{ color: STATUS_COLORS[s] ?? undefined }}>
                    {t(`batch.status.${s}` as const)}: {n}
                  </span>
                ))}
              </div>
            </div>
            <div className="btn-row">
              <button
                disabled={busy || runningId === b.id || b.status === 'running'}
                onClick={() =>
                  void api
                    .batchDetail(b.id)
                    .then((d) => setDetail(detail?.id === b.id ? null : d.batch))
                    .catch((e) => setErr(e instanceof Error ? e.message : t('batch.opFailed')))
                }
              >
                {detail?.id === b.id ? t('batch.hideDetail') : t('batch.showDetail')}
              </button>
              <button className="primary" disabled={busy || runningId === b.id} onClick={() => void onRunBatch(b.id)}>
                {runningId === b.id ? t('batch.running') : t('batch.run')}
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('batch.confirmDelete'))) {
                    void run(() =>
                      api.deleteBatch(b.id).then(() => {
                        if (detail?.id === b.id) setDetail(null);
                      }),
                    );
                  }
                }}
              >
                {t('batch.delete')}
              </button>
            </div>
          </div>

          {detail?.id === b.id && (
            <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #2d333b)', paddingTop: 8 }}>
              {detail.repos.map((r) => (
                <div key={r.name} style={{ marginBottom: 8, fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div>
                      <strong>{r.name}</strong>{' '}
                      <span style={{ color: STATUS_COLORS[r.status], fontWeight: 600 }}>{t(`batch.status.${r.status}` as const)}</span>
                      {r.head && <span className="muted"> · {r.head.slice(0, 7)}</span>}
                      {r.error && <div style={{ color: '#f85149' }}>{r.error}</div>}
                      <div className="muted">
                        {t('batch.push')}: {t(`batch.pushResult.${r.push}` as const)} · {t('batch.pr')}:{' '}
                        {t(`batch.prResult.${r.pr}` as const)}
                      </div>
                    </div>
                    {r.status === 'failed' && (
                      <button
                        disabled={busy}
                        onClick={() => void run(() => api.retryRepo(b.id, r.name).then(() => undefined))}
                      >
                        {t('batch.retry')}
                      </button>
                    )}
                  </div>
                  {r.stepResults.length > 0 && (
                    <div style={{ marginTop: 4, paddingLeft: 8 }}>
                      {r.stepResults.map((s, i) => (
                        <div key={i} style={{ marginBottom: 2 }}>
                          <span style={{ color: s.ok ? '#3fb950' : '#f85149' }}>{s.ok ? '✓' : '✗'}</span>{' '}
                          {s.name} <span className="muted">({s.kind}, {s.ms}ms{s.exitCode !== undefined ? `, exit ${s.exitCode}` : ''})</span>
                          {s.output && (
                            <pre
                              style={{
                                margin: '4px 0',
                                padding: 6,
                                background: 'var(--bg2, #161b22)',
                                borderRadius: 4,
                                fontSize: 11,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                                maxHeight: 120,
                                overflowY: 'auto',
                              }}
                            >
                              {s.output.slice(0, 2000)}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

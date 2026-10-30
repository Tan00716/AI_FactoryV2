/**
 * GitPanel — spec §34 desktop surface for the git engine.
 * Wired to the server routes in apps/server/src/routes/git.ts via GitApi.
 * The coordinator drops this into App.tsx; it is not mounted yet.
 */
import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from '../api';
import { useLang } from '../i18n';
import { EmptyState } from './EmptyState';

// ------------------------------------------------------------- API ----

/** Mirrors the server routes in apps/server/src/routes/git.ts. */
export interface GitStatus {
  branch: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface GitBranches {
  current: string;
  all: string[];
}

export interface GitLogEntry {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface GitPr {
  id: string;
  taskId: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  status: 'OPEN' | 'MERGED' | 'CLOSED';
  commits: string[];
  createdBy: string;
  createdAt: string;
  mergedAt: string | null;
}

// ------------------------------------------------- W-F PR review ----

export interface PrDiffLine {
  type: 'context' | 'add' | 'del';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface PrDiffHunk {
  header: string;
  lines: PrDiffLine[];
}

export interface PrDiffFile {
  from: string;
  to: string;
  change: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  hunks: PrDiffHunk[];
}

export interface PrComment {
  id: string;
  prId: string;
  file: string | null;
  line: number | null;
  side: 'new' | 'old';
  body: string;
  author: string;
  createdAt: string;
}

export interface PrReview {
  id: string;
  prId: string;
  decision: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  summary: string;
  reviewer: string;
  createdAt: string;
}

export interface PrDetail {
  pr: GitPr;
  comments: PrComment[];
  reviews: PrReview[];
  reviewState: { decision: PrReview['decision']; reviewer: string; at: string }[];
}

export interface PrDiff {
  prId: string;
  sourceBranch: string;
  targetBranch: string;
  truncated: boolean;
  files: PrDiffFile[];
}

// ----------------------------------------- second-round ⑥ impact ----

export interface ImpactEdge {
  changedFile: string;
  fromFile: string;
  symbol: string;
  line: number | null;
  hop: number;
}

export interface ImpactLayer {
  hop: number;
  files: string[];
}

export interface ContractChange {
  name: string;
  kind: string;
  change: 'removed' | 'added' | 'signature-changed' | 'kind-changed';
  breaking: boolean;
  before: string | null;
  after: string | null;
  reason: string;
}

export interface FileContractReport {
  file: string;
  supported: boolean;
  baselineMissing: boolean;
  beforeCount: number;
  afterCount: number;
  changes: ContractChange[];
  note?: string;
}

export interface ImpactReport {
  root: string;
  source: 'files' | 'pr' | 'working-tree';
  changedFiles: string[];
  affectedFiles: string[];
  layers: ImpactLayer[];
  edges: ImpactEdge[];
  contracts: FileContractReport[];
  breakingCount: number;
  nonBreakingCount: number;
  truncated: boolean;
  notes: string[];
}

/** Typed client for the /api/git routes. */
export interface GitApi {
  status(repo: string): Promise<GitStatus>;
  branches(repo: string): Promise<GitBranches>;
  log(repo: string, limit?: number): Promise<GitLogEntry[]>;
  diff(repo: string, ref?: string): Promise<{ diff: string }>;
  createBranch(repo: string, name: string): Promise<{ ok: boolean; branch: string }>;
  checkout(repo: string, ref: string): Promise<{ ok: boolean; ref: string }>;
  commit(
    repo: string,
    message: string,
    opts?: { actor?: string; taskId?: string },
  ): Promise<{ ok: boolean; sha: string }>;
  taskBranch(
    repo: string,
    taskId: string,
    title: string,
  ): Promise<{ ok: boolean; branch: string; taskId: string }>;
  createPr(input: {
    repo: string;
    taskId: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    actor?: string;
  }): Promise<GitPr>;
  mergePr(
    repo: string,
    prId: string,
    actor?: string,
  ): Promise<{ ok: boolean; pr: GitPr }>;
  push(repo: string, branch?: string, actor?: string): Promise<{ ok: boolean; branch: string }>;
  // W-F PR review
  listPrs(status?: string): Promise<{ prs: GitPr[] }>;
  getPr(prId: string): Promise<PrDetail>;
  prDiff(prId: string, repo: string): Promise<PrDiff>;
  addComment(
    prId: string,
    input: { file?: string | null; line?: number | null; side?: 'new' | 'old'; body: string },
  ): Promise<PrComment>;
  submitReview(
    prId: string,
    input: { decision: PrReview['decision']; summary?: string },
  ): Promise<PrReview>;
  // Second-round ⑥ — change impact analysis
  analyzeImpact(prId: string, repo: string): Promise<{ report: ImpactReport }>;
}

/** Local copy of the `req` helper pattern from apps/desktop/src/api.ts. */
export function createGitApi(base: string): GitApi {
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
  const q = (repo: string, extra = '') =>
    `/git/status?repo=${encodeURIComponent(repo)}${extra}`;
  return {
    status: (repo) => req<GitStatus>(q(repo)),
    branches: (repo) =>
      req<GitBranches>(`/git/branches?repo=${encodeURIComponent(repo)}`),
    log: (repo, limit = 20) =>
      req<GitLogEntry[]>(
        `/git/log?repo=${encodeURIComponent(repo)}&limit=${limit}`,
      ),
    diff: (repo, ref) =>
      req<{ diff: string }>(
        `/git/diff?repo=${encodeURIComponent(repo)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`,
      ),
    createBranch: (repo, name) =>
      req<{ ok: boolean; branch: string }>('/git/branch', {
        method: 'POST',
        body: JSON.stringify({ repo, name }),
      }),
    checkout: (repo, ref) =>
      req<{ ok: boolean; ref: string }>('/git/checkout', {
        method: 'POST',
        body: JSON.stringify({ repo, ref }),
      }),
    commit: (repo, message, opts) =>
      req<{ ok: boolean; sha: string }>('/git/commit', {
        method: 'POST',
        body: JSON.stringify({ repo, message, ...opts }),
      }),
    taskBranch: (repo, taskId, title) =>
      req<{ ok: boolean; branch: string; taskId: string }>('/git/task-branch', {
        method: 'POST',
        body: JSON.stringify({ repo, taskId, title }),
      }),
    createPr: (input) => req<GitPr>('/git/pr', { method: 'POST', body: JSON.stringify(input) }),
    mergePr: (repo, prId, actor) =>
      req<{ ok: boolean; pr: GitPr }>(`/git/pr/${encodeURIComponent(prId)}/merge`, {
        method: 'POST',
        body: JSON.stringify({ repo, actor }),
      }),
    push: (repo, branch, actor) =>
      req<{ ok: boolean; branch: string }>('/git/push', {
        method: 'POST',
        body: JSON.stringify({ repo, branch, actor }),
      }),
    listPrs: (status) =>
      req<{ prs: GitPr[] }>(`/git/prs${status ? `?status=${encodeURIComponent(status)}` : ''}`),
    getPr: (prId) => req<PrDetail>(`/git/pr/${encodeURIComponent(prId)}`),
    prDiff: (prId, repo) =>
      req<PrDiff>(`/git/pr/${encodeURIComponent(prId)}/diff?repo=${encodeURIComponent(repo)}`),
    addComment: (prId, input) =>
      req<PrComment>(`/git/pr/${encodeURIComponent(prId)}/comments`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    submitReview: (prId, input) =>
      req<PrReview>(`/git/pr/${encodeURIComponent(prId)}/review`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    analyzeImpact: (prId, repo) =>
      req<{ report: ImpactReport }>('/impact/analyze', {
        method: 'POST',
        body: JSON.stringify({ prId, repo }),
      }),
  };
}

// ------------------------------------------------------------ panel ----

function FileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        {title} <span className="pill">{files.length}</span>
      </div>
      {files.map((f) => (
        <div key={f} style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {f}
        </div>
      ))}
    </div>
  );
}

export function GitPanel({ api }: { api: GitApi }) {
  const { t } = useLang();
  const [repo, setRepo] = useState('');
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [diff, setDiff] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [message, setMessage] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!repo) return;
    setErr(null);
    setBusy(true);
    try {
      const [s, b, l, d] = await Promise.all([
        api.status(repo),
        api.branches(repo),
        api.log(repo, 20),
        api.diff(repo),
      ]);
      setStatus(s);
      setBranches(b);
      setLog(l);
      setDiff(d.diff);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('git.loadFailed'));
    } finally {
      setBusy(false);
    }
  }, [api, repo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('git.opFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 12, overflowY: 'auto', height: '100%' }}>
      {log.length === 0 && <EmptyState panel="git" />}
      <h3 style={{ margin: '0 0 8px' }}>
        {t('git.title')} <span className="muted">§34</span>
      </h3>

      {err && <div className="banner err">{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          type="text"
          placeholder={t('git.repoPlaceholder')}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          style={{ flex: 1, padding: 6, borderRadius: 4 }}
        />
        <button onClick={() => void refresh()} disabled={busy || !repo}>
          {t('git.refresh')}
        </button>
      </div>

      {!status && !err && (
        <div className="muted" style={{ marginBottom: 8 }}>{t('git.hint')}</div>
      )}
      {status && (
        <div style={{ marginBottom: 8 }}>
          {t('git.branchLabel')} <span className="pill">{status.branch}</span>
        </div>
      )}

      {status && (
        <div style={{ display: 'flex', gap: 16 }}>
          <FileList title={t('git.staged')} files={status.staged} />
          <FileList title={t('git.unstaged')} files={status.unstaged} />
          <FileList title={t('git.untracked')} files={status.untracked} />
        </div>
      )}

      <h4 style={{ margin: '12px 0 4px' }}>{t('git.branches')}</h4>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          type="text"
          placeholder={t('git.branchPlaceholder')}
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
          style={{ flex: 1, padding: 6, borderRadius: 4 }}
        />
        <button
          disabled={busy || !repo || !newBranch}
          onClick={() => void run(() => api.createBranch(repo, newBranch).then(() => setNewBranch('')))}
        >
          {t('git.createBranch')}
        </button>
      </div>
      {branches?.all.map((b) => (
        <div key={b} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontFamily: 'monospace', fontSize: 12, flex: 1 }}>{b}</span>
          {b === branches.current ? (
            <span className="pill">{t('git.current')}</span>
          ) : (
            <button disabled={busy || !repo} onClick={() => void run(() => api.checkout(repo, b).then(() => undefined))}>
              {t('git.checkout')}
            </button>
          )}
        </div>
      ))}

      <h4 style={{ margin: '12px 0 4px' }}>{t('git.commitHeading')}</h4>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          placeholder={t('git.commitPlaceholder')}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          style={{ flex: 1, padding: 6, borderRadius: 4 }}
        />
        <button
          className="primary"
          disabled={busy || !repo || !message.trim()}
          onClick={() => void run(() => api.commit(repo, message).then(() => setMessage('')))}
        >
          {t('git.commitBtn')}
        </button>
      </div>

      <h4 style={{ margin: '12px 0 4px' }}>{t('git.log')}</h4>
      {log.map((e) => (
        <div key={e.sha} style={{ marginBottom: 6, fontSize: 12 }}>
          <span style={{ fontFamily: 'monospace' }}>{e.sha.slice(0, 8)}</span>{' '}
          <span>{e.message}</span>
          <div className="muted">
            {e.author} · {new Date(e.date).toLocaleString()}
          </div>
        </div>
      ))}

      <h4 style={{ margin: '12px 0 4px' }}>{t('git.diff')}</h4>
      <pre className="code-sample" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflowY: 'auto' }}>
        {diff || <span className="muted">{t('git.noChanges')}</span>}
      </pre>

      <PrReviewSection api={api} repo={repo} />
    </div>
  );
}

// ------------------------------------------------- W-F PR review UI ----

function PrReviewSection({ api, repo }: { api: GitApi; repo: string }) {
  const { t } = useLang();
  const [prs, setPrs] = useState<GitPr[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [diff, setDiff] = useState<PrDiff | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [cFile, setCFile] = useState('');
  const [cLine, setCLine] = useState('');
  const [cBody, setCBody] = useState('');
  const [summary, setSummary] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const [impactErr, setImpactErr] = useState<string | null>(null);
  const [impactBusy, setImpactBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.listPrs();
      setPrs(r.prs);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('git.opFailed'));
    }
  }, [api, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string) => {
    setErr(null);
    setBusy(true);
    setSel(id);
    try {
      const [d, df] = await Promise.all([
        api.getPr(id),
        repo ? api.prDiff(id, repo).catch(() => null) : Promise.resolve(null),
      ]);
      setDetail(d);
      setDiff(df);
      setOpenFile(null);
      setCFile('');
      setCLine('');
      setImpact(null);
      setImpactErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('git.opFailed'));
    } finally {
      setBusy(false);
    }
  };

  const refreshDetail = async (id: string) => {
    const d = await api.getPr(id);
    setDetail(d);
  };

  const postComment = async () => {
    if (!sel || !cBody.trim()) return;
    setErr(null);
    setBusy(true);
    try {
      await api.addComment(sel, {
        file: cFile || null,
        line: cLine ? Number(cLine) : null,
        body: cBody,
      });
      setCBody('');
      await refreshDetail(sel);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('git.opFailed'));
    } finally {
      setBusy(false);
    }
  };

  const postReview = async (decision: PrReview['decision']) => {
    if (!sel) return;
    setErr(null);
    setBusy(true);
    try {
      await api.submitReview(sel, { decision, summary });
      setSummary('');
      await refreshDetail(sel);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('git.opFailed'));
    } finally {
      setBusy(false);
    }
  };

  /** Click a diff line to target the comment form at file/line. */
  const targetLine = (file: string, l: PrDiffLine) => {
    setCFile(file);
    setCLine(l.type === 'del' ? String(l.oldNo ?? '') : String(l.newNo ?? ''));
  };

  /** Second-round ⑥ — run the change impact analysis for this PR. */
  const runImpact = async () => {
    if (!sel || !repo) return;
    setImpactErr(null);
    setImpactBusy(true);
    try {
      const r = await api.analyzeImpact(sel, repo);
      setImpact(r.report);
    } catch (e) {
      setImpactErr(e instanceof Error ? e.message : t('git.review.impactFailed'));
    } finally {
      setImpactBusy(false);
    }
  };

  return (
    <div>
      <h4 style={{ margin: '12px 0 4px' }}>{t('git.review.title')}</h4>
      {err && <div className="banner err">{err}</div>}
      {prs.length === 0 && <div className="muted">{t('git.review.noPrs')}</div>}
      {prs.map((p) => (
        <div
          key={p.id}
          onClick={() => void open(p.id)}
          style={{
            cursor: 'pointer',
            padding: '6px 8px',
            marginBottom: 4,
            borderRadius: 4,
            background: sel === p.id ? 'var(--bg-hover, #1c2128)' : 'transparent',
            border: '1px solid var(--border, #2d333b)',
          }}
        >
          <span className="pill">{p.status}</span>{' '}
          <strong style={{ fontSize: 13 }}>{p.title}</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            {p.sourceBranch} → {p.targetBranch} · {p.createdBy}
          </div>
        </div>
      ))}

      {detail && (
        <div style={{ marginTop: 8, borderTop: '1px solid var(--border, #2d333b)', paddingTop: 8 }}>
          <h5 style={{ margin: '4px 0' }}>{detail.pr.title}</h5>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {detail.reviewState.map((s) => (
              <span key={s.reviewer + s.at} className="pill">
                {s.decision === 'APPROVE' ? t('git.review.approvedBy') : s.decision === 'REQUEST_CHANGES' ? t('git.review.changesRequestedBy') : '💬'}{' '}
                {s.reviewer}
              </span>
            ))}
            {detail.reviewState.length === 0 && (
              <span className="muted" style={{ fontSize: 12 }}>{t('git.review.noReviews')}</span>
            )}
          </div>

          {diff ? (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                {diff.files.length} {t('git.review.files')}
                {diff.truncated && <span> · {t('git.review.truncated')}</span>}
              </div>
              {diff.files.map((f) => (
                <div key={f.from + f.to} style={{ marginBottom: 6 }}>
                  <div
                    onClick={() => setOpenFile(openFile === f.to ? null : f.to)}
                    style={{ cursor: 'pointer', fontFamily: 'monospace', fontSize: 12 }}
                  >
                    {openFile === f.to ? '▾' : '▸'} {f.to}
                    <span className="pill" style={{ marginLeft: 6 }}>{f.change}</span>
                    {f.binary && <span className="muted"> (binary)</span>}
                  </div>
                  {openFile === f.to && !f.binary && (
                    <pre
                      className="code-sample"
                      style={{ fontSize: 11, maxHeight: 300, overflowY: 'auto', margin: '4px 0' }}
                    >
                      {f.hunks.map((h, hi) => (
                        <div key={hi}>
                          <div className="muted">{h.header}</div>
                          {h.lines.map((l, li) => (
                            <div
                              key={li}
                              onClick={() => targetLine(f.to, l)}
                              title={t('git.review.clickToComment')}
                              style={{
                                cursor: 'pointer',
                                background:
                                  l.type === 'add'
                                    ? 'rgba(46,160,67,0.15)'
                                    : l.type === 'del'
                                      ? 'rgba(248,81,73,0.15)'
                                      : 'transparent',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                              }}
                            >
                              <span className="muted" style={{ userSelect: 'none' }}>
                                {String(l.oldNo ?? '').padStart(4)} {String(l.newNo ?? '').padStart(4)}{' '}
                              </span>
                              {l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}
                              {l.text}
                            </div>
                          ))}
                        </div>
                      ))}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>{t('git.review.needRepo')}</div>
          )}

          {/* 第二轮⑥ 变更影响分析（启发式建议，不是证明） */}
          <h5 style={{ margin: '10px 0 4px' }}>{t('git.review.impactTitle')}</h5>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            {t('git.review.impactNote')}
          </div>
          <button
            disabled={impactBusy || !repo}
            onClick={() => void runImpact()}
            style={{ marginBottom: 6 }}
          >
            {impactBusy ? t('git.review.impactRunning') : t('git.review.impactRun')}
          </button>
          {impactErr && <div className="banner err">{impactErr}</div>}
          {impact && (
            <div className="impact-report" style={{ fontSize: 12 }}>
              <div style={{ marginBottom: 4 }}>
                <span className="pill">{t('git.review.impactChanged')} {impact.changedFiles.length}</span>{' '}
                <span className="pill">{t('git.review.impactAffected')} {impact.affectedFiles.length}</span>{' '}
                {impact.breakingCount > 0 ? (
                  <span className="pill" style={{ background: 'rgba(248,81,73,0.25)', color: '#f85149' }}>
                    ⚠ {t('git.review.impactBreaking')} {impact.breakingCount}
                  </span>
                ) : (
                  <span className="pill">{t('git.review.impactBreaking')} 0</span>
                )}{' '}
                <span className="pill">{t('git.review.impactNonBreaking')} {impact.nonBreakingCount}</span>
                {impact.truncated && <span className="muted"> · {t('git.review.impactTruncated')}</span>}
              </div>
              {impact.layers.map((layer) => (
                <div key={layer.hop} style={{ marginBottom: 2 }}>
                  <span className="muted">{t('git.review.impactHop', { hop: layer.hop })}</span>{' '}
                  {layer.files.map((f) => {
                    const edge = impact.edges.find((e) => e.fromFile === f && e.hop === layer.hop);
                    return (
                      <div key={f} style={{ fontFamily: 'monospace', fontSize: 11, paddingLeft: 12 }}>
                        {f}
                        {edge && (
                          <span className="muted" style={{ fontFamily: 'inherit' }}>
                            {' '}← {edge.changedFile} · {edge.symbol}
                            {edge.line !== null ? `:${edge.line}` : ''}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
              {impact.affectedFiles.length === 0 && (
                <div className="muted">{t('git.review.impactNone')}</div>
              )}
              {impact.contracts.map((fc) => (
                <div key={fc.file} style={{ marginTop: 6 }}>
                  <div style={{ fontFamily: 'monospace', fontSize: 11 }}>
                    {fc.file}
                    {!fc.supported && <span className="muted"> — {t('git.review.impactUnsupported')}</span>}
                    {fc.baselineMissing && <span className="muted"> — {t('git.review.impactNoBaseline')}</span>}
                  </div>
                  {fc.changes.map((ch, ci) => (
                    <div
                      key={ci}
                      style={{
                        paddingLeft: 12,
                        fontSize: 11,
                        color: ch.breaking ? '#f85149' : 'var(--text-muted, #8b949e)',
                      }}
                    >
                      {ch.breaking ? '✗' : '＋'} {ch.name} ({ch.kind}) — {ch.change}
                      <span style={{ color: 'var(--text-muted, #8b949e)' }}>: {ch.reason}</span>
                      {(ch.before || ch.after) && (
                        <div style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                          {ch.before && <div>- {ch.before}</div>}
                          {ch.after && <div>+ {ch.after}</div>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          <h5 style={{ margin: '8px 0 4px' }}>{t('git.review.comments')} ({detail.comments.length})</h5>
          {detail.comments.map((c) => (
            <div key={c.id} style={{ fontSize: 12, marginBottom: 6, paddingLeft: 8, borderLeft: '2px solid var(--border, #2d333b)' }}>
              <div className="muted">
                {c.author} · {c.file ?? t('git.review.prLevel')}
                {c.line ? `:${c.line}` : ''} · {new Date(c.createdAt).toLocaleString()}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
            </div>
          ))}

          <div style={{ display: 'flex', gap: 6, marginTop: 8, marginBottom: 6 }}>
            <input
              type="text"
              placeholder={t('git.review.fileLabel')}
              value={cFile}
              onChange={(e) => setCFile(e.target.value)}
              style={{ width: 180, padding: 6, borderRadius: 4 }}
            />
            <input
              type="text"
              placeholder={t('git.review.lineLabel')}
              value={cLine}
              onChange={(e) => setCLine(e.target.value.replace(/[^0-9]/g, ''))}
              style={{ width: 80, padding: 6, borderRadius: 4 }}
            />
            {(cFile || cLine) && (
              <button onClick={() => { setCFile(''); setCLine(''); }}>
                {t('git.review.clearTarget')}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              placeholder={t('git.review.commentPlaceholder')}
              value={cBody}
              onChange={(e) => setCBody(e.target.value)}
              style={{ flex: 1, padding: 6, borderRadius: 4 }}
            />
            <button disabled={busy || !cBody.trim()} onClick={() => void postComment()}>
              {t('git.review.submitComment')}
            </button>
          </div>

          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input
              type="text"
              placeholder={t('git.review.summaryPlaceholder')}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              style={{ flex: 1, padding: 6, borderRadius: 4 }}
            />
            <button className="primary" disabled={busy} onClick={() => void postReview('APPROVE')}>
              {t('git.review.approve')}
            </button>
            <button disabled={busy} onClick={() => void postReview('REQUEST_CHANGES')}>
              {t('git.review.requestChanges')}
            </button>
            <button disabled={busy} onClick={() => void postReview('COMMENT')}>
              {t('git.review.commentOnly')}
            </button>
          </div>

          {detail.reviews.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="muted" style={{ fontSize: 12 }}>{t('git.review.reviews')}</div>
              {detail.reviews.map((r) => (
                <div key={r.id} style={{ fontSize: 12 }}>
                  <span className="pill">{r.decision}</span> {r.reviewer}
                  {r.summary && <span> — {r.summary}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

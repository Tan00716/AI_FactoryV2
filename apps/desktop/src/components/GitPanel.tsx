/**
 * GitPanel — spec §34 desktop surface for the git engine.
 * Wired to the server routes in apps/server/src/routes/git.ts via GitApi.
 * The coordinator drops this into App.tsx; it is not mounted yet.
 */
import { useCallback, useEffect, useState } from 'react';

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
}

/** Local copy of the `req` helper pattern from apps/desktop/src/api.ts. */
export function createGitApi(base: string): GitApi {
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
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
      setErr(e instanceof Error ? e.message : 'failed to load git state');
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
      setErr(e instanceof Error ? e.message : 'git operation failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 12, overflowY: 'auto', height: '100%' }}>
      <h3 style={{ margin: '0 0 8px' }}>
        Git <span className="muted">§34</span>
      </h3>

      {err && <div className="banner err">{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          type="text"
          placeholder="Repository path…"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          style={{ flex: 1, padding: 6, borderRadius: 4 }}
        />
        <button onClick={() => void refresh()} disabled={busy || !repo}>
          Refresh
        </button>
      </div>

      {status && (
        <div style={{ marginBottom: 8 }}>
          Branch: <span className="pill">{status.branch}</span>
        </div>
      )}

      {status && (
        <div style={{ display: 'flex', gap: 16 }}>
          <FileList title="Staged" files={status.staged} />
          <FileList title="Unstaged" files={status.unstaged} />
          <FileList title="Untracked" files={status.untracked} />
        </div>
      )}

      <h4 style={{ margin: '12px 0 4px' }}>Branches</h4>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          type="text"
          placeholder="new branch name…"
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
          style={{ flex: 1, padding: 6, borderRadius: 4 }}
        />
        <button
          disabled={busy || !repo || !newBranch}
          onClick={() => void run(() => api.createBranch(repo, newBranch).then(() => setNewBranch('')))}
        >
          Create
        </button>
      </div>
      {branches?.all.map((b) => (
        <div key={b} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontFamily: 'monospace', fontSize: 12, flex: 1 }}>{b}</span>
          {b === branches.current ? (
            <span className="pill">current</span>
          ) : (
            <button disabled={busy || !repo} onClick={() => void run(() => api.checkout(repo, b).then(() => undefined))}>
              Checkout
            </button>
          )}
        </div>
      ))}

      <h4 style={{ margin: '12px 0 4px' }}>Commit</h4>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          placeholder="commit message…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          style={{ flex: 1, padding: 6, borderRadius: 4 }}
        />
        <button
          className="primary"
          disabled={busy || !repo || !message.trim()}
          onClick={() => void run(() => api.commit(repo, message).then(() => setMessage('')))}
        >
          Commit
        </button>
      </div>

      <h4 style={{ margin: '12px 0 4px' }}>Log</h4>
      {log.map((e) => (
        <div key={e.sha} style={{ marginBottom: 6, fontSize: 12 }}>
          <span style={{ fontFamily: 'monospace' }}>{e.sha.slice(0, 8)}</span>{' '}
          <span>{e.message}</span>
          <div className="muted">
            {e.author} · {new Date(e.date).toLocaleString()}
          </div>
        </div>
      ))}

      <h4 style={{ margin: '12px 0 4px' }}>Diff</h4>
      <pre className="code-sample" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflowY: 'auto' }}>
        {diff || <span className="muted">No changes.</span>}
      </pre>
    </div>
  );
}

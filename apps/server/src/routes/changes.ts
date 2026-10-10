/**
 * Change review routes — spec §66 (AI Change Review UI).
 *
 *  GET  /api/changes                    → changes from all task/* branches
 *  GET  /api/changes/:id/diff?repo=    → unified diff of one commit
 *  GET  /api/changes/:id/file?repo=&file= → {before, after} for a diff view
 *  POST /api/changes/:id/accept {actor?} → audit + tag as accepted
 *  POST /api/changes/:id/reject {actor?} → audit + tag as rejected
 *  POST /api/changes/:id/revert {actor?} → git revert on the task branch
 *
 * Changes are read from the task branches (`task/<shortid>-<slug>`, see
 * packages/git taskBranch.ts) of the repo given by `?repo=` (defaults to the
 * server workspace). Related tests are parsed from the commit message and
 * evidence links are resolved through the evidence engine when the branch
 * short-id matches a known task.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleChangesRoutes } from './routes/changes';
 *   if (await handleChangesRoutes(req, res, url, ctx)) return;
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { GitRepo } from '@ai-factory/git';
import type { RouteContext } from './context';

const execFileAsync = promisify(execFile);
const WORKSPACE_ROOT = resolve(process.cwd());

type ChangeStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'REVERTED';

/** Review state lives in memory in the prototype — the audit log is the record. */
const statuses = new Map<string, ChangeStatus>();
/** Branch that owns each change id (needed for revert). */
const branchOf = new Map<string, string>();

interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

interface ChangeItem {
  id: string;
  branch: string;
  title: string;
  reason: string;
  author: string;
  date: string;
  files: ChangedFile[];
  additions: number;
  deletions: number;
  diffSummary: string;
  relatedTests: string[];
  evidenceLinks: { id: string; type: string; title: string; status: string }[];
  status: ChangeStatus;
  taskId: string | null;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** Resolve `?repo=` (default: workspace root); the path must be a git repo. */
async function resolveRepo(raw: string | null): Promise<GitRepo> {
  const repoPath = resolve(raw || WORKSPACE_ROOT);
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw Object.assign(new Error(`repo not found: ${repoPath}`), { status: 404 });
  }
  try {
    await git(repoPath, ['rev-parse', '--git-dir']);
  } catch {
    throw Object.assign(new Error(`not a git repository: ${repoPath}`), { status: 400 });
  }
  return new GitRepo(repoPath);
}

/** `task/<shortid>-<slug>` → shortid. */
function shortIdOfBranch(branch: string): string | null {
  const m = /^task\/([a-z0-9]{4,8})-/i.exec(branch);
  return m ? (m[1] as string).toLowerCase() : null;
}

/** Commit-message lines that look test-related (for the "View Tests" button). */
function extractRelatedTests(message: string): string[] {
  const out: string[] = [];
  for (const line of message.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/\b(tests?|specs?|qa|coverage)\b/i.test(t)) out.push(t);
  }
  return out.slice(0, 8);
}

function shortIdOfTask(taskId: string): string {
  return taskId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8)
    .padEnd(4, '0');
}

/** Collect changes from every task/* branch vs the base branch. */
async function collectChanges(repo: GitRepo, ctx: RouteContext): Promise<ChangeItem[]> {
  const { all } = await repo.branches();
  const base = all.includes('main') ? 'main' : all.includes('master') ? 'master' : null;
  if (!base) return [];
  const tasks = ctx.tasks.list();
  const changes: ChangeItem[] = [];

  for (const branch of all.filter((b) => b.startsWith('task/'))) {
    let logOut: string;
    try {
      // \x1e record separator, \x1f field separator
      logOut = await git(repo.path, [
        'log',
        `--format=%H%x1f%s%x1f%b%x1f%an%x1f%aI%x1e`,
        `${base}..${branch}`,
      ]);
    } catch {
      continue;
    }
    const shortId = shortIdOfBranch(branch);
    const task = shortId ? tasks.find((t) => shortIdOfTask(t.id) === shortId) : undefined;
    const taskId = task ? task.id : null;
    const evidenceLinks = task
      ? ctx.evidence.listByTask(task.id).map((e) => ({
          id: e.id,
          type: e.type,
          title: e.title,
          status: e.status,
        }))
      : [];

    for (const record of logOut.split('\x1e')) {
      const rec = record.trim();
      if (!rec) continue;
      const [sha = '', subject = '', body = '', author = '', date = ''] = rec.split('\x1f');
      let numstat = '';
      try {
        numstat = await git(repo.path, ['show', '--format=', '--numstat', sha]);
      } catch {
        continue;
      }
      const files: ChangedFile[] = [];
      for (const line of numstat.split('\n')) {
        const l = line.trim();
        if (!l) continue;
        const parts = l.split('\t');
        if (parts.length < 3) continue;
        const [a, d, filePath] = parts as [string, string, string];
        const binary = a === '-' || d === '-';
        files.push({
          path: filePath,
          additions: binary ? 0 : Number(a) || 0,
          deletions: binary ? 0 : Number(d) || 0,
          binary,
        });
      }
      const additions = files.reduce((n, f) => n + f.additions, 0);
      const deletions = files.reduce((n, f) => n + f.deletions, 0);
      const message = [subject, body].filter(Boolean).join('\n');
      branchOf.set(sha, branch);
      changes.push({
        id: sha,
        branch,
        title: subject,
        reason: message,
        author,
        date,
        files,
        additions,
        deletions,
        diffSummary: `+${additions} −${deletions} across ${files.length} file${files.length === 1 ? '' : 's'}`,
        relatedTests: extractRelatedTests(message),
        evidenceLinks,
        status: statuses.get(sha) ?? 'PENDING',
        taskId,
      });
    }
  }
  return changes.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function handleChangesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/changes')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/changes'.length).split('/').filter(Boolean);
  const repoParam = url.searchParams.get('repo');

  const resolveRepoOr400 = async (): Promise<GitRepo | null> => {
    try {
      return await resolveRepo(repoParam);
    } catch (err) {
      const e = err as Error & { status?: number };
      ctx.json(res, e.status ?? 400, { error: e.message });
      return null;
    }
  };

  // GET /api/changes
  if (method === 'GET' && seg.length === 0) {
    const repo = await resolveRepoOr400();
    if (!repo) return true;
    try {
      const changes = await collectChanges(repo, ctx);
      ctx.json(res, 200, { repo: repo.path, changes });
    } catch (err) {
      ctx.json(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  // GET /api/changes/:id/diff
  if (method === 'GET' && seg.length === 2 && seg[1] === 'diff') {
    const repo = await resolveRepoOr400();
    if (!repo) return true;
    try {
      const diff = await git(repo.path, ['show', '--format=', '--unified=3', seg[0] as string]);
      ctx.json(res, 200, { id: seg[0], diff });
    } catch (err) {
      ctx.json(res, 404, { error: (err as Error).message });
    }
    return true;
  }

  // GET /api/changes/:id/file?file=<path>  → before/after for the diff view
  if (method === 'GET' && seg.length === 2 && seg[1] === 'file') {
    const repo = await resolveRepoOr400();
    if (!repo) return true;
    const file = url.searchParams.get('file');
    if (!file) {
      ctx.json(res, 400, { error: 'file query param is required' });
      return true;
    }
    const sha = seg[0] as string;
    const show = async (rev: string): Promise<string> => {
      try {
        return await git(repo.path, ['show', `${rev}:${file}`]);
      } catch {
        return ''; // file added or deleted in this commit
      }
    };
    const [before, after] = await Promise.all([show(`${sha}^`), show(sha)]);
    ctx.json(res, 200, { id: sha, file, before, after });
    return true;
  }

  // POST /api/changes/:id/accept | /reject | /revert
  if (method === 'POST' && seg.length === 2 && ['accept', 'reject', 'revert'].includes(seg[1] as string)) {
    const repo = await resolveRepoOr400();
    if (!repo) return true;
    const id = seg[0] as string;
    const action = seg[1] as 'accept' | 'reject' | 'revert';
    const body = await ctx.readBody(req);
    const actor = (body['actor'] as string | undefined) ?? 'human';

    if (action === 'accept' || action === 'reject') {
      const status: ChangeStatus = action === 'accept' ? 'ACCEPTED' : 'REJECTED';
      statuses.set(id, status);
      ctx.audit.record(actor, action === 'accept' ? 'CHANGE_ACCEPTED' : 'CHANGE_REJECTED', 'change', id, {
        repo: repo.path,
        branch: branchOf.get(id) ?? null,
      });
      ctx.json(res, 200, { ok: true, id, status });
      return true;
    }

    // revert: checkout the owning task branch, then git revert the commit
    const branch = branchOf.get(id);
    if (!branch) {
      ctx.json(res, 404, { error: `change ${id.slice(0, 8)} not found in the current change list — refresh first` });
      return true;
    }
    try {
      const { current } = await repo.branches();
      if (current !== branch) await repo.checkout(branch);
      await git(repo.path, ['revert', '--no-edit', id]);
      const revertSha = (await git(repo.path, ['rev-parse', 'HEAD'])).trim();
      statuses.set(id, 'REVERTED');
      ctx.audit.record(actor, 'CHANGE_REVERTED', 'change', id, {
        repo: repo.path,
        branch,
        revertSha,
      });
      ctx.json(res, 200, { ok: true, id, status: 'REVERTED' as ChangeStatus, revertSha, branch });
    } catch (err) {
      ctx.json(res, 409, {
        error: `git revert failed: ${(err as Error).message} — resolve conflicts on ${branch} manually`,
      });
    }
    return true;
  }

  return false;
}

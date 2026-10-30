/**
 * Local git linkage (round-7 task R7-#6) — read-only.
 *
 * Runs `git` with argv (never a shell) inside the caller's working tree
 * and parses branch + recent log subjects for `#number` references.
 * Fail-closed: outside a repo, or when git itself fails, this throws
 * PrLinkError — the route turns that into 409/500, never into an
 * empty-but-plausible linkage.
 *
 * No network, no token, no writes: this module cannot touch a remote.
 */
import { execFileSync } from 'node:child_process';
import { extractReferences, mergeReferences } from './refs';
import { PrLinkError, type LocalCommit, type LocalLink } from './types';

const MAX_COMMITS = 50;

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 1_048_576 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: unknown; status?: unknown };
    const stderr = String(err.stderr ?? '');
    if (/not a git repository/i.test(stderr) || /not a git repository/i.test(String(err.message ?? ''))) {
      throw new PrLinkError('not-a-repo', `not a git repository: ${cwd}`);
    }
    throw new PrLinkError('git-failed', `git ${args[0] ?? ''} failed: ${stderr.trim() || err.message}`);
  }
}

/** Current branch (null on detached HEAD) + recent commits with references. */
export function getLocalLink(cwd: string, limit = 20): LocalLink {
  const clamped = Math.max(1, Math.min(MAX_COMMITS, Math.floor(limit) || 20));
  const branchOut = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const branch = branchOut === 'HEAD' ? null : branchOut;
  const logOut = runGit(cwd, [
    'log',
    `-n${clamped}`,
    '--format=%H%x1f%an%x1f%ad%x1f%s',
    '--date=iso',
  ]);
  const commits: LocalCommit[] = [];
  for (const line of logOut.split('\n')) {
    if (!line.trim()) continue;
    const [hash = '', author = '', date = '', subject = ''] = line.split('\x1f');
    if (!hash) continue;
    commits.push({
      hash,
      subject,
      author,
      date,
      references: extractReferences(subject, 'message'),
    });
  }
  const branchRefs = branch ? extractReferences(branch, 'branch') : [];
  return {
    branch,
    commits,
    references: mergeReferences([branchRefs, ...commits.map((c) => c.references)]),
  };
}

/**
 * Unified diff (name + hunks, capped) for a PR-shaped range, used by the
 * read-only review view. Purely local: both ends must resolve in this
 * repo or the call fails closed.
 */
export function getLocalDiff(cwd: string, base: string, head: string): string {
  const out = runGit(cwd, ['diff', '--stat', `${base}...${head}`]);
  const capped = out.length > 64_000 ? out.slice(0, 64_000) + '\n[truncated]' : out;
  return capped;
}

/**
 * Minimal git CLI plumbing for the rebase/stash package.
 *
 * Same discipline as merge3's gitops: spawnSync with cwd pinned to the
 * repo, no pager, no user config, no prompting, bounded timeout. Every
 * failure surfaces as RebaseError (never swallowed); stderr is kept on
 * the error for honest reporting.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RebaseError } from './types.js';

export const GIT_TIMEOUT_MS = 30_000;

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runGit(repo: string, args: string[], envExtra: Record<string, string> = {}): GitResult {
  const r = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_PAGER: 'cat',
      GIT_CONFIG_NOSYSTEM: '1',
      // Never prompt: fail fast instead of hanging on credentials.
      GIT_TERMINAL_PROMPT: '0',
      ...envExtra,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: r.status ?? 1,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
  };
}

/** True when dir is inside a git working tree. */
export function isGitRepo(dir: string): boolean {
  return runGit(dir, ['rev-parse', '--git-dir']).status === 0;
}

/** Absolute path of the repo root (work-tree top level). */
export function repoRootOf(dir: string): string {
  const r = runGit(dir, ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) {
    throw new RebaseError(`not a git repository: ${dir}`, 'NOT_A_REPO');
  }
  return r.stdout.trim();
}

/** Current HEAD hash; throws when the repo has no commits yet. */
export function headSha(repo: string): string {
  const r = runGit(repo, ['rev-parse', 'HEAD']);
  if (r.status !== 0) {
    throw new RebaseError('repository has no commits yet', 'NO_COMMITS');
  }
  return r.stdout.trim();
}

/** True when the working tree and index are clean. */
export function isCleanTree(repo: string): boolean {
  const r = runGit(repo, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (r.status !== 0) {
    throw new RebaseError(`git status failed: ${r.stderr.trim()}`, 'GIT_FAILED');
  }
  return r.stdout.trim() === '';
}

/** True when a rebase is currently in progress (merge or apply state dir). */
export function rebaseInProgress(repo: string): boolean {
  const merge = runGit(repo, ['rev-parse', '--git-path', 'rebase-merge']);
  const apply = runGit(repo, ['rev-parse', '--git-path', 'rebase-apply']);
  if (merge.status !== 0 || apply.status !== 0) return false;
  return existsSync(resolve(repo, merge.stdout.trim())) || existsSync(resolve(repo, apply.stdout.trim()));
}

/** Resolve a ref to a full hash; throws BAD_REF when unresolvable. */
export function resolveRef(repo: string, ref: string): string {
  const r = runGit(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (r.status !== 0) {
    throw new RebaseError(`cannot resolve ref: ${ref}`, 'BAD_REF');
  }
  return r.stdout.trim();
}

/** Commits in `base..HEAD`, oldest first (the rebase todo order). */
export function logRange(repo: string, base: string): { hash: string; subject: string }[] {
  const r = runGit(repo, ['log', '--reverse', '--format=%H%x00%s', `${base}..HEAD`]);
  if (r.status !== 0) {
    throw new RebaseError(`git log failed for base ${base}: ${r.stderr.trim()}`, 'BAD_REF');
  }
  return r.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const sep = line.indexOf('\x00');
      return { hash: line.slice(0, sep), subject: line.slice(sep + 1) };
    });
}

/** Conflicted paths (porcelain v1), empty when no conflict is present. */
export function listConflicted(repo: string): string[] {
  const r = runGit(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  if (r.status !== 0) return [];
  const out: string[] = [];
  for (const entry of r.stdout.split('\x00')) {
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    if (xy.includes('U') || xy === 'AA' || xy === 'DD') out.push(entry.slice(3));
  }
  return out;
}

/** The in-progress todo file text, or null when no rebase is running. */
export function readInProgressTodo(repo: string): string | null {
  const merge = runGit(repo, ['rev-parse', '--git-path', 'rebase-merge']);
  if (merge.status === 0) {
    const p = resolve(repo, merge.stdout.trim(), 'git-rebase-todo');
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  }
  const apply = runGit(repo, ['rev-parse', '--git-path', 'rebase-apply']);
  if (apply.status === 0) {
    const p = resolve(repo, apply.stdout.trim(), 'git-rebase-todo');
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  }
  return null;
}

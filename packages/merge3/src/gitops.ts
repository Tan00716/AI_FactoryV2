/**
 * Minimal git CLI operations for the merge-conflict editor.
 *
 * All commands run via spawnSync with cwd pinned to the repo, no pager,
 * no user config (GIT_CONFIG_NOSYSTEM=1), and a bounded timeout.
 * Every failure throws Merge3Error (never swallowed); stderr is kept
 * on the error for honest reporting.
 */
import { spawnSync } from 'node:child_process';
import { Merge3Error } from './types.js';

export const GIT_TIMEOUT_MS = 30_000;

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runGit(repo: string, args: string[]): GitResult {
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
  const r = runGit(dir, ['rev-parse', '--git-dir']);
  return r.status === 0;
}

export interface ConflictedFile {
  /** Repo-relative path. */
  path: string;
  /** Porcelain XY status, e.g. 'UU', 'AA', 'UD', 'DU', 'DD'. */
  status: string;
}

function isConflictStatus(xy: string): boolean {
  return xy.includes('U') || xy === 'AA' || xy === 'DD';
}

/** List files with unresolved merge conflicts (porcelain v1, NUL-separated). */
export function listConflicted(repo: string): ConflictedFile[] {
  const r = runGit(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  if (r.status !== 0) {
    throw new Merge3Error(`git status failed: ${r.stderr.trim().slice(0, 300)}`, 'git-status-failed');
  }
  const out: ConflictedFile[] = [];
  for (const entry of r.stdout.split('\0')) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (isConflictStatus(xy)) out.push({ path, status: xy });
  }
  return out;
}

/**
 * Read one merge stage of a file: 1=base, 2=ours, 3=theirs.
 * Returns null when the stage does not exist (e.g. added/deleted).
 */
export function readStage(repo: string, relPath: string, stage: 1 | 2 | 3): string | null {
  assertRelPath(relPath);
  const r = runGit(repo, ['show', `:${stage}:${relPath}`]);
  if (r.status !== 0) return null;
  return r.stdout;
}

/** Stage the resolved file (git add). Throws on failure. */
export function stageFile(repo: string, relPath: string): void {
  assertRelPath(relPath);
  const r = runGit(repo, ['add', '--', relPath]);
  if (r.status !== 0) {
    throw new Merge3Error(`git add failed: ${r.stderr.trim().slice(0, 300)}`, 'git-add-failed');
  }
}

/** Repo-relative path jail: no absolute paths, no '..' escapes. */
export function assertRelPath(relPath: string): void {
  if (typeof relPath !== 'string' || !relPath.trim() || relPath.length > 1024) {
    throw new Merge3Error('invalid file path', 'bad-path');
  }
  const p = relPath.trim();
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) {
    throw new Merge3Error(`absolute paths are not allowed: ${p.slice(0, 80)}`, 'path-escape');
  }
  const parts = p.split(/[\\/]/);
  if (parts.some((s) => s === '..')) {
    throw new Merge3Error(`path escapes the repo: ${p.slice(0, 80)}`, 'path-escape');
  }
}

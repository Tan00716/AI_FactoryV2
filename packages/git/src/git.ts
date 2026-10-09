/**
 * Git engine — spec §34.
 * Thin, type-safe wrapper around the `git` CLI. Every operation shells out
 * via `execFile('git', …)` with `cwd` pinned to the repository path.
 *
 * Design rules:
 * - All failures throw GitError (never swallowed); stderr is attached.
 * - Mutating methods accept an optional `audit` callback so callers can
 *   record high-impact actions in the immutable audit log (§70).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Thrown by every GitRepo method on git failure. */
export class GitError extends Error {
  /** Raw stderr from the git process (may be empty). */
  readonly stderr: string;
  /** Exit code from the git process, when known. */
  readonly code: number | undefined;

  constructor(message: string, stderr = '', code?: number) {
    super(message);
    this.name = 'GitError';
    this.stderr = stderr;
    this.code = code;
  }
}

/** Optional audit hook: invoked after each successful mutation. */
export type GitAuditHook = (
  action: string,
  details: Record<string, unknown>,
) => void;

export interface GitStatus {
  branch: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface BranchInfo {
  current: string;
  all: string[];
}

export interface MergeResult {
  ok: boolean;
  conflicts: string[];
}

export interface CommitOptions {
  author?: string;
  allowEmpty?: boolean;
  audit?: GitAuditHook;
}

export interface LogEntry {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface MutatingOptions {
  audit?: GitAuditHook;
}

export class GitRepo {
  /** Absolute path of the repository working tree. */
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private async run(
    args: string[],
    opts: { allowFailure?: boolean } = {},
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: this.path,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const e = err as {
        message?: string;
        stderr?: string;
        stdout?: string;
        code?: number;
      };
      const stderr = (e.stderr ?? '').trim();
      const message = `git ${args.join(' ')} failed: ${stderr || e.message || 'unknown error'}`;
      const gitError = new GitError(message, stderr, e.code);
      if (opts.allowFailure) throw gitError;
      throw gitError;
    }
  }

  /** §34 — status. */
  async status(): Promise<GitStatus> {
    const branchOut = await this.run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchOut.trim();
    const out = await this.run(['status', '--porcelain=v1', '-z']);
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];
    for (const entry of out.split('\0')) {
      if (!entry) continue;
      const x = entry[0]; // index (staged) status
      const y = entry[1]; // worktree (unstaged) status
      const file = entry.slice(3);
      if (x === '?' && y === '?') {
        untracked.push(file);
      } else {
        if (x !== ' ' && x !== '?') staged.push(file);
        if (y !== ' ' && y !== '?') unstaged.push(file);
      }
    }
    return { branch, staged, unstaged, untracked };
  }

  /** §34 — diff. With `ref`: `git diff ref` (working tree vs ref); without: working tree diff. */
  async diff(ref?: string): Promise<string> {
    return this.run(ref ? ['diff', ref] : ['diff']);
  }

  /** §34 — branch list + current branch. */
  async branches(): Promise<BranchInfo> {
    const out = await this.run(['branch', '--format=%(refname:short)']);
    const all = out.split('\n').map((b) => b.trim()).filter(Boolean);
    const currentOut = await this.run(['rev-parse', '--abbrev-ref', 'HEAD']);
    return { current: currentOut.trim(), all };
  }

  /** §34 — create a new branch at HEAD (fails if it already exists). */
  async createBranch(name: string, opts: MutatingOptions = {}): Promise<void> {
    await this.run(['branch', name]);
    opts.audit?.('GIT_BRANCH_CREATED', { repo: this.path, branch: name });
  }

  /** §34 — checkout a branch, tag, or commit. */
  async checkout(ref: string, opts: MutatingOptions = {}): Promise<void> {
    await this.run(['checkout', ref]);
    opts.audit?.('GIT_CHECKOUT', { repo: this.path, ref });
  }

  /** §34 — commit staged changes; returns the new commit sha. */
  async commit(message: string, opts: CommitOptions = {}): Promise<string> {
    if (!message.trim()) {
      throw new GitError('git commit failed: commit message must not be empty');
    }
    const args = ['commit', '-m', message];
    if (opts.allowEmpty) args.push('--allow-empty');
    if (opts.author) args.push(`--author=${opts.author}`);
    await this.run(args);
    const sha = (await this.run(['rev-parse', 'HEAD'])).trim();
    opts.audit?.('GIT_COMMIT', { repo: this.path, sha, message });
    return sha;
  }

  /** §34 — stash working-tree changes. */
  async stashPush(message?: string, opts: MutatingOptions = {}): Promise<void> {
    await this.run(message ? ['stash', 'push', '-m', message] : ['stash', 'push']);
    opts.audit?.('GIT_STASH_PUSH', { repo: this.path, message: message ?? null });
  }

  /** Restore the most recent stash entry. */
  async stashPop(opts: MutatingOptions = {}): Promise<void> {
    await this.run(['stash', 'pop']);
    opts.audit?.('GIT_STASH_POP', { repo: this.path });
  }

  /** List stash entries as raw `git stash list` lines. */
  async stashList(): Promise<string[]> {
    const out = await this.run(['stash', 'list']);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /**
   * §34 — merge `branch` into the current branch.
   * Returns {ok:false, conflicts:[…]} when the merge stops on conflicts
   * (the merge is left in the working tree, exactly like `git merge`).
   */
  async merge(branch: string, opts: MutatingOptions = {}): Promise<MergeResult> {
    try {
      await this.run(['merge', '--no-edit', branch]);
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
      const conflicts = await this.conflictedFiles();
      if (conflicts.length === 0) throw err; // real failure, not a conflict
      return { ok: false, conflicts };
    }
    const sha = (await this.run(['rev-parse', 'HEAD'])).trim();
    opts.audit?.('GIT_MERGE', { repo: this.path, branch, sha });
    return { ok: true, conflicts: [] };
  }

  /** §34 — rebase the current branch onto `branch`. */
  async rebase(branch: string, opts: MutatingOptions = {}): Promise<void> {
    await this.run(['rebase', branch]);
    opts.audit?.('GIT_REBASE', { repo: this.path, onto: branch });
  }

  /** §34 — push. Protected branches are guarded by the caller (see protection.ts). */
  async push(
    remote = 'origin',
    branch?: string,
    opts: MutatingOptions = {},
  ): Promise<void> {
    await this.run(branch ? ['push', remote, branch] : ['push', remote]);
    opts.audit?.('GIT_PUSH', { repo: this.path, remote, branch: branch ?? null });
  }

  /** §34 — pull. */
  async pull(
    remote = 'origin',
    branch?: string,
    opts: MutatingOptions = {},
  ): Promise<void> {
    await this.run(branch ? ['pull', remote, branch] : ['pull', remote]);
    opts.audit?.('GIT_PULL', { repo: this.path, remote, branch: branch ?? null });
  }

  /** §34 — create an annotated tag at HEAD. */
  async tag(name: string, opts: MutatingOptions = {}): Promise<void> {
    await this.run(['tag', name]);
    opts.audit?.('GIT_TAG_CREATED', { repo: this.path, tag: name });
  }

  /** §34 — log: newest `limit` commits. */
  async log(limit = 20): Promise<LogEntry[]> {
    const SEP = '\x1f';
    const out = await this.run([
      'log',
      `--format=%H${SEP}%s${SEP}%an${SEP}%aI`,
      `-n`,
      String(limit),
    ]);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, message, author, date] = line.split(SEP);
        return { sha, message, author, date };
      });
  }

  /** Files currently marked as conflicted (U = unmerged). */
  private async conflictedFiles(): Promise<string[]> {
    const out = await this.run(['diff', '--name-only', '--diff-filter=U']);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }
}

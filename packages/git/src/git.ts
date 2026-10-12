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
import { createHash } from 'crypto';
import { promisify } from 'util';
import type { ChangeEvidenceFields } from './evidence';

const execFileAsync = promisify(execFile);

/** Git's well-known empty-tree object id — the diff base for root commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Thrown by every GitRepo method on git failure. */
export class GitError extends Error {
  /** Raw stderr from the git process (may be empty). */
  readonly stderr: string;
  /** Exit code from the git process, when known. */
  readonly code: number | undefined;
  /**
   * Raw stdout from the git process (may be empty). Some commands report
   * their result on stdout even when they exit non-zero — notably
   * `git merge-tree --write-tree`, whose exit 1 means "conflicts" and
   * whose stdout carries the tree OID and the conflicted file list.
   */
  readonly stdout: string;

  constructor(message: string, stderr = '', code?: number, stdout = '') {
    super(message);
    this.name = 'GitError';
    this.stderr = stderr;
    this.code = code;
    this.stdout = stdout;
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

/** Result of a non-destructive merge preview (see GitRepo.mergePreview). */
export interface MergePreview {
  /** True when the merge would complete with no conflicts. */
  clean: boolean;
  /** OID of the would-be result tree (null when git did not report one). */
  treeOid: string | null;
  /** Files that would be left unmerged (empty when clean). */
  conflicts: string[];
}

export interface MergeResult {
  ok: boolean;
  conflicts: string[];
  /**
   * §36 change evidence for a successful merge (absent on conflict):
   * baseSha = target tip before the merge, candidateSha = merged branch
   * tip, targetSha = target tip after the merge, diffHash = sha256 of the
   * base→target diff that landed, artifactDigest = null (no artifact is
   * produced by a merge — 'no artifact').
   */
  evidence?: ChangeEvidenceFields;
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
  /**
   * §36 change-evidence fields, populated by log(): candidateSha is the
   * commit itself, baseSha its first parent (null for a root commit),
   * targetSha the current HEAD (target branch tip at read time), diffHash
   * the sha256 of the base→candidate diff (null if the diff cannot be
   * computed), artifactDigest null — a changelog entry has no build
   * artifact ('no artifact').
   */
  baseSha?: string | null;
  candidateSha?: string | null;
  targetSha?: string | null;
  diffHash?: string | null;
  artifactDigest?: string | null;
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
      const gitError = new GitError(message, stderr, e.code, e.stdout ?? '');
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

  /** Resolve a ref to its commit sha (throws GitError when unknown). */
  private async revParse(ref: string): Promise<string> {
    return (await this.run(['rev-parse', ref])).trim();
  }

  /** Public ref resolution (branch/tag/sha → commit sha), for callers
   *  that record §36 SHAs without performing an operation themselves. */
  async resolveRef(ref: string): Promise<string> {
    return this.revParse(ref);
  }

  /** Raw `git diff from to` text (both refs, no working tree involved). */
  async diffBetween(from: string, to: string): Promise<string> {
    return this.run(['diff', from, to]);
  }

  /** sha256 hex of the `git diff from to` text; null when not computable. */
  private async diffHash(from: string, to: string): Promise<string | null> {
    try {
      const diff = await this.run(['diff', from, to]);
      return createHash('sha256').update(diff).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * §34 — merge `branch` into the current branch.
   * Returns {ok:false, conflicts:[…]} when the merge stops on conflicts
   * (the merge is left in the working tree, exactly like `git merge`).
   * On success the result carries the §36 evidence fields (see MergeResult).
   */
  async merge(branch: string, opts: MutatingOptions = {}): Promise<MergeResult> {
    const baseSha = await this.revParse('HEAD');
    const candidateSha = await this.revParse(branch);
    try {
      await this.run(['merge', '--no-edit', branch]);
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
      const conflicts = await this.conflictedFiles();
      if (conflicts.length === 0) throw err; // real failure, not a conflict
      return { ok: false, conflicts };
    }
    const sha = await this.revParse('HEAD');
    opts.audit?.('GIT_MERGE', { repo: this.path, branch, sha });
    return {
      ok: true,
      conflicts: [],
      evidence: {
        baseSha,
        candidateSha,
        targetSha: sha,
        diffHash: await this.diffHash(baseSha, sha),
        // A merge produces no build artifact — 'no artifact', never invented.
        artifactDigest: null,
      },
    };
  }

  /**
   * §36 — non-destructive merge preview: what WOULD happen if `source`
   * were merged into `target`, computed by `git merge-tree --write-tree`
   * without touching the working tree, the index, or any branch.
   * `treeOid` is the would-be result tree (the merge candidate's content
   * identity); on conflict it is the tree git would produce with conflict
   * markers, `clean` is false and `conflicts` names the unmerged files.
   * Exit 1 from merge-tree means "conflicts", not an operational failure;
   * any other failure throws GitError.
   */
  async mergePreview(target: string, source: string): Promise<MergePreview> {
    let out: string;
    let code = 0;
    try {
      out = await this.run(['merge-tree', '--write-tree', '--name-only', target, source]);
    } catch (err) {
      if (!(err instanceof GitError) || err.code !== 1) throw err;
      out = err.stdout;
      code = 1;
    }
    const lines = out.split('\n');
    const treeOid = (lines[0] ?? '').trim() || null;
    const conflicts: string[] = [];
    if (code === 1) {
      // With --name-only the conflicted file names follow the tree OID,
      // one per line, up to a blank line; informational messages come after.
      for (const line of lines.slice(1)) {
        if (line.trim() === '') break;
        conflicts.push(line.trim());
      }
    }
    return { clean: code === 0, treeOid, conflicts };
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

  /**
   * §34 — log: newest `limit` commits, each enriched with the §36
   * change-evidence fields (see LogEntry). targetSha is the current HEAD,
   * fetched once; diffHash is computed per commit against its first
   * parent (the empty tree for a root commit).
   */
  async log(limit = 20): Promise<LogEntry[]> {
    const SEP = '\x1f';
    const out = await this.run([
      'log',
      `--format=%H${SEP}%s${SEP}%an${SEP}%aI${SEP}%P`,
      `-n`,
      String(limit),
    ]);
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return [];
    const targetSha = await this.revParse('HEAD');
    const entries: LogEntry[] = [];
    for (const line of lines) {
      const [sha, message, author, date, parents] = line.split(SEP);
      const baseSha = parents?.split(' ').filter(Boolean)[0] ?? null;
      entries.push({
        sha,
        message,
        author,
        date,
        baseSha,
        candidateSha: sha,
        targetSha,
        diffHash: await this.diffHash(baseSha ?? EMPTY_TREE, sha),
        // A changelog entry has no build artifact — 'no artifact'.
        artifactDigest: null,
      });
    }
    return entries;
  }

  /** Files currently marked as conflicted (U = unmerged). */
  private async conflictedFiles(): Promise<string[]> {
    const out = await this.run(['diff', '--name-only', '--diff-filter=U']);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }
}

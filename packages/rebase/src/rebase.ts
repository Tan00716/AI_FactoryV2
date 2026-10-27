/**
 * Rebase lifecycle: start (with sequence-editor + message-queue scripts),
 * abort, continue, skip, and stash operations.
 *
 * How `git rebase -i` is driven without a terminal:
 *  - GIT_SEQUENCE_EDITOR points at a generated shell script that copies a
 *    prepared todo file over the todo git opens. No interactive editor.
 *  - GIT_EDITOR points at a generated script that pops one single-line
 *    message per `reword` from a queue file (in todo order); when the
 *    queue is empty it leaves the message untouched, which also makes
 *    `squash` accept git's default combined message.
 *  - Both scripts live in a caller-provided scratch dir (created under
 *    the caller's temp area) and are removed by the caller. Reword
 *    messages are single-line in v1 — multi-line input is rejected
 *    before anything runs.
 *  - Rebase is never run on a dirty tree or while another rebase is in
 *    progress; both are refused before any git mutation.
 *  - On hard failure (non-conflict), `git rebase --abort` restores the
 *    pre-rebase HEAD; the caller additionally holds a shadow checkpoint
 *    id for file-level restore. On conflict, the state is left in place
 *    so the user can resolve via the merge3 editor and continue.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  headSha,
  isCleanTree,
  listConflicted,
  logRange,
  rebaseInProgress,
  resolveRef,
  runGit,
} from './gitops.js';
import { expandTodoHashes, serializeTodo, validateTodoAgainstRange } from './todo.js';
import {
  RebaseError,
  type RebaseResult,
  type StashApplyResult,
  type StashEntry,
  type TodoLine,
} from './types.js';

const STDERR_TAIL = 4000;

function tail(s: string): string {
  return s.length > STDERR_TAIL ? s.slice(-STDERR_TAIL) : s;
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

export interface StartRebaseOptions {
  repo: string;
  /** Base ref (commit hash or ref name); the todo rewrites base..HEAD. */
  base: string;
  todos: TodoLine[];
  /** Scratch dir parent (caller temp area); scripts are cleaned up after. */
  scratchParent?: string;
  /** Shadow checkpoint id taken by the caller before this call. */
  checkpointId?: string;
}

export function startRebase(opts: StartRebaseOptions): RebaseResult {
  const { repo, base } = opts;
  const headBefore = headSha(repo);
  if (rebaseInProgress(repo)) {
    throw new RebaseError('a rebase is already in progress; abort or continue it first', 'REBASE_IN_PROGRESS');
  }
  if (!isCleanTree(repo)) {
    throw new RebaseError('working tree is dirty; commit or stash before rebasing', 'DIRTY_TREE');
  }
  const baseSha = resolveRef(repo, base);
  if (baseSha === headBefore) {
    throw new RebaseError('base equals HEAD: nothing to rebase', 'EMPTY_RANGE');
  }
  const range = logRange(repo, base);
  if (range.length === 0) {
    throw new RebaseError(`no commits in range ${base}..HEAD`, 'EMPTY_RANGE');
  }
  const rangeHashes = range.map((c) => c.hash);
  validateTodoAgainstRange(opts.todos, rangeHashes);
  const todos = expandTodoHashes(opts.todos, rangeHashes);
  for (const t of todos) {
    if (t.action === 'reword' && t.message !== undefined && t.message.includes('\n')) {
      throw new RebaseError('reword messages are single-line in v1', 'REWORD_MULTILINE');
    }
  }

  const scratch = mkdtempSync(join(opts.scratchParent ?? tmpdir(), 'rebase-'));
  try {
    const todoPath = join(scratch, 'todo');
    writeFileSync(todoPath, serializeTodo(todos), 'utf8');
    const seqScript = join(scratch, 'sequence-editor.sh');
    writeFileSync(seqScript, `#!/bin/sh\ncp ${shellQuote(todoPath)} "$1"\n`, 'utf8');
    chmodSync(seqScript, 0o700);
    const queuePath = join(scratch, 'messages');
    const messages = todos.filter((t) => t.action === 'reword' && t.message !== undefined).map((t) => t.message as string);
    writeFileSync(queuePath, messages.join('\n') + (messages.length ? '\n' : ''), 'utf8');
    const editorScript = join(scratch, 'editor.sh');
    writeFileSync(
      editorScript,
      '#!/bin/sh\n' +
        `if [ -s ${shellQuote(queuePath)} ]; then\n` +
        `  line=$(head -n 1 ${shellQuote(queuePath)})\n` +
        `  printf '%s\\n' "$line" > "$1"\n` +
        `  tail -n +2 ${shellQuote(queuePath)} > ${shellQuote(queuePath)}.tmp && mv ${shellQuote(queuePath)}.tmp ${shellQuote(queuePath)}\n` +
        'fi\n',
      'utf8',
    );
    chmodSync(editorScript, 0o700);

    const r = runGit(repo, ['rebase', '-i', baseSha], {
      GIT_SEQUENCE_EDITOR: seqScript,
      GIT_EDITOR: editorScript,
    });
    const headAfter = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim() || headBefore;
    if (r.status === 0) {
      return { status: 'completed', headBefore, headAfter, conflictedFiles: [], stderr: tail(r.stderr), checkpointId: opts.checkpointId };
    }
    if (rebaseInProgress(repo)) {
      return { status: 'conflict', headBefore, headAfter, conflictedFiles: listConflicted(repo), stderr: tail(r.stderr), checkpointId: opts.checkpointId };
    }
    // Hard failure: abort to restore the pre-rebase HEAD.
    runGit(repo, ['rebase', '--abort']);
    const restored = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim() || headBefore;
    return { status: 'failed', headBefore, headAfter: restored, conflictedFiles: [], stderr: tail(r.stderr), checkpointId: opts.checkpointId };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function abortRebase(repo: string): RebaseResult {
  const headBefore = headSha(repo);
  if (!rebaseInProgress(repo)) {
    throw new RebaseError('no rebase in progress to abort', 'NO_REBASE');
  }
  const r = runGit(repo, ['rebase', '--abort']);
  if (r.status !== 0) {
    throw new RebaseError(`git rebase --abort failed: ${r.stderr.trim()}`, 'GIT_FAILED');
  }
  return { status: 'completed', headBefore, headAfter: headSha(repo), conflictedFiles: [], stderr: tail(r.stderr) };
}

function continueOrSkip(repo: string, verb: 'continue' | 'skip'): RebaseResult {
  const headBefore = (() => {
    try {
      return headSha(repo);
    } catch {
      return '';
    }
  })();
  if (!rebaseInProgress(repo)) {
    throw new RebaseError(`no rebase in progress to ${verb}`, 'NO_REBASE');
  }
  const r = runGit(repo, ['rebase', `--${verb}`], {
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
  });
  const headAfter = (() => {
    try {
      return headSha(repo);
    } catch {
      return headBefore;
    }
  })();
  if (r.status === 0) {
    return { status: 'completed', headBefore, headAfter, conflictedFiles: [], stderr: tail(r.stderr) };
  }
  if (rebaseInProgress(repo)) {
    return { status: 'conflict', headBefore, headAfter, conflictedFiles: listConflicted(repo), stderr: tail(r.stderr) };
  }
  return { status: 'failed', headBefore, headAfter, conflictedFiles: [], stderr: tail(r.stderr) };
}

export function continueRebase(repo: string): RebaseResult {
  return continueOrSkip(repo, 'continue');
}

export function skipRebase(repo: string): RebaseResult {
  return continueOrSkip(repo, 'skip');
}

// ---- Stash ---------------------------------------------------------------

const STASH_REF = /^stash@\{(\d+)\}$/;

export function parseStashRef(raw: string): { index: string; position: number } {
  const m = STASH_REF.exec(raw.trim());
  if (!m) throw new RebaseError(`invalid stash ref: ${raw.slice(0, 40)}`, 'BAD_STASH_REF');
  return { index: `stash@{${m[1]}}`, position: Number(m[1]) };
}

/** `git stash list` entries, newest first. */
export function listStash(repo: string): StashEntry[] {
  const r = runGit(repo, ['stash', 'list', '--format=%gd%x00%gs']);
  if (r.status !== 0) {
    throw new RebaseError(`git stash list failed: ${r.stderr.trim()}`, 'GIT_FAILED');
  }
  const out: StashEntry[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const sep = line.indexOf('\x00');
    if (sep < 0) continue;
    const ref = line.slice(0, sep);
    const { index, position } = parseStashRef(ref);
    out.push({ index, position, message: line.slice(sep + 1) });
  }
  return out;
}

/** Full diff of one stash entry (capped at 512KB, like the timeline diff). */
export function showStash(repo: string, ref: string): string {
  const { index } = parseStashRef(ref);
  const r = runGit(repo, ['stash', 'show', '-p', index]);
  if (r.status !== 0) {
    throw new RebaseError(`git stash show failed for ${index}: ${r.stderr.trim()}`, 'GIT_FAILED');
  }
  return r.stdout.length > 512 * 1024 ? r.stdout.slice(0, 512 * 1024) : r.stdout;
}

export function pushStash(repo: string, message: string, includeUntracked: boolean): StashEntry {
  if (!message.trim() || message.length > 200) {
    throw new RebaseError('stash message is required (max 200 chars)', 'BAD_STASH_MESSAGE');
  }
  const args = ['stash', 'push', '-m', message.trim()];
  if (includeUntracked) args.push('--include-untracked');
  const r = runGit(repo, args);
  if (r.status !== 0) {
    throw new RebaseError(`git stash push failed: ${r.stderr.trim()}`, 'GIT_FAILED');
  }
  const entries = listStash(repo);
  const created = entries[0];
  if (!created) throw new RebaseError('stash push reported success but no entry appeared', 'GIT_FAILED');
  return created;
}

function applyOrPop(repo: string, ref: string, verb: 'apply' | 'pop'): StashApplyResult {
  const { index } = parseStashRef(ref);
  const r = runGit(repo, ['stash', verb, index]);
  if (r.status === 0) {
    return { outcome: 'applied', conflictedFiles: [], stderr: tail(r.stderr) };
  }
  const conflicted = listConflicted(repo);
  if (conflicted.length > 0) {
    // Note: a conflicted `pop` keeps the stash entry (git behavior) —
    // the UI surfaces this so the user does not lose the stash.
    return { outcome: 'conflict', conflictedFiles: conflicted, stderr: tail(r.stderr) };
  }
  return { outcome: 'failed', conflictedFiles: [], stderr: tail(r.stderr) };
}

export function applyStash(repo: string, ref: string): StashApplyResult {
  return applyOrPop(repo, ref, 'apply');
}

export function popStash(repo: string, ref: string): StashApplyResult {
  return applyOrPop(repo, ref, 'pop');
}

export function dropStash(repo: string, ref: string): void {
  const { index } = parseStashRef(ref);
  const r = runGit(repo, ['stash', 'drop', index]);
  if (r.status !== 0) {
    throw new RebaseError(`git stash drop failed for ${index}: ${r.stderr.trim()}`, 'GIT_FAILED');
  }
}

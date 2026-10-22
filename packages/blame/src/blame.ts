/**
 * `git blame --porcelain` parsing + execution (round-5 task R5-A4).
 *
 * Porcelain format (per block):
 *   <sha> <orig-line> <final-line> <nlines>
 *   author <name>
 *   author-mail <mail>
 *   author-time <epoch>
 *   author-tz <tz>
 *   committer ...
 *   summary <summary>
 *   previous ...
 *   filename <path>
 *   \t<line content>
 *
 * Pure parsing is separated from spawning so tests can run without git.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  BlameError,
  BlameLine,
  BlameResult,
  UNCOMMITTED_SHA,
} from './types';

const execFileAsync = promisify(execFile);

export const DEFAULT_BLAME_TIMEOUT_MS = 30_000;
export const DEFAULT_BLAME_LINE_CAP = 2000;
const SHA_RE = /^[0-9a-f]{40} \d+ \d+ \d+$/;
/**
 * Abbreviated continuation header git emits for contiguous lines from the
 * same commit: `<sha> <orig> <final>` (3 fields, no metadata follows —
 * the metadata belongs to the preceding full block).
 */
const SHA_CONT_RE = /^[0-9a-f]{40} \d+ \d+$/;

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

/**
 * Parse `git blame --porcelain` stdout into BlameLine[] (pure).
 * Blocks whose content line is missing are still emitted (content is not
 * part of the BlameLine contract).
 */
export function parseBlamePorcelain(stdout: string): BlameLine[] {
  const out: BlameLine[] = [];
  let sha = '';
  let lineNo = 0;
  let author = '';
  let authorMail = '';
  let authorTime = 0;
  let summary = '';
  const pushBlock = (): void => {
    if (!sha) return;
    const uncommitted = sha === UNCOMMITTED_SHA;
    out.push({
      line: lineNo,
      hash: sha,
      shortHash: shortHash(sha),
      author: uncommitted ? 'uncommitted' : author,
      authorMail: uncommitted ? '' : authorMail,
      authorTime: uncommitted ? 0 : authorTime,
      summary: uncommitted ? '' : summary,
      uncommitted,
    });
  };
  for (const line of stdout.split('\n')) {
    if (SHA_RE.test(line)) {
      pushBlock(); // commit the previous block, then start a new one
      const parts = line.split(' ');
      sha = parts[0];
      lineNo = Number(parts[2]);
      author = '';
      authorMail = '';
      authorTime = 0;
      summary = '';
    } else if (SHA_CONT_RE.test(line)) {
      // Abbreviated continuation: same commit as the current block, no
      // metadata follows. Emit the previous block, then start a new line
      // reusing its metadata (only when the sha matches; otherwise the
      // metadata is unknown and stays empty rather than guessed).
      const contSha = line.split(' ')[0];
      const sameCommit = contSha === sha && sha !== '';
      pushBlock();
      sha = contSha;
      lineNo = Number(line.split(' ')[2]);
      if (!sameCommit) {
        author = '';
        authorMail = '';
        authorTime = 0;
        summary = '';
      }
      // On sameCommit, author/authorMail/authorTime/summary are
      // intentionally NOT reset.
    } else if (line.startsWith('author-mail ')) {
      authorMail = line.slice('author-mail '.length).replace(/^<|>$/g, '');
    } else if (line.startsWith('author-time ')) {
      authorTime = Number(line.slice('author-time '.length)) || 0;
    } else if (line.startsWith('author ')) {
      author = line.slice('author '.length);
    } else if (line.startsWith('summary ')) {
      summary = line.slice('summary '.length);
    }
    // 'author-tz', 'committer*', 'previous', 'filename', 'boundary', and the
    // '\t'-prefixed content line are ignored.
  }
  pushBlock();
  return out;
}

/**
 * Run `git blame --porcelain` for a repo-relative path. Throws BlameError
 * with code NOT_A_REPO (cwd not in a repo), BLAME_TIMEOUT, or BLAME_FAILED.
 * Applies a line cap: files longer than `maxLines` are blamed only for the
 * first `maxLines` lines and the result is marked truncated.
 */
export async function blameFile(
  repoRoot: string,
  relPath: string,
  opts: { timeoutMs?: number; maxLines?: number } = {},
): Promise<BlameResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BLAME_TIMEOUT_MS;
  const maxLines = opts.maxLines ?? DEFAULT_BLAME_LINE_CAP;
  let stdout: string;
  try {
    const r = await execFileAsync(
      'git',
      ['blame', '--porcelain', '-L', `1,${maxLines}`, '--', relPath],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, signal: AbortSignal.timeout(timeoutMs) },
    );
    stdout = r.stdout;
  } catch (e) {
    const err = e as Error & { code?: string | number; stderr?: string };
    const msg = String(err?.message ?? err);
    if (err?.name === 'AbortError' || /aborted/i.test(msg)) {
      throw new BlameError(`git blame timed out after ${timeoutMs}ms`, 'BLAME_TIMEOUT');
    }
    const stderr = String(err?.stderr ?? '');
    if (/not a git repository|not in a git directory/i.test(stderr + msg)) {
      throw new BlameError('not inside a git repository', 'NOT_A_REPO');
    }
    throw new BlameError(`git blame failed: ${stderr.slice(0, 200) || msg.slice(0, 200)}`, 'BLAME_FAILED');
  }
  const lines = parseBlamePorcelain(stdout);
  const truncated = lines.length >= maxLines;
  return { repoRoot, file: relPath, lines, truncated, lineCap: maxLines };
}

/**
 * Resolve the repository top level for a directory. Throws BlameError with
 * code NOT_A_REPO when the directory is not inside a git repository.
 */
export async function repoRootOf(
  dir: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BLAME_TIMEOUT_MS;
  try {
    const r = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.stdout.trim();
  } catch {
    throw new BlameError('not inside a git repository', 'NOT_A_REPO');
  }
}

/**
 * Timeline fusion (round-5 task R5-A4): merge `git log -- <file>` entries
 * with Local History snapshot metas into one wall-clock-descending list,
 * plus a deterministic unified-diff renderer for any two timeline points.
 *
 * Pure functions take plain data so tests need no git; the only impure
 * helpers are the git spawners. Snapshot content itself is read by the
 * server route (Local History lives server-side), not here.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  BlameError,
  TimelineGitEntry,
  TimelineResult,
  TimelineSnapshotEntry,
} from './types';

const execFileAsync = promisify(execFile);
const FIELD_SEP = '\u0001';
const ENTRY_SEP = '\u001e';

/**
 * Parse `git log --format=%H%x01%an%x01%at%x01%s%x1e -- <path>` output
 * (pure). Messages may contain newlines; the record separator is \x1e.
 */
export function parseLogOutput(stdout: string): TimelineGitEntry[] {
  const out: TimelineGitEntry[] = [];
  for (const rec of stdout.split(ENTRY_SEP)) {
    const r = rec.trim();
    if (!r) continue;
    const fields = r.split(FIELD_SEP);
    if (fields.length < 4) continue;
    const [hash, author, atRaw, ...rest] = fields;
    const message = rest.join(FIELD_SEP).replace(/\n/g, ' ').slice(0, 200);
    const date = Number(atRaw) || 0;
    out.push({ kind: 'git', hash, shortHash: hash.slice(0, 7), author, date, message });
  }
  return out;
}

/** Run `git log` for a repo-relative file path (newest first). */
export async function logFile(
  repoRoot: string,
  relPath: string,
  limit: number,
  opts: { timeoutMs?: number } = {},
): Promise<TimelineGitEntry[]> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  try {
    const r = await execFileAsync(
      'git',
      ['log', `--max-count=${limit}`, `--format=%H${FIELD_SEP}%an${FIELD_SEP}%at${FIELD_SEP}%s${ENTRY_SEP}`, '--', relPath],
      { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024, signal: AbortSignal.timeout(timeoutMs) },
    );
    return parseLogOutput(r.stdout);
  } catch (e) {
    const err = e as Error;
    const msg = String(err?.message ?? err);
    if (err?.name === 'AbortError' || /aborted/i.test(msg)) {
      throw new BlameError(`git log timed out after ${timeoutMs}ms`, 'LOG_TIMEOUT');
    }
    throw new BlameError(`git log failed: ${msg.slice(0, 200)}`, 'LOG_FAILED');
  }
}

/** Read one blob from git: `git show <hash>:<repoRelPath>`. */
export async function gitShowFile(
  repoRoot: string,
  hash: string,
  repoRelPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) {
    throw new BlameError(`refusing to show non-hex ref: ${hash.slice(0, 32)}`, 'BAD_REF');
  }
  try {
    const r = await execFileAsync('git', ['show', `${hash}:${repoRelPath}`], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.stdout;
  } catch (e) {
    throw new BlameError(`git show failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`, 'SHOW_FAILED');
  }
}

/** Snapshot metas in, timeline entries out (pure adapter). */
export function snapshotsToEntries(
  metas: Array<{ id: string; createdAt: string; kind: string; size: number }>,
): TimelineSnapshotEntry[] {
  return metas.map((m) => ({
    kind: 'snapshot',
    id: m.id,
    dateMs: Date.parse(m.createdAt) || 0,
    snapshotKind: m.kind,
    size: m.size,
  }));
}

/**
 * Fuse git log entries and snapshot entries into one list, newest first
 * (pure). Git dates are epoch seconds; snapshot dates are epoch ms.
 */
export function fuseTimeline(
  git: TimelineGitEntry[],
  snapshots: TimelineSnapshotEntry[],
): TimelineResult['entries'] {
  const withTs = [
    ...git.map((g) => ({ e: g, ts: g.date * 1000 })),
    ...snapshots.map((s) => ({ e: s, ts: s.dateMs })),
  ];
  withTs.sort((a, b) => b.ts - a.ts);
  return withTs.map((x) => x.e);
}

/**
 * Minimal deterministic unified diff (hunk headers + -/+ lines only, no
 * context compression games). Pure; O(n*m) LCS on lines — callers keep
 * inputs bounded.
 */
export function unifiedDiffText(
  before: string,
  after: string,
  beforeLabel: string,
  afterLabel: string,
): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  // LCS table on bounded inputs.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  type Op = { t: 'same' | 'del' | 'add'; s: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'same', s: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ t: 'del', s: a[i] });
      i++;
    } else {
      ops.push({ t: 'add', s: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: 'del', s: a[i++] });
  while (j < m) ops.push({ t: 'add', s: b[j++] });
  if (!ops.some((o) => o.t !== 'same')) return '';
  const header = [`--- ${beforeLabel}`, `+++ ${afterLabel}`];
  const body = assembleHunks(ops);
  return header.join('\n') + '\n' + body;
}


/**
 * Assemble hunks from an op list: group change regions with up to 3 lines
 * of surrounding context (standard unified-diff behavior).
 */
function assembleHunks(
  ops: Array<{ t: 'same' | 'del' | 'add'; s: string }>,
): string {
  const out: string[] = [];
  const CONTEXT = 3;
  // Mark ops that belong to a change region (changed op, or 'same' within
  // CONTEXT of a change).
  const changedIdx: number[] = [];
  for (let k = 0; k < ops.length; k++) if (ops[k].t !== 'same') changedIdx.push(k);
  if (changedIdx.length === 0) return '';
  const regions: Array<[number, number]> = [];
  let rs = Math.max(0, changedIdx[0] - CONTEXT);
  let re = changedIdx[0];
  for (const k of changedIdx.slice(1)) {
    if (k - re <= CONTEXT * 2) {
      re = k;
    } else {
      regions.push([rs, Math.min(ops.length - 1, re + CONTEXT)]);
      rs = Math.max(0, k - CONTEXT);
      re = k;
    }
  }
  regions.push([rs, Math.min(ops.length - 1, re + CONTEXT)]);
  for (const [from, to] of regions) {
    let aStart = 1;
    let bStart = 1;
    // Compute line numbers by walking ops up to `from`.
    let aN = 1;
    let bN = 1;
    for (let k = 0; k < from; k++) {
      const o = ops[k];
      if (o.t === 'same') {
        aN++;
        bN++;
      } else if (o.t === 'del') aN++;
      else bN++;
    }
    aStart = aN;
    bStart = bN;
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (let k = from; k <= to; k++) {
      const o = ops[k];
      if (o.t === 'same') {
        body.push(' ' + o.s);
        aCount++;
        bCount++;
      } else if (o.t === 'del') {
        body.push('-' + o.s);
        aCount++;
      } else {
        body.push('+' + o.s);
        bCount++;
      }
    }
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    out.push(...body);
  }
  return out.join('\n');
}

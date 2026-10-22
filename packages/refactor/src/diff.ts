/**
 * @ai-factory/refactor — minimal deterministic unified-diff generator.
 *
 * Why not the shadow-git diff pipeline: that pipeline diffs two *real*
 * checkpoints in a sidecar git repo (`diffShadowCheckpoints`). A refactor
 * *preview* must be side-effect free — it may never touch the real tree —
 * so the diff is computed in memory here. The output is git-compatible
 * unified format (parseable by `@ai-factory/git`'s `parseUnifiedDiff`).
 *
 * Pure function, zero dependencies. Same inputs → byte-identical output.
 */

export interface DiffOptions {
  /** Context lines around each hunk. Default 3. */
  context?: number;
  /** Old/new file labels. Default 'a/file' / 'b/file'. */
  fromFile?: string;
  toFile?: string;
}

const MAX_LINES = 6000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  // keep a single trailing-newline marker implicit; drop the phantom last
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** LCS table via Hirschberg-lite: full DP when small, greedy fallback when big. */
function lcsOps(a: string[], b: string[]): Array<'eq' | 'del' | 'add'> {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    // greedy fallback: treat as total replacement (still deterministic)
    const ops: Array<'eq' | 'del' | 'add'> = [];
    for (let k = 0; k < n; k++) ops.push('del');
    for (let k = 0; k < m; k++) ops.push('add');
    return ops;
  }
  // DP with suffix lengths, Uint32 to stay lean
  const dp: Uint32Array[] = [];
  for (let ii = 0; ii <= n; ii++) dp.push(new Uint32Array(m + 1));
  for (let ii = n - 1; ii >= 0; ii--) {
    const row = dp[ii];
    const nxt = dp[ii + 1];
    const ai = a[ii];
    for (let jj = m - 1; jj >= 0; jj--) {
      row[jj] = ai === b[jj] ? nxt[jj + 1] + 1 : Math.max(nxt[jj], row[jj + 1]);
    }
  }
  const ops: Array<'eq' | 'del' | 'add'> = [];
  let ii = 0;
  let jj = 0;
  while (ii < n && jj < m) {
    if (a[ii] === b[jj]) {
      ops.push('eq');
      ii++;
      jj++;
    } else if (dp[ii + 1][jj] >= dp[ii][jj + 1]) {
      ops.push('del');
      ii++;
    } else {
      ops.push('add');
      jj++;
    }
  }
  while (ii < n) {
    ops.push('del');
    ii++;
  }
  while (jj < m) {
    ops.push('add');
    jj++;
  }
  return ops;
}

export function unifiedDiff(before: string, after: string, opts: DiffOptions = {}): string {
  const context = Math.max(0, Math.min(10, opts.context ?? 3));
  const fromFile = opts.fromFile ?? 'a/file';
  const toFile = opts.toFile ?? 'b/file';
  if (before === after) return '';
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return (
      `--- ${fromFile}\n+++ ${toFile}\n` +
      `@@ -1,${a.length} +1,${b.length} @@\n` +
      `<file too large for detailed diff; ${a.length} -> ${b.length} lines>\n`
    );
  }
  const ops = lcsOps(a, b);
  // group into hunks
  interface HunkLine {
    op: 'eq' | 'del' | 'add';
    text: string;
  }
  const lines: HunkLine[] = [];
  {
    let ii = 0;
    let jj = 0;
    for (const op of ops) {
      if (op === 'eq') {
        lines.push({ op, text: a[ii] });
        ii++;
        jj++;
      } else if (op === 'del') {
        lines.push({ op, text: a[ii] });
        ii++;
      } else {
        lines.push({ op, text: b[jj] });
        jj++;
      }
    }
  }
  // find change blocks, expand by context, merge overlaps
  const hunks: Array<{ start: number; end: number }> = [];
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].op !== 'eq') {
      let s = k;
      let e = k;
      while (e + 1 < lines.length && lines[e + 1].op !== 'eq') e++;
      hunks.push({ start: Math.max(0, s - context), end: Math.min(lines.length - 1, e + context) });
      k = e;
    }
  }
  const merged: Array<{ start: number; end: number }> = [];
  for (const h of hunks) {
    const last = merged[merged.length - 1];
    if (last && h.start <= last.end + 1) last.end = Math.max(last.end, h.end);
    else merged.push({ ...h });
  }
  let out = `--- ${fromFile}\n+++ ${toFile}\n`;
  for (const h of merged) {
    let oldCount = 0;
    let newCount = 0;
    let oldStart = 0;
    let newStart = 0;
    {
      let oi = 0;
      let ni = 0;
      for (let k = 0; k < h.start; k++) {
        if (lines[k].op !== 'add') oi++;
        if (lines[k].op !== 'del') ni++;
      }
      oldStart = oi + 1;
      newStart = ni + 1;
    }
    let body = '';
    for (let k = h.start; k <= h.end; k++) {
      const l = lines[k];
      if (l.op === 'eq') {
        body += ` ${l.text}\n`;
        oldCount++;
        newCount++;
      } else if (l.op === 'del') {
        body += `-${l.text}\n`;
        oldCount++;
      } else {
        body += `+${l.text}\n`;
        newCount++;
      }
    }
    out += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}`;
  }
  return out;
}

/**
 * Unified diff parser — structured file/hunk view for PR review (W-F).
 *
 * Pure function, zero dependencies. Parses `git diff` unified output into
 * per-file hunks so the desktop can render a file list and hunk-level
 * diffs without regexing raw text in the UI layer.
 *
 * Honest limits: binary diffs ("Binary files … differ") are surfaced as
 * { binary: true } with no line content; a malformed hunk header ends
 * that file's parsing (the file is still listed with what parsed).
 */

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  /** 1-based old-file line number, null for additions. */
  oldNo: number | null;
  /** 1-based new-file line number, null for deletions. */
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  /** Raw "@@ -a,b +c,d @@" header (plus any trailing section heading). */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Old path ("a/…" stripped); "dev/null" for added files. */
  from: string;
  /** New path ("b/…" stripped); "dev/null" for deleted files. */
  to: string;
  /** 'added' | 'deleted' | 'modified' | 'renamed'. */
  change: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const MAX_FILES = 500;
const MAX_HUNKS_PER_FILE = 200;
const MAX_LINES_PER_HUNK = 5000;

function stripPrefix(p: string): string {
  if (p === '/dev/null' || p === 'dev/null') return 'dev/null';
  return p.replace(/^[ab]\//, '');
}

function newFile(from: string, to: string): DiffFile {
  const f = stripPrefix(from);
  const t = stripPrefix(to);
  const change =
    f === 'dev/null' ? 'added' : t === 'dev/null' ? 'deleted' : f === t ? 'modified' : 'renamed';
  return { from: f, to: t, change, binary: false, hunks: [] };
}

/**
 * Parse unified diff text into structured files/hunks.
 * Never throws on malformed input — it degrades per file.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const pushFile = () => {
    if (cur && files.length < MAX_FILES) files.push(cur);
    cur = null;
    hunk = null;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('diff --git ')) {
      pushFile();
      const m = line.match(/^diff --git (\S+) (\S+)$/);
      cur = newFile(m?.[1] ?? 'a/unknown', m?.[2] ?? 'b/unknown');
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      cur.binary = true;
      continue;
    }
    // ---/+++ carry the added/deleted signal (/dev/null on one side).
    if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4).trim().split('\t')[0]);
      if (p === 'dev/null') {
        cur.from = 'dev/null';
        cur.change = 'added';
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4).trim().split('\t')[0]);
      if (p === 'dev/null') {
        cur.to = 'dev/null';
        cur.change = 'deleted';
      }
      continue;
    }
    const hm = HUNK_RE.exec(line);
    if (hm) {
      if (cur.hunks.length >= MAX_HUNKS_PER_FILE) {
        hunk = null; // cap reached: swallow further hunks of this file
        continue;
      }
      oldNo = Number(hm[1]);
      newNo = Number(hm[3]);
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (hunk.lines.length >= MAX_LINES_PER_HUNK) continue;
    const sigil = line[0];
    if (sigil === ' ') {
      hunk.lines.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    } else if (sigil === '+') {
      hunk.lines.push({ type: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (sigil === '-') {
      hunk.lines.push({ type: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else if (line === '\\ No newline at end of file') {
      // marker only — attach to previous line implicitly by ignoring
      continue;
    } else {
      // Not a diff body line (e.g. "index …" / "new file mode …") — ignore.
      continue;
    }
  }
  pushFile();
  return { files };
}

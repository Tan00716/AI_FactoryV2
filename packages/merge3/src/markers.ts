/**
 * Conflict-marker parsing (<<<<<<< / ======= / >>>>>>>).
 *
 * Rules (fail-closed):
 *  - markers must start at column 0;
 *  - a hunk needs opener, separator and closer in order;
 *  - an unterminated hunk or a stray separator/closer is a parse error;
 *  - diff3-style markers (||||||| base section) are NOT supported and
 *    are reported honestly instead of being silently misread.
 */
import { Merge3Error, type ConflictHunk } from './types.js';

function openerLabel(line: string): { label: string | null } | null {
  if (!line.startsWith('<<<<<<<')) return null;
  const rest = line.slice(7);
  if (rest !== '' && !/^[ \t]/.test(rest)) return null;
  const label = rest.trim();
  return { label: label === '' ? null : label };
}

function isSeparator(line: string): boolean {
  return line.startsWith('=======') && line.slice(7).trim() === '';
}

function closerLabel(line: string): { label: string | null } | null {
  if (!line.startsWith('>>>>>>>')) return null;
  const rest = line.slice(7);
  if (rest !== '' && !/^[ \t]/.test(rest)) return null;
  const label = rest.trim();
  return { label: label === '' ? null : label };
}

function isDiff3Base(line: string): boolean {
  return line.startsWith('|||||||');
}

/**
 * Parse all conflict hunks from working-file lines.
 * Throws Merge3Error on malformed marker sequences.
 */
export function parseConflictMarkers(lines: string[]): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const opener = openerLabel(lines[i]);
    if (opener === null) {
      i += 1;
      continue;
    }
    const startLine = i;
    i += 1;
    const ours: string[] = [];
    const theirs: string[] = [];
    let midLine = -1;
    let inTheirs = false;
    let closedAt = -1;
    let closer: { label: string | null } | null = null;
    for (; i < lines.length; i += 1) {
      const line = lines[i];
      if (isDiff3Base(line)) {
        throw new Merge3Error(
          `diff3-style conflict markers (|||||||) are not supported (line ${i + 1}); ` +
            `resolve manually or set merge.conflictstyle=merge`,
          'diff3-markers-unsupported',
        );
      }
      if (!inTheirs && isSeparator(line)) {
        midLine = i;
        inTheirs = true;
        continue;
      }
      if (inTheirs) {
        const c = closerLabel(line);
        if (c !== null) {
          closer = c;
          closedAt = i;
          break;
        }
        theirs.push(line);
      } else {
        if (openerLabel(line) !== null) {
          throw new Merge3Error(
            `nested conflict marker inside hunk starting at line ${startLine + 1}`,
            'nested-markers',
          );
        }
        ours.push(line);
      }
    }
    if (closedAt === -1) {
      throw new Merge3Error(
        `unterminated conflict hunk starting at line ${startLine + 1}`,
        'unterminated-hunk',
      );
    }
    hunks.push({
      index: hunks.length,
      startLine,
      midLine,
      endLine: closedAt,
      oursLabel: opener.label,
      theirsLabel: closer!.label,
      ours,
      theirs,
    });
    i = closedAt + 1;
  }
  return hunks;
}

/** True when the text contains at least one marker opener. */
export function hasConflictMarkers(lines: string[]): boolean {
  return lines.some((l) => openerLabel(l) !== null);
}

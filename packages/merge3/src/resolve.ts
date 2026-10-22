/**
 * Apply per-hunk resolutions to a marker-bearing working file.
 *
 * applyResolutions(workingLines, hunks, resolutions):
 *   - every hunk must have exactly one resolution (fail-closed);
 *   - choice 'ours' / 'theirs' / 'both' (ours then theirs) / 'custom'
 *     (customText, non-empty);
 *   - replaces workingLines[startLine..endLine] with the chosen lines.
 *
 * Pure function: no I/O, no git. The caller handles drift checks,
 * checkpoints and writes.
 */
import { Merge3Error, type ConflictHunk, type HunkResolution, type ResolutionChoice } from './types.js';

const VALID_CHOICES: ReadonlySet<string> = new Set(['ours', 'theirs', 'both', 'custom']);

function chosenLines(
  hunk: ConflictHunk,
  choice: ResolutionChoice,
  customText: string | undefined,
): string[] {
  switch (choice) {
    case 'ours':
      return [...hunk.ours];
    case 'theirs':
      return [...hunk.theirs];
    case 'both':
      return [...hunk.ours, ...hunk.theirs];
    case 'custom': {
      if (typeof customText !== 'string' || customText.length === 0) {
        throw new Merge3Error(
          `hunk ${hunk.index}: custom resolution requires non-empty customText`,
          'custom-text-required',
        );
      }
      return customText.split('\n');
    }
    default:
      throw new Merge3Error(`hunk ${hunk.index}: unknown choice '${choice}'`, 'bad-choice');
  }
}

export function applyResolutions(
  workingLines: string[],
  hunks: ConflictHunk[],
  resolutions: HunkResolution[],
): string[] {
  if (!Array.isArray(resolutions)) {
    throw new Merge3Error('resolutions must be an array', 'bad-resolutions');
  }
  const byHunk = new Map<number, HunkResolution>();
  for (const r of resolutions) {
    if (typeof r?.hunk !== 'number' || !VALID_CHOICES.has(r.choice)) {
      throw new Merge3Error(
        `invalid resolution entry: ${JSON.stringify(r).slice(0, 120)}`,
        'bad-resolution-entry',
      );
    }
    if (byHunk.has(r.hunk)) {
      throw new Merge3Error(`duplicate resolution for hunk ${r.hunk}`, 'duplicate-resolution');
    }
    byHunk.set(r.hunk, r);
  }
  for (const h of hunks) {
    if (!byHunk.has(h.index)) {
      throw new Merge3Error(`missing resolution for hunk ${h.index}`, 'missing-resolution');
    }
  }

  // Replace back-to-front so earlier line numbers stay valid.
  const out = [...workingLines];
  const ordered = [...hunks].sort((a, b) => b.startLine - a.startLine);
  for (const h of ordered) {
    const r = byHunk.get(h.index)!;
    const chosen = chosenLines(h, r.choice, r.customText);
    out.splice(h.startLine, h.endLine - h.startLine + 1, ...chosen);
  }
  return out;
}

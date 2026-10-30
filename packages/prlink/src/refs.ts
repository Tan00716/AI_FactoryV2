/**
 * Local reference parsing (round-7 task R7-#6).
 *
 * Recognized forms, in first-seen order, deduplicated by (repo, number):
 *   - `owner/repo#123`  -> repo present
 *   - `#123`            -> repo absent (resolved later against a default
 *                          repo, or left unscoped — never guessed)
 *
 * Deliberately NOT recognized: bare numbers without `#`, `PR-123`
 * (ambiguous with ticket systems), and `#` inside a URL path (the
 * repo-form match consumes the whole `owner/repo#123` span, and bare
 * matches inside that span are skipped by range exclusion).
 */
import { PrLinkError, type LinkedReference } from './types';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validateRepoSlug(repo: string): void {
  if (!REPO_PATTERN.test(repo)) {
    throw new PrLinkError('bad-repo', `invalid repo slug: ${repo}`);
  }
}

export function validateNumber(number: number): void {
  if (!Number.isInteger(number) || number < 1 || number > 999_999_999) {
    throw new PrLinkError('bad-number', `invalid issue/PR number: ${number}`);
  }
}

const REPO_FORM = /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)/g;
const BARE_FORM = /#(\d+)/g;

function inRanges(pos: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => pos >= start && pos < end);
}

/**
 * Extract references from one piece of text (a branch name or a commit
 * subject). `source` tags where the reference was found; it does not
 * change the parse.
 */
export function extractReferences(text: string, source: LinkedReference['source']): LinkedReference[] {
  const found: LinkedReference[] = [];
  const seen = new Set<string>();
  const repoRanges: Array<[number, number]> = [];
  const candidates: Array<{ index: number; ref: LinkedReference }> = [];
  for (const m of text.matchAll(REPO_FORM)) {
    const repo = m[1] as string;
    const number = Number(m[2]);
    if (!REPO_PATTERN.test(repo) || number < 1) continue;
    const key = `${repo}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    repoRanges.push([m.index, m.index + m[0].length]);
    candidates.push({ index: m.index, ref: { number, repo, source } });
  }
  for (const m of text.matchAll(BARE_FORM)) {
    if (inRanges(m.index, repoRanges)) continue;
    const number = Number(m[1]);
    if (number < 1) continue;
    const key = `#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ index: m.index, ref: { number, source } });
  }
  candidates.sort((a, b) => a.index - b.index);
  for (const c of candidates) found.push(c.ref);
  return found;
}

/** Merge reference lists, deduplicated by (repo ?? '', number), first-seen order. */
export function mergeReferences(lists: LinkedReference[][]): LinkedReference[] {
  const seen = new Set<string>();
  const out: LinkedReference[] = [];
  for (const list of lists) {
    for (const ref of list) {
      const key = `${ref.repo ?? ''}#${ref.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}

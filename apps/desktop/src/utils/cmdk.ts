/**
 * Command palette matching helpers (Cmd+K). Pure module — no React, no DOM —
 * so node:test can import it directly (same reason as utils/scrub.ts).
 */

/** A flattened agent entry for palette search. */
export interface PaletteAgent {
  id: string;
  displayName: string;
  jobTitle: string;
}

/** Minimal org-node shape (mirrors api.ts OrgNode without importing it). */
export interface OrgNodeLike {
  agent: { id: string; displayName: string; jobTitle: string };
  children: OrgNodeLike[];
}

/** Recursively flatten an org tree into a plain agent list. */
export function flattenAgents(nodes: OrgNodeLike[]): PaletteAgent[] {
  const out: PaletteAgent[] = [];
  const walk = (ns: OrgNodeLike[]) => {
    for (const n of ns) {
      if (n.agent) {
        out.push({
          id: n.agent.id,
          displayName: n.agent.displayName,
          jobTitle: n.agent.jobTitle ?? '',
        });
      }
      if (n.children && n.children.length > 0) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function isBoundary(prev: string, curr: string): boolean {
  if (prev === '') return true;
  if (/[\s\-_\/.:]/.test(prev)) return true;
  // camelCase boundary: lower -> Upper (uses original-case chars)
  return /[a-z]/.test(prev) && /[A-Z]/.test(curr);
}

/**
 * Subsequence fuzzy score. Returns null when the query's characters do not
 * appear in the target in order. Higher score = better match.
 * Scoring: +1 per matched char, +4 at word/camel boundaries, growing bonus
 * for consecutive runs, +6 when the match starts at the target start.
 * Empty/blank query scores 0 (matches everything, used for the unfiltered list).
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  if (q.trim() === '') return 0;
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let consecRun = 0;
  let prevIdx = -2;
  let firstIdx = -1;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      if (firstIdx < 0) firstIdx = i;
      let bonus = 1;
      if (isBoundary(i === 0 ? '' : target[i - 1], target[i])) bonus += 4;
      if (prevIdx === i - 1) {
        consecRun += 1;
        bonus += consecRun * 2;
      } else {
        consecRun = 0;
      }
      score += bonus;
      prevIdx = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  if (firstIdx === 0) score += 6;
  // Slight preference for shorter targets so "Git" beats "Git something long".
  score -= t.length * 0.01;
  return score;
}

/** Rank candidate search-texts against a query; returns indices best-first. */
export function rankMatches(query: string, searchTexts: string[]): number[] {
  const scored: Array<{ idx: number; score: number }> = [];
  for (let idx = 0; idx < searchTexts.length; idx++) {
    const s = fuzzyScore(query, searchTexts[idx]);
    if (s !== null) scored.push({ idx, score: s });
  }
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.map((e) => e.idx);
}

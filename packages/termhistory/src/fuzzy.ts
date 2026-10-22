/**
 * Fuzzy subsequence matcher (R4-A8) for command-history search.
 * Case-insensitive; scores reward consecutive runs and word-boundary
 * hits, penalize length. Returns null when the query is not a
 * subsequence of the target.
 */
function isWordBoundary(ch: string): boolean {
  return (
    ch === ' ' ||
    ch === '/' ||
    ch === '-' ||
    ch === '_' ||
    ch === '.' ||
    ch === ':' ||
    ch === '"' ||
    ch === "'" ||
    ch === '=' ||
    ch === '|'
  );
}

export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return 0;
  if (q.length > t.length) return null;
  let qi = 0;
  let score = 0;
  let run = 0;
  let prevTi = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      run = 0;
      continue;
    }
    let bonus = 10;
    if (ti === prevTi + 1) {
      run += 1;
      bonus += run * 12; // consecutive-run bonus (beats scattered hits)
    } else {
      run = 0;
    }
    if (ti === 0 || isWordBoundary(t[ti - 1])) bonus += 8;
    // early-in-target bonus (match position matters for history UX)
    if (ti < 8) bonus += 8 - ti;
    score += bonus;
    prevTi = ti;
    qi++;
  }
  if (qi < q.length) return null;
  score -= Math.max(0, t.length - q.length) * 0.4; // shorter targets win ties
  return score;
}

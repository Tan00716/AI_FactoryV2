/**
 * @ai-factory/depscan — minimal, deterministic semver engine.
 *
 * HONEST BOUNDARY: this is a pragmatic subset, not the full npm semver
 * grammar. Supported range atoms: exact ('1.2.3'), caret ('^1.2.3'),
 * tilde ('~1.2.3'), comparators ('>=1.2.3', '<2.0.0', ...), wildcard
 * ('*', 'x', ''). Unsupported atoms (hyphen ranges, '||', 'latest' tags,
 * dist-tags) make maxSatisfying return null instead of guessing.
 * Everything here is pure: no network, no clock, no randomness.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  raw: string;
}

const NUMERIC_ID_RE = /^\d+$/;

export function parseSemver(v: string): SemVer | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    v.trim(),
  );
  if (!m) return null;
  const prerelease = m[4] ? m[4].split('.') : [];
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? '0'),
    patch: Number(m[3] ?? '0'),
    prerelease,
    raw: v.trim(),
  };
}

/** -1 | 0 | 1. Release > prerelease; prerelease identifiers compare per semver-ish rules. */
export function compareSemver(a: SemVer, b: SemVer): number {
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1;
  if (bp.length === 0) return -1;
  const n = Math.max(ap.length, bp.length);
  for (let i = 0; i < n; i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = NUMERIC_ID_RE.test(x);
    const yn = NUMERIC_ID_RE.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function compareSemverStrings(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  return compareSemver(pa, pb);
}

export type DiffKind = 'none' | 'patch' | 'minor' | 'major' | 'prerelease' | 'downgrade';

/** Classify the jump from `from` to `to`. Null when either side is unparseable. */
export function diffKind(from: string, to: string): DiffKind | null {
  const pf = parseSemver(from);
  const pt = parseSemver(to);
  if (!pf || !pt) return null;
  const c = compareSemver(pf, pt);
  if (c === 0) return 'none';
  if (c > 0) return 'downgrade';
  if (pf.major !== pt.major) return 'major';
  if (pf.minor !== pt.minor) return 'minor';
  if (pf.patch !== pt.patch) return 'patch';
  return 'prerelease';
}

interface Comparator {
  op: '<' | '<=' | '>' | '>=' | '=';
  ver: SemVer;
}

/**
 * Parse a range into ANDed comparators. Returns null for unsupported
 * syntax (never throws). Supported: exact, ^, ~, comparators, *, x, ''.
 */
function parseRange(range: string): { comparators: Comparator[]; hasPrerelease: boolean } | null {
  const r = range.trim();
  if (r === '' || r === '*' || r.toLowerCase() === 'x') {
    return { comparators: [], hasPrerelease: false };
  }
  const comparators: Comparator[] = [];
  let hasPrerelease = false;
  const atoms = r.split(/\s+/).filter(Boolean);
  for (const atom of atoms) {
    let body = atom;
    let caret = false;
    let tilde = false;
    if (body.startsWith('^')) {
      caret = true;
      body = body.slice(1);
    } else if (body.startsWith('~')) {
      tilde = true;
      body = body.slice(1);
    }
    let op: Comparator['op'] = '=';
    const opMatch = /^(<=|>=|<|>|=)?(.*)$/.exec(body);
    if (!opMatch) return null;
    if (opMatch[1]) {
      if (caret || tilde) return null; // '^'/'~' do not combine with comparators
      op = opMatch[1] as Comparator['op'];
      body = opMatch[2];
    } else if (!caret && !tilde) {
      body = opMatch[2];
    }
    if (body === '' || body.toLowerCase() === 'x' || body === '*') {
      continue; // wildcard atom inside a range: no constraint
    }
    const ver = parseSemver(body);
    if (!ver) return null;
    if (ver.prerelease.length > 0) hasPrerelease = true;
    if (caret) {
      // ^1.2.3 := >=1.2.3 <2.0.0 ; ^0.2.3 := >=0.2.3 <0.3.0 ; ^0.0.3 := >=0.0.3 <0.0.4
      comparators.push({ op: '>=', ver });
      const upper: SemVer =
        ver.major > 0
          ? { ...ver, major: ver.major + 1, minor: 0, patch: 0, prerelease: [] }
          : ver.minor > 0
            ? { ...ver, minor: ver.minor + 1, patch: 0, prerelease: [] }
            : { ...ver, patch: ver.patch + 1, prerelease: [] };
      comparators.push({ op: '<', ver: upper });
    } else if (tilde) {
      // ~1.2.3 := >=1.2.3 <1.3.0
      comparators.push({ op: '>=', ver });
      comparators.push({
        op: '<',
        ver: { ...ver, minor: ver.minor + 1, patch: 0, prerelease: [] },
      });
    } else {
      comparators.push({ op, ver });
    }
  }
  return { comparators, hasPrerelease };
}

/**
 * Highest version satisfying the range, or null when the range is
 * unsupported / nothing satisfies it. Deterministic.
 */
export function maxSatisfying(versions: string[], range: string): string | null {
  const parsed = parseRange(range);
  if (!parsed) return null;
  let best: SemVer | null = null;
  for (const v of versions) {
    const sv = parseSemver(v);
    if (!sv) continue;
    // Prereleases only count when the range itself mentions a prerelease.
    if (sv.prerelease.length > 0 && !parsed.hasPrerelease) continue;
    let ok = true;
    for (const c of parsed.comparators) {
      const cmp = compareSemver(sv, c.ver);
      switch (c.op) {
        case '<':
          ok = cmp < 0;
          break;
        case '<=':
          ok = cmp <= 0;
          break;
        case '>':
          ok = cmp > 0;
          break;
        case '>=':
          ok = cmp >= 0;
          break;
        case '=':
          ok = cmp === 0;
          break;
      }
      if (!ok) break;
    }
    if (ok && (!best || compareSemver(sv, best) > 0)) best = sv;
  }
  return best ? best.raw : null;
}

/** Highest version in the list, or null when none parse. */
export function maxVersion(versions: string[]): string | null {
  let best: SemVer | null = null;
  for (const v of versions) {
    const sv = parseSemver(v);
    if (!sv) continue;
    if (sv.prerelease.length > 0) continue; // 'latest' never points at a prerelease
    if (!best || compareSemver(sv, best) > 0) best = sv;
  }
  return best ? best.raw : null;
}

/**
 * @ai-factory/depscan — upgrade-plan builder (pure, deterministic).
 *
 * Given resolved installed deps + registry metadata, produces per-dep
 * advice graded patch/minor/major, CVE cross-reference hits, and a
 * copy-pasteable upgrade plan. No network, no clock inside the grading
 * path (generatedAt is stamped by the caller/route).
 */
import { compareSemverStrings, diffKind, maxSatisfying } from './semver';
import type {
  CveHit,
  CveMatcher,
  DepAdvice,
  InstalledDep,
  RegistryMeta,
  UpgradeGrade,
  UpgradePlan,
} from './types';

export interface AdviseOptions {
  /** Optional CVE matcher (injected by the server from the offline snapshot). */
  cveMatcher?: CveMatcher | null;
  generatedAt?: string;
  registrySource?: string;
  snapshotDate?: string | null;
}

function gradeOf(current: string, latest: string | null): UpgradeGrade {
  if (!latest) return 'unknown';
  const d = diffKind(current, latest);
  if (d === null) return 'unknown';
  if (d === 'none') return 'up-to-date';
  return d;
}

/**
 * Build the upgrade plan. Deterministic: advisories are sorted by name,
 * commands list safe upgrades (patch/minor) before review-first ones.
 */
export function buildUpgradePlan(
  installed: InstalledDep[],
  registry: Map<string, RegistryMeta>,
  opts: AdviseOptions = {},
): UpgradePlan {
  const advisories: DepAdvice[] = installed.map((dep) => {
    const meta = registry.get(dep.name) ?? null;
    const latest = meta ? meta.latest : null;
    const wanted =
      meta && meta.versions.length > 0 ? maxSatisfying(meta.versions, dep.declaredRange) : null;
    const grade = gradeOf(dep.current, latest);
    let cves: CveHit[] = [];
    if (opts.cveMatcher) {
      try {
        cves = opts.cveMatcher(dep.name, dep.current) ?? [];
      } catch {
        cves = [];
      }
    }
    const reviewFirst = grade === 'major' || cves.length > 0;
    return {
      name: dep.name,
      current: dep.current,
      declaredRange: dep.declaredRange,
      dev: dep.dev,
      wanted,
      latest,
      grade,
      changelogUrl: meta?.changelogUrl,
      cves,
      reviewFirst,
    };
  });

  advisories.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // "wanted" (in-range) bumps are safe to apply blindly; "latest" jumps
  // that cross minor/major go through the plan with review flags.
  const safe: string[] = [];
  const review: string[] = [];
  for (const a of advisories) {
    if (a.grade === 'up-to-date' || a.grade === 'unknown' || !a.latest) continue;
    const cmd = `npm install ${a.dev ? '-D ' : ''}${a.name}@${a.latest}`;
    if (a.reviewFirst) review.push(cmd);
    else safe.push(cmd);
  }
  const commands = [...safe, ...review];

  const summary = {
    total: advisories.length,
    upToDate: 0,
    patch: 0,
    minor: 0,
    major: 0,
    unknown: 0,
    cveAffected: 0,
  };
  for (const a of advisories) {
    if (a.grade === 'up-to-date') summary.upToDate++;
    else if (a.grade === 'patch') summary.patch++;
    else if (a.grade === 'minor') summary.minor++;
    else if (a.grade === 'major') summary.major++;
    else summary.unknown++;
    if (a.cves.length > 0) summary.cveAffected++;
  }

  return {
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    registrySource: opts.registrySource ?? 'bundled-snapshot',
    snapshotDate: opts.snapshotDate ?? null,
    advisories,
    commands,
    summary,
  };
}

/**
 * Sort helper for "most urgent first" UIs: CVE-affected, then major,
 * minor, patch, unknown, up-to-date. Pure.
 */
export function urgencyRank(a: DepAdvice): number {
  if (a.cves.length > 0) return 0;
  switch (a.grade) {
    case 'major':
      return 1;
    case 'minor':
      return 2;
    case 'patch':
      return 3;
    case 'prerelease':
      return 4;
    case 'downgrade':
      return 4;
    case 'unknown':
      return 5;
    case 'up-to-date':
      return 6;
  }
}

export { compareSemverStrings };

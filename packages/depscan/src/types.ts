/**
 * @ai-factory/depscan — shared types for the dependency upgrade advisor.
 *
 * All data is plain JSON; every function in this package is deterministic
 * (no network, no clock reads inside the grading path) and needs no model key.
 */

/** One advisory hit from the (offline) CVE snapshot. */
export interface CveHit {
  /** Advisory id, e.g. 'CVE-2020-8203'. */
  id: string;
  /** 'error' | 'warning' severity from the snapshot. */
  severity: string;
  note?: string;
}

/** Registry metadata for one package (bundled snapshot or live fetch). */
export interface RegistryMeta {
  name: string;
  /** All known versions, ascending. */
  versions: string[];
  /** Newest known version. */
  latest: string;
  /** CHANGELOG / release-notes URL, when known. */
  changelogUrl?: string;
}

/** An installed dependency as resolved from package.json + lockfile. */
export interface InstalledDep {
  name: string;
  /** Resolved installed version (from the lockfile; falls back to the declared range when no lockfile). */
  current: string;
  /** Declared range from package.json, e.g. '^4.17.20'. */
  declaredRange: string;
  dev: boolean;
}

/** Safety grade of the available upgrade. */
export type UpgradeGrade =
  | 'up-to-date'
  | 'patch'
  | 'minor'
  | 'major'
  | 'prerelease'
  | 'downgrade'
  | 'unknown';

/** Per-dependency advice line. */
export interface DepAdvice {
  name: string;
  current: string;
  declaredRange: string;
  dev: boolean;
  /** Max version satisfying the declared range (npm-outdated "wanted"). Null when the range is unsupported or nothing satisfies it. */
  wanted: string | null;
  /** Newest known version. Null when the package is unknown to the registry source. */
  latest: string | null;
  grade: UpgradeGrade;
  changelogUrl?: string;
  /** CVE snapshot hits against the *installed* version. */
  cves: CveHit[];
  /** True when the upgrade crosses a major boundary or the installed version has CVE hits: review before applying. */
  reviewFirst: boolean;
}

/** The whole upgrade plan. */
export interface UpgradePlan {
  generatedAt: string;
  /** Where the registry metadata came from: bundled snapshot date or 'live'. */
  registrySource: string;
  snapshotDate: string | null;
  advisories: DepAdvice[];
  /** Copy-pasteable upgrade commands, majors/CVE-affected last. */
  commands: string[];
  summary: {
    total: number;
    upToDate: number;
    patch: number;
    minor: number;
    major: number;
    unknown: number;
    cveAffected: number;
  };
}

/** CVE matcher signature; the server injects the real one (built from the
 * hand-maintained blacklist snapshot in apps/server/src/inspections.ts). */
export type CveMatcher = (name: string, version: string) => CveHit[];

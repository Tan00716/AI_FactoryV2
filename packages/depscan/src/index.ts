/**
 * @ai-factory/depscan — deterministic dependency upgrade advisor.
 *
 * Modules:
 *  - types     shared types (RegistryMeta, InstalledDep, DepAdvice, UpgradePlan)
 *  - semver    minimal deterministic semver engine (parse/compare/diff/maxSatisfying)
 *  - advise    upgrade-plan builder: semver safety grading + CVE cross-ref + plan commands
 *  - registry  metadata providers: bundled offline snapshot (default) + live npm (opt-in, fail-closed)
 *
 * Honest boundaries: the semver engine covers a pragmatic subset of the npm
 * range grammar (exact/^/~/comparators/wildcards); hyphen ranges, '||' and
 * dist-tags are unsupported and yield 'unknown' instead of guesses. The
 * bundled snapshot lags the real registry and covers only a small package
 * set; snapshot date is disclosed in every report.
 */
export * from './types';
export * from './semver';
export * from './advise';
export * from './registry';

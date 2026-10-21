/**
 * Repeated-run aggregation + statistical latency comparison — R3-T4.
 *
 * Upgrades the baseline diff from "single value vs single value" to
 * "sample set vs sample set" (mean / median / approx 95% CI), Criterion.rs
 * style. Regression is only called when the slowdown is *statistically
 * significant* (non-overlapping approximate 95% confidence intervals),
 * never on a single noisy measurement.
 *
 * Honest boundaries (inherited from report.ts):
 * - a statistically significant latency slowdown is a WARNING, never a
 *   CI gate failure — wall-clock timings are environment-sensitive;
 * - only success regressions (pass → fail) fail the gate.
 *
 * Pure node builtins + type-only imports — no dependencies, no models.
 */
import type { AggregateStats, CaseResult } from './types';

/** z-value for the (approximate) two-sided 95% interval. */
const Z95 = 1.96;

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Sample standard deviation (n-1); 0 for n < 2. */
export function sampleStddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function aggregate(values: number[]): AggregateStats {
  const n = values.length;
  if (n === 0) {
    return { n: 0, mean: 0, median: 0, stddev: 0, ci95: [0, 0], min: 0, max: 0 };
  }
  const m = mean(values);
  const sd = sampleStddev(values);
  const half = n < 2 ? 0 : (Z95 * sd) / Math.sqrt(n);
  return {
    n,
    mean: m,
    median: median(values),
    stddev: sd,
    ci95: [m - half, m + half],
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * Merge n repeated runs of the same case into one representative result.
 * - pass requires every run to pass (a single failure is already a
 *   gate-failing success regression elsewhere; here it must not be
 *   averaged away);
 * - latencyMs is the rounded mean; the raw samples are kept in
 *   latencySamples for the statistical comparison;
 * - outcome is the mode (ties → the earliest run wins);
 * - failReasons are de-duplicated preserving first-seen order.
 */
export function aggregateCaseRuns(runs: CaseResult[]): CaseResult {
  if (runs.length === 0) throw new Error('aggregateCaseRuns: need at least one run');
  const first = runs[0];
  const latencySamples = runs.map((r) => r.latencyMs);
  const stats = aggregate(latencySamples);
  const avg = (pick: (r: CaseResult) => number): number =>
    Math.round(mean(runs.map(pick)));
  const outcomeCounts = new Map<string, number>();
  for (const r of runs) outcomeCounts.set(r.outcome, (outcomeCounts.get(r.outcome) ?? 0) + 1);
  let outcome = first.outcome;
  let best = -1;
  for (const r of runs) {
    const c = outcomeCounts.get(r.outcome)!;
    if (c > best) {
      best = c;
      outcome = r.outcome;
    }
  }
  const failReasons: string[] = [];
  for (const r of runs) {
    for (const fr of r.failReasons) {
      if (!failReasons.includes(fr)) failReasons.push(fr);
    }
  }
  return {
    caseId: first.caseId,
    name: first.name,
    adapter: first.adapter,
    pass: runs.every((r) => r.pass),
    outcome,
    expectedOutcome: first.expectedOutcome,
    failReasons,
    latencyMs: Math.round(stats.mean),
    latencySamples,
    steps: avg((r) => r.steps),
    modelCalls: avg((r) => r.modelCalls),
    toolCalls: avg((r) => r.toolCalls),
    tokenEstimate: avg((r) => r.tokenEstimate),
    tokenEstimateMethod: first.tokenEstimateMethod,
  };
}

/**
 * Is the current sample set significantly slower than the baseline set?
 *
 * Rule: both sides need ≥2 samples; the current run counts as a
 * significant slowdown when the approximate 95% CIs do not overlap and
 * the current mean is higher. With tiny n the intervals are wide, so
 * ordinary environment jitter does not trigger it. Returns false for
 * n < 2 on either side (callers fall back to the fractional-tolerance
 * rule for single measurements).
 */
export function significantSlowdown(base: number[], cur: number[]): boolean {
  if (base.length < 2 || cur.length < 2) return false;
  const b = aggregate(base);
  const c = aggregate(cur);
  return c.mean > b.mean && c.ci95[0] > b.ci95[1];
}

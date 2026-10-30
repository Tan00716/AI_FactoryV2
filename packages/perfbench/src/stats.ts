/** Small latency statistics helpers (pure, tested). */

export function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Nearest-rank percentile (p in 0..100). Empty input -> 0. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = sorted(values);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[rank - 1] as number;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface LatencySummary {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

export function summarize(values: number[]): LatencySummary {
  if (values.length === 0) {
    return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0 };
  }
  const s = sorted(values);
  return {
    count: values.length,
    meanMs: mean(values),
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    minMs: s[0] as number,
    maxMs: s[s.length - 1] as number,
  };
}

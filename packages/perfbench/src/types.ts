/**
 * @ai-factory/perfbench — shared types for the IDE performance suite.
 *
 * Conventions (documented so a future gate change stays honest):
 * - Every timed task reports `ms` (wall clock, lower is better). Extra
 *   metrics go in `value` + `unit` (e.g. files/sec) or `p50Ms`/`p95Ms`
 *   for sampled latencies. The gate only compares `ms`.
 * - `skipped` tasks carry a `skipReason` and never fail a gate.
 * - Results are SYNTHETIC by default: the repo under test is generated
 *   from a fixed seed, not a real user project. `synthetic: true` and
 *   the seed are recorded on every report so a number is never mistaken
 *   for a real-repo measurement.
 */

export interface PerfTaskResult {
  task: string;
  /** Wall-clock milliseconds (lower is better). */
  ms: number;
  /** Optional throughput-style metric, e.g. files/sec. */
  value?: number;
  unit?: string;
  /** Per-operation latency samples in ms (sqlite task). */
  samples?: number[];
  p50Ms?: number;
  p95Ms?: number;
  meta?: Record<string, string | number | boolean>;
  skipped?: boolean;
  skipReason?: string;
}

export interface PerfEnv {
  node: string;
  platform: string;
  arch: string;
  cpus: number;
  totalMemMb: number;
  gitRev: string | null;
}

export interface PerfResult {
  tool: '@ai-factory/perfbench';
  version: string;
  generatedAt: string;
  /** Fixed seed for the synthetic repo; -1 when no synthetic repo ran. */
  seed: number;
  synthetic: boolean;
  /** 'small' (1k files), 'medium' (10k), 'large' (100k), or 'mixed'. */
  scale: string;
  env: PerfEnv;
  tasks: PerfTaskResult[];
  notes: string[];
}

/** A baseline is a past PerfResult, stored as JSON under baselines/. */
export type PerfBaseline = PerfResult;

export type GateMode = 'warn' | 'block';

export interface GateConfig {
  /** Regression threshold in percent; default 20. */
  thresholdPct: number;
  mode: GateMode;
}

export interface GateItem {
  task: string;
  baselineMs: number;
  currentMs: number;
  changePct: number;
  regressed: boolean;
}

export interface GateVerdict {
  mode: GateMode;
  thresholdPct: number;
  /** False only in block mode when a regression is found. */
  passed: boolean;
  warnings: string[];
  failures: string[];
  items: GateItem[];
  noBaseline: boolean;
}

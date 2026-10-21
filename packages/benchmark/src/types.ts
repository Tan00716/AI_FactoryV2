/**
 * Benchmark harness types — task 10 (model quality baseline framework).
 *
 * A benchmark case is a fully scripted agent run with a deterministic
 * pass/fail verdict: the expected terminal outcome plus optional
 * evidence-type checks. No LLM judge is involved — verdicts are machine
 * checkable, so the harness doubles as a CI regression gate.
 */
import type { AdapterOutput, ToolImpl } from '@ai-factory/runtime';
import type { Permission } from '@ai-factory/core';
import type { ExtendedBudgets } from '@ai-factory/runtime';

/** Terminal outcomes the harness can assert on. */
export type ExpectedOutcome = 'completed' | 'failed' | 'escalated';

export interface BenchmarkCaseAgent {
  name: string;
  jobTitle: string;
  mission: string;
  tools: string[];
  permissions: Permission[];
}

export interface BenchmarkCaseTask {
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  constraints?: string[];
}

export interface BenchmarkCase {
  /** Stable id, used as the baseline key. Never rename once baselined. */
  id: string;
  name: string;
  description: string;
  agent: BenchmarkCaseAgent;
  task: BenchmarkCaseTask;
  /**
   * Scripted adapter responses for the stub adapter, replayed in order.
   * Ignored by real adapters (e.g. codex), where the model drives the run.
   */
  stubScript: AdapterOutput[];
  /**
   * Factory for the tool implementations available to the run. A factory
   * (not a shared record) so stateful tools (e.g. fail-once) behave
   * identically on every run, including repeated runs in one process.
   */
  makeTools: () => Record<string, ToolImpl>;
  expectOutcome: ExpectedOutcome;
  /**
   * Evidence `type` values that must appear in the run evidence for the
   * case to pass (e.g. 'tool_result'). Deterministic, no LLM involved.
   */
  expectEvidenceTypes?: string[];
  /**
   * Strings that must NOT appear verbatim in any prompt actually sent to
   * the model (checked per invoke()). This pins the §72 quarantine at the
   * harness level: the internal trace may still record the raw goal for
   * observability, but the model must never see the directive verbatim.
   */
  forbidVerbatim?: string[];
  /**
   * Expected exact step count (optional). Pins meaningful multi-cycle
   * behavior (e.g. flaky-tool-retries must take exactly 2 cycles = 12
   * steps: fail → loop-level retry → succeed). Leave unset for cases
   * where only the outcome matters; steps are still recorded in the
   * baseline for drift notes.
   */
  expectSteps?: number;
  /** Per-case wall-clock budget; exceeding it fails the case. */
  timeoutMs?: number;
  /**
   * Tool → permission mapping overrides for the harness. Custom tool names
   * (echo, step, …) are not in the harness DEFAULT_TOOL_PERMISSIONS and
   * would be default-denied; map them here so the tool actually executes.
   */
  toolPermissions?: Record<string, Permission>;
  /** Extended budget overrides forwarded to runAgent (e.g. to force exhaustion). */
  extendedBudgets?: Partial<ExtendedBudgets>;
}

export interface CaseResult {
  caseId: string;
  name: string;
  adapter: string;
  pass: boolean;
  outcome: string;
  expectedOutcome: ExpectedOutcome;
  failReasons: string[];
  latencyMs: number;
  /**
   * Per-run wall-clock latencies when the case was executed more than
   * once (`--runs n`). Absent (or length < 2) = single measurement.
   */
  latencySamples?: number[];
  steps: number;
  modelCalls: number;
  toolCalls: number;
  /** Heuristic token estimate — see estimateTokens() for the method. */
  tokenEstimate: number;
  tokenEstimateMethod: string;
}

export interface BenchmarkSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  totalTokenEstimate: number;
}

export interface BenchmarkReport {
  generatedAt: string;
  adapter: string;
  appVersion: string;
  cases: CaseResult[];
  summary: BenchmarkSummary;
}

/** One baseline entry per case id. */
export interface BaselineCaseEntry {
  pass: boolean;
  latencyMs: number;
  /**
   * Per-run wall-clock latencies recorded with `--runs n`. Older
   * baselines (single measurement) omit this; comparison then falls
   * back to the fractional-tolerance rule.
   */
  latencySamples?: number[];
  steps: number;
  modelCalls: number;
  toolCalls: number;
  tokenEstimate: number;
}

/**
 * Aggregate statistics over repeated runs of one case (R3-T4).
 * The 95% interval is a normal approximation (z=1.96), not a bootstrap —
 * documented as approximate. With tiny n the interval is wide, so
 * environment jitter does not register as a regression.
 */
export interface AggregateStats {
  n: number;
  mean: number;
  median: number;
  stddev: number;
  /** Approximate 95% confidence interval [lo, hi] (normal approximation). */
  ci95: [number, number];
  min: number;
  max: number;
}

export interface Baseline {
  adapter: string;
  generatedAt: string;
  appVersion: string;
  cases: Record<string, BaselineCaseEntry>;
}

export interface CaseDiff {
  caseId: string;
  status: 'regression' | 'fixed' | 'unchanged' | 'new' | 'removed';
  /** Human-readable notes (latency moved > tolerance, steps changed, …). */
  notes: string[];
  /**
   * Structured latency comparison, present when both sides had ≥2
   * samples. Machine-readable for downstream CI artifact consumers.
   */
  latencyStats?: {
    baseline: AggregateStats;
    current: AggregateStats;
    deltaPct: number;
    significant: boolean;
  };
}

export interface BaselineComparison {
  diffs: CaseDiff[];
  /** Cases that passed in the baseline but fail now — always gate failures. */
  regressions: string[];
  /** Cases absent from the baseline. */
  newCases: string[];
  /** Cases in the baseline but not in this run. */
  removedCases: string[];
}

export interface GateResult {
  pass: boolean;
  reasons: string[];
  /** Non-failing observations worth surfacing (latency drift, …). */
  warnings: string[];
}

/**
 * Agent profiles: aggregate many EvaluationResults per agent into the
 * §57 agent-profile shape (success rate, first-pass QA, review rejection,
 * average repair loops, false completion). Updates are incremental —
 * recording the Nth evaluation only needs the current profile plus the
 * new result.
 */
import { AgentProfile, Clock, EvaluationResult } from './types';
import { clamp01, round2 } from './engine';

export interface ProfilerOptions {
  /** Defaults to `Date.now`; inject a fake clock in tests/demos. */
  now?: () => number;
}

/** First pass = succeeded with zero repair loops (no rework needed). */
export function isFirstPass(result: EvaluationResult): boolean {
  return result.metrics.taskSuccess === 1 && result.repairLoops === 0;
}

/**
 * Update a profile incrementally with one new evaluation result.
 * If `profile` is omitted, the result becomes the first data point.
 */
export function updateProfile(
  result: EvaluationResult,
  profile?: AgentProfile,
): AgentProfile {
  const n = (profile?.evaluations ?? 0) + 1;
  const prev = (x: number, prevN: number): number => (x * prevN) / n;

  const prevN = n - 1;
  const success = result.metrics.taskSuccess === 1 ? 1 : 0;
  const firstPass = isFirstPass(result) ? 1 : 0;

  return {
    agentId: result.agentId,
    evaluations: n,
    successRate: round2(clamp01(prev(profile?.successRate ?? 0, prevN) + success / n)),
    firstPassQaRate: round2(clamp01(prev(profile?.firstPassQaRate ?? 0, prevN) + firstPass / n)),
    reviewRejectionRate: round2(
      clamp01(prev(profile?.reviewRejectionRate ?? 0, prevN) + result.metrics.reviewRejectionRate / n),
    ),
    avgRepairLoops: round2(prev(profile?.avgRepairLoops ?? 0, prevN) + result.repairLoops / n),
    falseCompletionRate: round2(
      clamp01(prev(profile?.falseCompletionRate ?? 0, prevN) + result.metrics.falseCompletionRate / n),
    ),
    lastEvaluatedAt: result.evaluatedAt,
  };
}

/** In-memory per-agent profiler. */
export class AgentProfiler {
  private profiles = new Map<string, AgentProfile>();
  private readonly nowFn: () => number;

  constructor(options: ProfilerOptions = {}) {
    this.nowFn = options.now ?? Date.now;
  }

  /** Record one evaluation; the agent's profile is updated incrementally. */
  record(result: EvaluationResult): AgentProfile {
    const next = updateProfile(result, this.profiles.get(result.agentId));
    this.profiles.set(result.agentId, next);
    return next;
  }

  /** Current profile for an agent, or undefined if never evaluated. */
  get(agentId: string): AgentProfile | undefined {
    return this.profiles.get(agentId);
  }

  /** All known profiles. */
  all(): AgentProfile[] {
    return [...this.profiles.values()];
  }

  /** Agents sorted by successRate descending — quick leaderboard. */
  leaderboard(): AgentProfile[] {
    return this.all().sort((a, b) => b.successRate - a.successRate);
  }

  /** The clock the profiler was built with (exposed for demos/tests). */
  now(): number {
    return this.nowFn();
  }
}

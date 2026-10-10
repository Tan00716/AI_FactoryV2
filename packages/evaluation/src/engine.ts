/**
 * Task evaluation: TaskEvidence → §57 metrics → weighted verdict [§57].
 *
 * Verdict rules:
 *  - weighted score: 0.35·taskSuccess + 0.2·testPassRate
 *    + 0.1·(1-regressionRate) + 0.1·(1-reviewRejectionRate)
 *    + 0.1·loopEfficiency + 0.1·(1-falseCompletionRate)
 *    + 0.05·(1-toolErrorRate)
 *  - score >= 0.9 EXCELLENT, >= 0.75 GOOD, >= 0.55 ACCEPTABLE,
 *    >= 0.35 POOR, else FAIL
 *  - a failed task (taskSuccess = 0) can score at most POOR
 *  - falseCompletionRate > 0.3 caps the verdict at POOR: falsely claiming
 *    "done" is an integrity failure regardless of other metrics
 */
import { randomUUID } from 'node:crypto';
import {
  Clock,
  EvaluationMetrics,
  EvaluationResult,
  TaskEvaluationInput,
  Verdict,
} from './types';

export const SCORE_WEIGHTS: Record<keyof Omit<EvaluationMetrics, 'durationMs' | 'tokenUsage'>, number> = {
  taskSuccess: 0.35,
  testPassRate: 0.2,
  regressionRate: 0.1,
  reviewRejectionRate: 0.1,
  loopEfficiency: 0.1,
  toolErrorRate: 0.05,
  falseCompletionRate: 0.1,
  rollbackRate: 0,
  humanEscalationRate: 0,
};

/** Score cap applied to failed tasks and integrity failures → verdict at most POOR. */
export const FAILED_TASK_SCORE_CAP = 0.5;
/** False-completion rate above which the verdict is capped at POOR. */
export const FALSE_COMPLETION_CAP_THRESHOLD = 0.3;

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function rate(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return clamp01(part / whole);
}

/**
 * Compute the §57 metrics from raw task evidence. Empty denominators
 * (no tests, no tool calls, no reviews, …) yield 0 rates rather than NaN;
 * a task with no tests therefore contributes nothing positive or negative
 * via testPassRate — the caller may set `tests` to reflect reality.
 */
export function computeMetrics(ev: TaskEvaluationInput): EvaluationMetrics {
  return {
    taskSuccess: ev.success ? 1 : 0,
    testPassRate: ev.tests.total > 0 ? clamp01(ev.tests.passed / ev.tests.total) : 0,
    regressionRate: rate(ev.regressions, ev.tests.total),
    reviewRejectionRate: rate(ev.reviewRejections, ev.reviewRounds),
    loopEfficiency: ev.fixLoops <= 0 ? 1 : clamp01(1 / ev.fixLoops),
    durationMs: Math.max(0, ev.durationMs),
    tokenUsage: Math.max(0, ev.tokensUsed),
    toolErrorRate: rate(ev.toolErrors, ev.toolCalls),
    falseCompletionRate: rate(ev.falseCompletions, ev.completionClaims),
    rollbackRate: rate(ev.rollbacks, ev.deployments),
    humanEscalationRate: rate(ev.escalations, ev.decisions),
  };
}

/** Weighted 0..1 quality score from the §57 metrics. */
export function weightedScore(m: EvaluationMetrics): number {
  const w = SCORE_WEIGHTS;
  return round2(
    w.taskSuccess * m.taskSuccess +
      w.testPassRate * m.testPassRate +
      w.regressionRate * (1 - m.regressionRate) +
      w.reviewRejectionRate * (1 - m.reviewRejectionRate) +
      w.loopEfficiency * m.loopEfficiency +
      w.toolErrorRate * (1 - m.toolErrorRate) +
      w.falseCompletionRate * (1 - m.falseCompletionRate),
  );
}

/** Derive the verdict from score + hard integrity rules. */
export function verdictFor(m: EvaluationMetrics, score: number): Verdict {
  let capped = score;
  if (m.taskSuccess === 0) capped = Math.min(capped, FAILED_TASK_SCORE_CAP);
  if (m.falseCompletionRate > FALSE_COMPLETION_CAP_THRESHOLD) {
    capped = Math.min(capped, FAILED_TASK_SCORE_CAP);
  }
  if (capped >= 0.9) return 'EXCELLENT';
  if (capped >= 0.75) return 'GOOD';
  if (capped >= 0.55) return 'ACCEPTABLE';
  if (capped >= 0.35) return 'POOR';
  return 'FAIL';
}

export interface EvaluationEngineOptions {
  /** Defaults to `Date.now`; inject a fake clock in tests/demos. */
  now?: () => number;
}

export class EvaluationEngine {
  private results = new Map<string, EvaluationResult>();
  private readonly nowFn: () => number;

  constructor(options: EvaluationEngineOptions = {}) {
    this.nowFn = options.now ?? Date.now;
  }

  /** Evaluate one finished task: metrics → score → verdict; stored by id. */
  evaluateTask(input: TaskEvaluationInput): EvaluationResult {
    const metrics = computeMetrics(input);
    const score = weightedScore(metrics);
    const result: EvaluationResult = {
      evaluationId: `eval_${randomUUID()}`,
      taskId: input.taskId,
      agentId: input.agentId,
      summary: input.summary,
      evidenceIds: [...input.evidenceIds],
      metrics,
      score,
      verdict: verdictFor(metrics, score),
      repairLoops: Math.max(0, input.fixLoops),
      evaluatedAt: this.nowFn(),
    };
    this.results.set(result.evaluationId, result);
    return result;
  }

  /** Look up a stored evaluation by id. */
  get(evaluationId: string): EvaluationResult | undefined {
    return this.results.get(evaluationId);
  }

  /** All evaluations for one task, oldest first. */
  byTask(taskId: string): EvaluationResult[] {
    return [...this.results.values()]
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => a.evaluatedAt - b.evaluatedAt);
  }

  /** All evaluations run by one agent, oldest first. */
  byAgent(agentId: string): EvaluationResult[] {
    return [...this.results.values()]
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => a.evaluatedAt - b.evaluatedAt);
  }

  size(): number {
    return this.results.size;
  }
}

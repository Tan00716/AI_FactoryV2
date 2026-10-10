/**
 * @ai-factory/evaluation — independent Eval Harness (spec §45.3).
 *
 * ARCHITECTURE (the "no write path" boundary):
 *
 *   ┌──────────────┐   executes tasks    ┌──────────────────────────┐
 *   │  Executor    │ ──────────────────▶ │  EvalHarness (sealed)    │
 *   │  (agent,     │ ◀────────────────── │  - registered scorers    │
 *   │   loop, …)   │   read-only score() │  - scoring policy        │
 *   └──────────────┘                     │  - sample registry       │
 *                ╳ no write path ╳       └──────────────────────────┘
 *
 *  - The executor receives only a READ-ONLY scorer view: `score(sample)`.
 *    It cannot register scorers, change weights, rewrite the pass policy,
 *    delete failed attempts, or alter the train/holdout marks on samples.
 *  - The harness is SEALED before any evaluation runs: after `seal()`,
 *    `registerScorer` throws HarnessError and the internal policy object is
 *    frozen, so tampering attempts fail loudly.
 *  - Train/holdout separation: samples carry an explicit `split` mark.
 *    `runEvaluation` with purpose 'training_selection' REFUSES any holdout
 *    sample (HOLDOUT_LEAK) — holdout is benchmark-only, never training.
 *  - Full attempts are retained: every attempt (cost, failure, side effects)
 *    is recorded on the EvaluationRun — never pruned to "best only".
 */
import { randomUUID } from 'node:crypto';
import type {
  EvaluationAttempt,
  EvaluationPurpose,
  EvaluationRun,
  EvalSample,
} from './types';

export class HarnessError extends Error {
  readonly code: string;
  constructor(message: string, code = 'HARNESS_ERROR') {
    super(message);
    this.code = code;
    this.name = 'HarnessError';
  }
}

/** A sample leaked across the train/holdout boundary. */
export class HoldoutLeakError extends HarnessError {
  constructor(message: string) {
    super(message, 'HOLDOUT_LEAK');
    this.name = 'HoldoutLeakError';
  }
}

/** One registered scoring function: sample → 0..1 score. */
export type Scorer = (sample: EvalSample) => number;

/** Frozen scoring policy carried by the harness. */
export interface ScoringPolicy {
  /** Score ≥ threshold counts as a pass. */
  passThreshold: number;
  /** Names of the scorers that contributed. */
  scorerNames: string[];
}

/** The read-only view the executor gets — no write path to the harness. */
export interface ReadonlyScorer {
  score(sample: EvalSample): number;
  policy(): ScoringPolicy;
}

export interface EvalHarnessOptions {
  /** Defaults to wall time; inject a fake clock in tests/demos. */
  now?: () => number;
  passThreshold?: number;
}

export class EvalHarness {
  private readonly scorers = new Map<string, Scorer>();
  private readonly nowFn: () => number;
  private sealed = false;
  private policy: ScoringPolicy = { passThreshold: 0.6, scorerNames: [] };

  constructor(options: EvalHarnessOptions = {}) {
    this.nowFn = options.now ?? Date.now;
    this.policy = {
      passThreshold: options.passThreshold ?? 0.6,
      scorerNames: [],
    };
  }

  /** Register a scorer. Throws once the harness is sealed. */
  registerScorer(name: string, scorer: Scorer): void {
    if (this.sealed) {
      throw new HarnessError(
        `Harness is sealed: scorer '${name}' rejected — the executor has no write path to the scoring policy.`,
        'HARNESS_SEALED',
      );
    }
    this.scorers.set(name, scorer);
    this.policy = { passThreshold: this.policy.passThreshold, scorerNames: [...this.scorers.keys()] };
  }

  /** Seal the harness: scorers + policy are frozen from here on. */
  seal(): void {
    this.sealed = true;
    Object.freeze(this.policy);
    Object.freeze(this.policy.scorerNames);
  }

  isSealed(): boolean {
    return this.sealed;
  }

  /** The read-only scorer view handed to executors — the only write-free path. */
  readOnly(): ReadonlyScorer {
    return {
      score: (sample) => this.score(sample),
      policy: () => ({ ...this.policy, scorerNames: [...this.policy.scorerNames] }),
    };
  }

  /** Score a sample with the mean of registered scorers (0..1). */
  score(sample: EvalSample): number {
    if (this.scorers.size === 0) {
      throw new HarnessError('No scorers registered on the harness.', 'NO_SCORERS');
    }
    let sum = 0;
    for (const scorer of this.scorers.values()) {
      const s = scorer(sample);
      if (!Number.isFinite(s)) {
        throw new HarnessError('Scorer returned a non-finite score.', 'BAD_SCORE');
      }
      sum += Math.min(1, Math.max(0, s));
    }
    return Math.round((sum / this.scorers.size) * 100) / 100;
  }

  passed(score: number): boolean {
    return score >= this.policy.passThreshold;
  }
}

/** One attempt's outcome, as reported by the executor. */
export interface AttemptOutcome {
  success: boolean;
  /** Score for this attempt (optional; the harness can score instead). */
  score?: number;
  cost: { durationMs: number; tokensUsed: number };
  failureReason?: string;
  sideEffects?: string[];
}

/**
 * The executor's job: run the sample (possibly with retries) and report
 * EVERY attempt. The harness records them all — it never drops failures
 * or keeps only the best.
 */
export type Executor = (
  sample: EvalSample,
  scorer: ReadonlyScorer,
) => AttemptOutcome | AttemptOutcome[] | Promise<AttemptOutcome | AttemptOutcome[]>;

export interface RunEvaluationOptions {
  harness: EvalHarness;
  purpose: EvaluationPurpose;
  execute: Executor;
  /** Defaults to wall time; inject a fake clock in tests/demos. */
  now?: () => number;
}

export interface RunEvaluationResult {
  runs: EvaluationRun[];
  summary: {
    samples: number;
    passed: number;
    failed: number;
    attempts: number;
    totalCost: { durationMs: number; tokensUsed: number };
  };
}

/**
 * Run an evaluation over split-marked samples.
 *
 * Holdout rule (§45.3): purpose 'training_selection' with ANY holdout
 * sample → HoldoutLeakError. Holdout samples are benchmark-only and can
 * never be used to select or tune.
 *
 * Every attempt reported by the executor is recorded on the run —
 * attempts, costs, failures and side effects are all retained.
 */
export async function runEvaluation(
  samples: EvalSample[],
  opts: RunEvaluationOptions,
): Promise<RunEvaluationResult> {
  const now = opts.now ?? Date.now;
  const scorer = opts.harness.readOnly();

  if (opts.purpose === 'training_selection') {
    const leaked = samples.filter((s) => s.split === 'holdout');
    if (leaked.length > 0) {
      throw new HoldoutLeakError(
        `Holdout separation violated: ${leaked.length} holdout sample(s) ` +
          `(${leaked.map((s) => s.sampleId).join(', ')}) passed to training_selection. ` +
          'Holdout samples are benchmark-only and must never be used for training selection.',
      );
    }
  }

  const runs: EvaluationRun[] = [];
  let passCount = 0;
  let attemptCount = 0;
  const totalCost = { durationMs: 0, tokensUsed: 0 };

  for (const sample of samples) {
    const raw = await opts.execute(sample, scorer);
    const outcomes = Array.isArray(raw) ? raw : [raw];
    const attempts: EvaluationAttempt[] = outcomes.map((o) => {
      const attempt: EvaluationAttempt = {
        attemptId: `att_${randomUUID()}`,
        at: now(),
        cost: {
          durationMs: Math.max(0, o.cost.durationMs),
          tokensUsed: Math.max(0, o.cost.tokensUsed),
        },
        success: o.success,
        ...(o.score !== undefined ? { score: o.score } : {}),
        ...(o.failureReason ? { failureReason: o.failureReason } : {}),
        sideEffects: [...(o.sideEffects ?? [])],
      };
      attemptCount++;
      totalCost.durationMs += attempt.cost.durationMs;
      totalCost.tokensUsed += attempt.cost.tokensUsed;
      return attempt;
    });

    // If the executor didn't score, the harness scores every attempt's sample.
    const scores = attempts.map((a) =>
      a.score !== undefined ? a.score : opts.harness.score(sample),
    );
    const bestScore = scores.length ? Math.max(...scores) : null;
    const passed =
      bestScore !== null &&
      opts.harness.passed(bestScore) &&
      attempts.some((a) => a.success);
    if (passed) passCount++;

    runs.push({
      runId: `run_${randomUUID()}`,
      sampleId: sample.sampleId,
      purpose: opts.purpose,
      attempts,
      totalCost: {
        durationMs: attempts.reduce((n, a) => n + a.cost.durationMs, 0),
        tokensUsed: attempts.reduce((n, a) => n + a.cost.tokensUsed, 0),
      },
      bestScore,
      passed,
      executedAt: now(),
    });
  }

  return {
    runs,
    summary: {
      samples: samples.length,
      passed: passCount,
      failed: samples.length - passCount,
      attempts: attemptCount,
      totalCost,
    },
  };
}

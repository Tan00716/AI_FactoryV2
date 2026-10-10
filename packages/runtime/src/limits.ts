/**
 * Extended run budgets and retry discipline — SPEC v2 §25.
 *
 * Beyond steps/wall-time/retries: model calls, tool calls, repair loops,
 * context size, and consecutive no-progress steps are all bounded.
 * Retries use backoff with jitter and a total budget; deterministic test
 * failures are never blindly retried into a lucky pass.
 */
import { BudgetExceeded, Clock, systemClock } from './types';
import { classifyFailure, isAutoRetryAllowed } from './failures';

/** §25 — every bound a run must respect. */
export interface ExtendedBudgets {
  maxSteps: number;
  maxWallTimeMs: number;
  maxRetries: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxRepairLoops: number;
  /** Maximum context characters retained for the run. */
  maxContextChars: number;
  /** Consecutive steps with no observable progress before giving up. */
  maxNoProgressSteps: number;
}

export const DEFAULT_EXTENDED_BUDGETS: ExtendedBudgets = {
  maxSteps: 60,
  maxWallTimeMs: 120_000,
  maxRetries: 3,
  maxModelCalls: 40,
  maxToolCalls: 120,
  maxRepairLoops: 5,
  maxContextChars: 200_000,
  maxNoProgressSteps: 10,
};

/** Mutable consumption tracker; every check throws BudgetExceeded. */
export class BudgetTracker {
  private readonly budgets: ExtendedBudgets;
  private readonly clock: Clock;
  private readonly startedAt: number;
  private modelCalls = 0;
  private toolCalls = 0;
  private repairLoops = 0;
  private noProgressSteps = 0;

  constructor(budgets: Partial<ExtendedBudgets> = {}, clock?: Clock) {
    this.budgets = { ...DEFAULT_EXTENDED_BUDGETS, ...budgets };
    this.clock = clock ?? systemClock;
    this.startedAt = this.clock.now();
  }

  consumeModelCall(): void {
    this.modelCalls += 1;
    if (this.modelCalls > this.budgets.maxModelCalls) {
      throw new BudgetExceeded(`model calls ${this.modelCalls} > ${this.budgets.maxModelCalls}`);
    }
  }

  consumeToolCall(): void {
    this.toolCalls += 1;
    if (this.toolCalls > this.budgets.maxToolCalls) {
      throw new BudgetExceeded(`tool calls ${this.toolCalls} > ${this.budgets.maxToolCalls}`);
    }
  }

  consumeRepairLoop(): void {
    this.repairLoops += 1;
    if (this.repairLoops > this.budgets.maxRepairLoops) {
      throw new BudgetExceeded(`repair loops ${this.repairLoops} > ${this.budgets.maxRepairLoops}`);
    }
  }

  /** Call with true when the step produced observable progress. */
  noteProgress(madeProgress: boolean): void {
    this.noProgressSteps = madeProgress ? 0 : this.noProgressSteps + 1;
    if (this.noProgressSteps > this.budgets.maxNoProgressSteps) {
      throw new BudgetExceeded(
        `${this.noProgressSteps} consecutive steps without progress`,
      );
    }
  }

  checkWallTime(): void {
    const elapsed = this.clock.now() - this.startedAt;
    if (elapsed > this.budgets.maxWallTimeMs) {
      throw new BudgetExceeded(`elapsed ${elapsed}ms > ${this.budgets.maxWallTimeMs}ms`);
    }
  }

  checkContext(chars: number): void {
    if (chars > this.budgets.maxContextChars) {
      throw new BudgetExceeded(`context ${chars} chars > ${this.budgets.maxContextChars}`);
    }
  }

  get usage(): {
    modelCalls: number;
    toolCalls: number;
    repairLoops: number;
    noProgressSteps: number;
    elapsedMs: number;
  } {
    return {
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
      repairLoops: this.repairLoops,
      noProgressSteps: this.noProgressSteps,
      elapsedMs: this.clock.now() - this.startedAt,
    };
  }
}

/**
 * Backoff with full jitter (§25): sleep = random(0, min(cap, base * 2^attempt)).
 * `rand` is injectable so tests stay deterministic.
 */
export function backoffWithJitter(
  attempt: number,
  baseMs: number,
  capMs: number,
  rand: () => number = Math.random,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(rand() * exp);
}

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  /** Total wall-clock budget for all attempts combined. */
  totalBudgetMs: number;
}

export interface RetryOptions {
  policy: RetryPolicy;
  clock?: Clock;
  rand?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Decides whether this error class may be retried at all. */
  isRetryable?: (err: unknown) => boolean;
}

/**
 * Run `fn` with jittered backoff inside a total budget. Non-retryable
 * failure classes (permission denial, deterministic test failure, …)
 * are rethrown immediately — never retried into a lucky pass.
 */
export async function withRetryBudget<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const clock = opts.clock ?? systemClock;
  const rand = opts.rand ?? Math.random;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const isRetryable =
    opts.isRetryable ?? ((err: unknown) => isAutoRetryAllowed(classifyFailure(err)));
  const { policy } = opts;
  const start = clock.now();
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      const elapsed = clock.now() - start;
      const wait = backoffWithJitter(attempt, policy.baseMs, policy.capMs, rand);
      if (elapsed + wait > policy.totalBudgetMs) {
        throw new BudgetExceeded(
          `retry total budget ${policy.totalBudgetMs}ms exhausted after ${attempt + 1} attempts`,
        );
      }
      await sleep(wait);
    }
  }
  throw lastErr;
}

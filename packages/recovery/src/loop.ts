/**
 * RecoveryLoop — spec §78.
 *
 * Orchestrates: run fn → on failure classify → selectStrategy → execute the
 * strategy via an injected hook → repeat. Strategies are hook functions so the
 * real implementations (change model, restore snapshot, ask a human, …) live
 * outside this package; every decision and outcome is reported through an
 * injected audit hook (packages/core style, loose interface).
 *
 * Terminates with success, or when attempts are exhausted → abort/ask-human
 * escalation. Strategy hooks return one of:
 *   { type: 'retry' }                 run fn again (next attempt)
 *   { type: 'resolved', value? }      treat as success
 *   { type: 'abort', reason? }        stop, report failure
 *   { type: 'escalate', reason? }     stop, report escalation to a human
 */

import type { FailureType, RecoveryStrategy } from './types';
import { classifyFailure, type ClassifiedFailure } from './classify';
import { selectStrategy, type StrategyRecommendation } from './strategies';

export type RecoveryOutcome =
  | { type: 'retry' }
  | { type: 'resolved'; value?: unknown }
  | { type: 'abort'; reason?: string }
  | { type: 'escalate'; reason?: string };

export interface StrategyContext {
  strategy: RecoveryStrategy;
  recommendation: StrategyRecommendation;
  /** 0-based attempt that just failed. */
  attempt: number;
  failure: ClassifiedFailure;
}

export type StrategyHook = (
  ctx: StrategyContext,
) => Promise<RecoveryOutcome> | RecoveryOutcome;

export type AuditEventType =
  | 'run_started'
  | 'attempt_failed'
  | 'strategy_selected'
  | 'strategy_executed'
  | 'run_succeeded'
  | 'run_aborted'
  | 'run_escalated';

export interface RecoveryAuditEvent {
  event: AuditEventType;
  attempt: number;
  failureType?: FailureType;
  strategy?: RecoveryStrategy;
  message?: string;
  details?: Record<string, unknown>;
}

export interface AttemptRecord {
  attempt: number;
  failureType: FailureType;
  strategy: RecoveryStrategy;
  outcome: RecoveryOutcome['type'];
}

export interface RecoveryLoopOptions {
  /** Max fn executions before giving up. Default 5. */
  maxAttempts?: number;
  /** Strategy hooks; unset strategies use the built-in defaults. */
  hooks?: Partial<Record<RecoveryStrategy, StrategyHook>>;
  /** Injected audit sink (e.g. packages/core AuditLog.record wrapper). */
  audit?: (event: RecoveryAuditEvent) => void;
  classify?: typeof classifyFailure;
  selectStrategy?: typeof selectStrategy;
}

export interface RecoveryResult {
  status: 'success' | 'aborted' | 'escalated';
  attempts: number;
  value?: unknown;
  failure?: { message: string; type: FailureType };
  history: AttemptRecord[];
}

/**
 * Default strategy behavior for the prototype: every automated strategy just
 * retries (the hook is where real work would happen); ask-human escalates
 * (no human is wired in the prototype); abort aborts.
 */
export function defaultStrategyHook(strategy: RecoveryStrategy): StrategyHook {
  return async () => {
    if (strategy === 'ask-human') return { type: 'escalate', reason: 'escalated to human' };
    if (strategy === 'abort') return { type: 'abort', reason: 'strategy abort' };
    return { type: 'retry' };
  };
}

export class RecoveryLoop {
  private maxAttempts: number;
  private hooks: Partial<Record<RecoveryStrategy, StrategyHook>>;
  private audit?: (event: RecoveryAuditEvent) => void;
  private classify: typeof classifyFailure;
  private select: typeof selectStrategy;

  constructor(opts: RecoveryLoopOptions = {}) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
    this.hooks = opts.hooks ?? {};
    this.audit = opts.audit;
    this.classify = opts.classify ?? classifyFailure;
    this.select = opts.selectStrategy ?? selectStrategy;
  }

  private emit(event: RecoveryAuditEvent): void {
    this.audit?.(event);
  }

  private hookFor(strategy: RecoveryStrategy): StrategyHook {
    return this.hooks[strategy] ?? defaultStrategyHook(strategy);
  }

  async run<T>(fn: (attempt: number) => Promise<T> | T): Promise<RecoveryResult> {
    const history: AttemptRecord[] = [];
    this.emit({ event: 'run_started', attempt: 0 });

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        const value = await fn(attempt);
        this.emit({ event: 'run_succeeded', attempt, details: { attempts: attempt + 1 } });
        return { status: 'success', attempts: attempt + 1, value, history };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failure = this.classify({ message });
        const recommendation = this.select(failure.type, attempt);
        this.emit({
          event: 'attempt_failed',
          attempt,
          failureType: failure.type,
          message,
        });
        this.emit({
          event: 'strategy_selected',
          attempt,
          failureType: failure.type,
          strategy: recommendation.strategy,
          details: { reason: recommendation.reason, backoffMs: recommendation.backoffMs },
        });

        const outcome = await this.hookFor(recommendation.strategy)({
          strategy: recommendation.strategy,
          recommendation,
          attempt,
          failure,
        });
        this.emit({
          event: 'strategy_executed',
          attempt,
          failureType: failure.type,
          strategy: recommendation.strategy,
          details: { outcome: outcome.type },
        });
        history.push({
          attempt,
          failureType: failure.type,
          strategy: recommendation.strategy,
          outcome: outcome.type,
        });

        if (outcome.type === 'resolved') {
          this.emit({ event: 'run_succeeded', attempt });
          return {
            status: 'success',
            attempts: attempt + 1,
            value: outcome.value,
            history,
          };
        }
        if (outcome.type === 'escalate') {
          this.emit({ event: 'run_escalated', attempt, message: outcome.reason });
          return {
            status: 'escalated',
            attempts: attempt + 1,
            failure: { message, type: failure.type },
            history,
          };
        }
        if (outcome.type === 'abort') {
          this.emit({ event: 'run_aborted', attempt, message: outcome.reason });
          return {
            status: 'aborted',
            attempts: attempt + 1,
            failure: { message, type: failure.type },
            history,
          };
        }
        // 'retry' → next attempt. If this was the last allowed attempt, the
        // loop ends and we escalate instead of silently dropping the failure.
        if (attempt + 1 >= this.maxAttempts) {
          const finalStrategy = recommendation.strategy;
          if (finalStrategy === 'ask-human') {
            this.emit({ event: 'run_escalated', attempt, message });
            return {
              status: 'escalated',
              attempts: attempt + 1,
              failure: { message, type: failure.type },
              history,
            };
          }
          this.emit({
            event: 'run_aborted',
            attempt,
            message: `attempts exhausted (${this.maxAttempts})`,
          });
          return {
            status: 'aborted',
            attempts: attempt + 1,
            failure: { message, type: failure.type },
            history,
          };
        }
      }
    }
    // Unreachable (loop always returns), but keeps TS happy.
    return { status: 'aborted', attempts: this.maxAttempts, history };
  }
}

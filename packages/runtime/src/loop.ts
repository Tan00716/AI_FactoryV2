/**
 * AgentLoop — spec §24 (Agent Loop) and §25 (loop engineering).
 *
 * Explicit state machine:
 *
 *   OBSERVE → UNDERSTAND → PLAN → ACT → VERIFY → EVALUATE
 *       → CONTINUE | RETRY | HANDOFF | ESCALATE | COMPLETE
 *
 * A caller-supplied StepFn drives each phase, so tests can script behavior
 * without an LLM. The loop enforces step/time/retry budgets (BudgetExceeded),
 * detects stagnation (same error signature `stagnationLimit` times across
 * retries with no clean cycle in between → LoopStagnation → the caller
 * auto-escalates), and supports checkpoint/resume via an opaque token.
 */
import {
  BadCheckpoint,
  BudgetExceeded,
  Clock,
  FactoryError,
  LoopBudgets,
  LoopOutcome,
  LoopPhase,
  LoopSnapshot,
  LOOP_PHASES,
  LoopStagnation,
  PhaseResult,
  StepFn,
  systemClock,
  TraceStep,
} from './types';
import type { BudgetTracker } from './limits';

export interface AgentLoopOptions {
  budgets: LoopBudgets;
  clock?: Clock;
  onTrace?: (step: TraceStep) => void;
  /** Consecutive identical error signatures before stagnation; default 3 (§25). */
  stagnationLimit?: number;
  /**
   * SPEC v2 §25 — stagnation is "same fingerprint N times with NO NEW
   * EVIDENCE". When provided, a failure with the same signature does NOT
   * advance the stagnation counter if new evidence arrived since the last
   * failure (the loop is learning, not stuck). Absent → legacy behavior:
   * any repeat counts.
   */
  evidenceAddedSinceLastFailure?: () => boolean;
  /**
   * SPEC v2 §25 (G-51) — extended budgets. When attached, the loop
   * enforces wall-time, counts repair loops (one per failure-driven or
   * RETRY-driven cycle) and tracks consecutive no-progress steps.
   * runAgent's default path always attaches one.
   */
  budgetTracker?: BudgetTracker;
}

interface CheckpointState {
  v: 1;
  phaseIdx: number;
  totalSteps: number;
  retries: number;
  startedAt: number | null;
  lastErrorSignature: string | null;
  consecutiveFailures: number;
}

export class AgentLoop {
  private readonly budgets: LoopBudgets;
  private readonly clock: Clock;
  private readonly onTrace?: (step: TraceStep) => void;
  private readonly stagnationLimit: number;
  private readonly evidenceAddedSinceLastFailure?: () => boolean;
  private budgetTracker?: BudgetTracker;

  private phaseIdx = 0;
  private totalSteps = 0;
  private retries = 0;
  private startedAt: number | null = null;
  private lastErrorSignature: string | null = null;
  private consecutiveFailures = 0;
  private traceLog: TraceStep[] = [];

  constructor(options: AgentLoopOptions) {
    this.budgets = options.budgets;
    this.clock = options.clock ?? systemClock;
    this.onTrace = options.onTrace;
    this.stagnationLimit = options.stagnationLimit ?? 3;
    this.evidenceAddedSinceLastFailure = options.evidenceAddedSinceLastFailure;
    this.budgetTracker = options.budgetTracker;
  }

  /** §25 (G-51) — attach the run's BudgetTracker after construction
   *  (used by runAgent when the caller supplied their own loop). No-op
   *  when a tracker is already attached. */
  attachBudgetTracker(tracker: BudgetTracker): void {
    if (!this.budgetTracker) this.budgetTracker = tracker;
  }

  get tracker(): BudgetTracker | undefined {
    return this.budgetTracker;
  }

  /** Read-only view of current loop state. */
  get snapshot(): LoopSnapshot {
    return {
      phase: LOOP_PHASES[this.phaseIdx],
      totalSteps: this.totalSteps,
      retries: this.retries,
      elapsedMs: this.startedAt === null ? 0 : this.clock.now() - this.startedAt,
      consecutiveFailures: this.consecutiveFailures,
      lastErrorSignature: this.lastErrorSignature,
    };
  }

  /**
   * Trace recorded so far. On a successful run() this is also returned in
   * LoopOutcome; when run() throws (BudgetExceeded / LoopStagnation) the
   * caller can still recover the partial trace from here.
   */
  get trace(): TraceStep[] {
    return [...this.traceLog];
  }

  /**
   * §25 — serialize resumable state into an opaque token. The token carries
   * phase position, budgets consumed so far, and the failure history needed
   * for stagnation detection; it carries no callbacks or secrets.
   */
  checkpoint(): string {
    const state: CheckpointState = {
      v: 1,
      phaseIdx: this.phaseIdx,
      totalSteps: this.totalSteps,
      retries: this.retries,
      startedAt: this.startedAt,
      lastErrorSignature: this.lastErrorSignature,
      consecutiveFailures: this.consecutiveFailures,
    };
    return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  }

  /** §25 — restore state from a checkpoint() token and continue from there. */
  resume(token: string): void {
    let state: CheckpointState;
    try {
      state = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as CheckpointState;
    } catch {
      throw new BadCheckpoint('token is not valid base64url JSON');
    }
    if (!state || state.v !== 1 || typeof state.phaseIdx !== 'number') {
      throw new BadCheckpoint('unrecognized checkpoint version/shape');
    }
    this.phaseIdx = state.phaseIdx;
    this.totalSteps = state.totalSteps;
    this.retries = state.retries;
    this.startedAt = state.startedAt;
    this.lastErrorSignature = state.lastErrorSignature;
    this.consecutiveFailures = state.consecutiveFailures;
    this.traceLog = [];
  }

  /**
   * Run the loop until a terminal decision. `pauseAtStep` stops after that
   * many executed steps with decision=PAUSED (for checkpoint/resume flows).
   * Throws BudgetExceeded / LoopStagnation.
   */
  async run(stepFn: StepFn, opts?: { pauseAtStep?: number }): Promise<LoopOutcome> {
    if (this.startedAt === null) this.startedAt = this.clock.now();

    for (;;) {
      this.enforceBudgets();
      // §25 (G-51): extended wall-time budget, checked every step.
      this.budgetTracker?.checkWallTime();
      const phase: LoopPhase = LOOP_PHASES[this.phaseIdx];

      let result: PhaseResult;
      try {
        result = await stepFn(phase, this.snapshot);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = {
          ok: false,
          error: message,
          errorSignature: err instanceof FactoryError ? err.code : 'step-throw',
          note: 'stepFn threw',
        };
      }

      this.totalSteps += 1;
      this.recordTrace(phase, result.note ?? '', result.ok ? 'ok' : `fail: ${result.error ?? 'unknown'}`);
      // §25 (G-51): a failed phase is a step without observable progress;
      // exceeding maxNoProgressSteps throws BudgetExceeded here.
      this.budgetTracker?.noteProgress(result.ok);

      if (!result.ok) {
        this.registerFailure(result);
        // RETRY: restart the cycle at OBSERVE (§25 example: test failed →
        // read failure → modify → test → pass).
        this.phaseIdx = 0;
      } else if (phase === 'EVALUATE') {
        // Full OBSERVE→EVALUATE cycle with no failed phases: the loop is
        // making progress, so past failures no longer count as stagnation.
        // (A successful mid-cycle phase alone does NOT reset it — a passing
        // OBSERVE must not mask an error repeating at ACT/VERIFY.)
        this.consecutiveFailures = 0;
        this.lastErrorSignature = null;

        const decision = result.decision ?? 'COMPLETE';
        switch (decision) {
          case 'COMPLETE':
          case 'SUBMIT':
          case 'HANDOFF':
          case 'ESCALATE':
            return this.outcome(decision === 'SUBMIT' ? 'COMPLETE' : decision, result.handoffTo);
          case 'CONTINUE':
            this.phaseIdx = 0;
            break;
          case 'RETRY':
            // §25 (G-51): an EVALUATE-driven retry is a repair loop too.
            this.budgetTracker?.consumeRepairLoop();
            this.retries += 1;
            this.enforceRetryBudget();
            this.phaseIdx = 0;
            break;
        }
      } else {
        this.phaseIdx += 1;
      }

      // Pause only after phaseIdx already points at the NEXT phase, so a
      // checkpoint/resume continues without re-executing the paused phase.
      if (opts?.pauseAtStep !== undefined && this.totalSteps >= opts.pauseAtStep) {
        return this.outcome('PAUSED');
      }
    }
  }

  /** A failed phase: stagnation check, then retry-budget check (may throw). */
  private registerFailure(result: PhaseResult): void {
    const sig = result.errorSignature ?? result.error ?? 'unknown-error';
    // §25: a budget exhaustion reported by a step is terminal — quota is
    // not auto-retryable, and counting it toward stagnation would mask
    // the real cause behind a LOOP_STAGNATION escalation.
    if (sig === 'BUDGET_EXCEEDED') {
      throw new BudgetExceeded(
        `step reported BUDGET_EXCEEDED — terminal, not retried (${result.error ?? 'no detail'})`,
      );
    }
    // §25 (G-51): every failure-driven restart is one repair loop;
    // exceeding maxRepairLoops throws BudgetExceeded here.
    this.budgetTracker?.consumeRepairLoop();
    if (sig === this.lastErrorSignature) {
      // §25: new evidence since the last failure means the loop is making
      // progress (different test output, new diagnostics) — not stagnation.
      const learned = this.evidenceAddedSinceLastFailure?.() ?? false;
      this.consecutiveFailures = learned ? 1 : this.consecutiveFailures + 1;
    } else {
      this.lastErrorSignature = sig;
      this.consecutiveFailures = 1;
    }
    // §25: same error 3 times → LOOP_STAGNATION → auto-escalate.
    if (this.consecutiveFailures >= this.stagnationLimit) {
      throw new LoopStagnation(sig, this.stagnationLimit);
    }
    this.retries += 1;
    this.enforceRetryBudget();
  }

  private enforceRetryBudget(): void {
    if (this.retries > this.budgets.maxRetries) {
      throw new BudgetExceeded(
        `retries ${this.retries} exceeded maxRetries ${this.budgets.maxRetries}`,
      );
    }
  }

  private enforceBudgets(): void {
    if (this.totalSteps >= this.budgets.maxSteps) {
      throw new BudgetExceeded(
        `steps ${this.totalSteps} reached maxSteps ${this.budgets.maxSteps}`,
      );
    }
    if (this.startedAt !== null) {
      const elapsed = this.clock.now() - this.startedAt;
      if (elapsed > this.budgets.timeMs) {
        throw new BudgetExceeded(`elapsed ${elapsed}ms exceeded timeMs ${this.budgets.timeMs}`);
      }
    }
  }

  private recordTrace(phase: string, action: string, result: string): void {
    const step: TraceStep = { t: this.clock.now(), phase, action, result };
    this.traceLog.push(step);
    this.onTrace?.(step);
  }

  private outcome(
    decision: LoopOutcome['decision'],
    handoffTo?: string,
  ): LoopOutcome {
    return {
      decision,
      handoffTo,
      steps: this.totalSteps,
      retries: this.retries,
      trace: [...this.traceLog],
    };
  }
}

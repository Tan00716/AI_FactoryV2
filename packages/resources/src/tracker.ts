/**
 * BudgetTracker — per-task budget accounting with hard rejection (§79, §81).
 *
 * A task gets a Budget (defaults to DEFAULT_TASK_BUDGET). consume() debits
 * consumable dimensions; when any dimension would go below zero the call
 * throws BudgetExceededError and the onExceed hook fires so the caller can
 * record audit and notify a human (§81 "Budget exceeded" is a human
 * exception-handler trigger).
 *
 * Budget increases never apply automatically: requestIncrease() returns a
 * pending approval record that a human/approver resolves via
 * resolveIncrease(). This mirrors the approvals module's separation of
 * request and grant.
 */

import { randomUUID } from 'crypto';
import {
  Budget,
  BudgetDimension,
  Clock,
  CONSUMABLE_DIMENSIONS,
  ConsumableDimension,
  DEFAULT_TASK_BUDGET,
} from './types';

export class BudgetExceededError extends Error {
  readonly name = 'BudgetExceededError';

  constructor(
    /** The exhausted budget dimension. */
    readonly dimension: BudgetDimension,
    readonly taskId: string,
    readonly used: number,
    readonly limit: number,
  ) {
    super(
      `Budget exceeded for task ${taskId}: ${dimension} used=${used} limit=${limit}`,
    );
  }
}

export interface BudgetExceededEvent {
  taskId: string;
  dimension: BudgetDimension;
  used: number;
  limit: number;
  requested: number;
  at: number;
}

export type OnExceedHook = (event: BudgetExceededEvent) => void;

export interface BudgetIncreaseRequest {
  id: string;
  taskId: string;
  dimension: BudgetDimension;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

export interface BudgetTrackerOptions {
  clock?: Clock;
  /** Escalation hook: write audit + notify human when a budget is exceeded. */
  onExceed?: OnExceedHook;
  /** Fallback budget used for tasks with no explicit budget. */
  defaultBudget?: Budget;
}

interface TaskLedger {
  budget: Budget;
  used: Record<ConsumableDimension, number>;
  runningAgents: number;
  startedAt: number | null;
}

const zeroUsed = (): Record<ConsumableDimension, number> => ({
  timeMs: 0,
  tokens: 0,
  toolCalls: 0,
  retries: 0,
  storageBytes: 0,
  processes: 0,
});

export class BudgetTracker {
  private readonly clock: Clock;
  private readonly onExceed: OnExceedHook | undefined;
  private readonly defaultBudget: Budget;
  private readonly ledgers = new Map<string, TaskLedger>();
  private readonly increases = new Map<string, BudgetIncreaseRequest>();

  constructor(options: BudgetTrackerOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.onExceed = options.onExceed;
    this.defaultBudget = options.defaultBudget ?? DEFAULT_TASK_BUDGET;
  }

  /** Assign (or replace) a task's budget. */
  setBudget(taskId: string, budget: Partial<Budget>): Budget {
    const ledger = this.ledger(taskId);
    ledger.budget = { ...ledger.budget, ...budget };
    return { ...ledger.budget };
  }

  getBudget(taskId: string): Budget {
    return { ...this.ledger(taskId).budget };
  }

  /** Mark task start so wall-clock time counts against the time budget. */
  start(taskId: string): void {
    this.ledger(taskId).startedAt = this.clock.now();
  }

  /** Milliseconds of wall-clock time consumed so far (0 if not started). */
  elapsed(taskId: string): number {
    const startedAt = this.ledger(taskId).startedAt;
    return startedAt === null ? 0 : Math.max(0, this.clock.now() - startedAt);
  }

  /**
   * Sync the number of currently-running agents (enforced by ConcurrencyGate).
   * Throws BudgetExceededError on the maxConcurrentAgents dimension when the
   * task runs more agents than its budget allows.
   */
  recordAgents(taskId: string, running: number): void {
    const ledger = this.ledger(taskId);
    ledger.runningAgents = running;
    if (running > ledger.budget.maxConcurrentAgents) {
      this.exceed(taskId, 'maxConcurrentAgents', running, ledger.budget.maxConcurrentAgents, running);
    }
  }

  /**
   * Debit consumable dimensions. Throws BudgetExceededError (and fires the
   * onExceed hook) as soon as any dimension would be exhausted.
   */
  consume(taskId: string, usage: Partial<Record<ConsumableDimension, number>>): void {
    const ledger = this.ledger(taskId);
    // Time counts wall-clock elapsed automatically: check it even when the
    // caller passes no explicit timeMs amount.
    const elapsed = this.elapsedOf(ledger);
    const explicitTime = usage.timeMs ?? 0;
    if (ledger.used.timeMs + elapsed + explicitTime > ledger.budget.timeMs) {
      this.exceed(
        taskId,
        'timeMs',
        ledger.used.timeMs + elapsed,
        ledger.budget.timeMs,
        explicitTime,
      );
    }
    if (explicitTime) ledger.used.timeMs += explicitTime;
    for (const dim of CONSUMABLE_DIMENSIONS) {
      if (dim === 'timeMs') continue;
      const amount = usage[dim];
      if (amount === undefined || amount === 0) continue;
      const used = this.usedOf(ledger, dim);
      const limit = ledger.budget[dim];
      if (used + amount > limit) {
        this.exceed(taskId, dim, used, limit, amount);
      }
      ledger.used[dim] = used + amount;
    }
  }

  /** Remaining budget per dimension (never below zero). */
  check(taskId: string): Record<BudgetDimension, number> {
    const ledger = this.ledger(taskId);
    const remaining: Record<BudgetDimension, number> = {
      timeMs: Math.max(0, ledger.budget.timeMs - this.usedOf(ledger, 'timeMs')),
      tokens: Math.max(0, ledger.budget.tokens - ledger.used.tokens),
      maxConcurrentAgents: Math.max(0, ledger.budget.maxConcurrentAgents - ledger.runningAgents),
      toolCalls: Math.max(0, ledger.budget.toolCalls - ledger.used.toolCalls),
      retries: Math.max(0, ledger.budget.retries - ledger.used.retries),
      storageBytes: Math.max(0, ledger.budget.storageBytes - ledger.used.storageBytes),
      processes: Math.max(0, ledger.budget.processes - ledger.used.processes),
    };
    return remaining;
  }

  /** Current consumption per dimension (for dashboards). */
  usage(taskId: string): Record<BudgetDimension, number> {
    const ledger = this.ledger(taskId);
    return {
      timeMs: this.usedOf(ledger, 'timeMs'),
      tokens: ledger.used.tokens,
      maxConcurrentAgents: ledger.runningAgents,
      toolCalls: ledger.used.toolCalls,
      retries: ledger.used.retries,
      storageBytes: ledger.used.storageBytes,
      processes: ledger.used.processes,
    };
  }

  /**
   * Request a budget increase. Returns a PENDING record — the increase only
   * takes effect when resolveIncrease(id, true) is called by an approver.
   */
  requestIncrease(taskId: string, dimension: BudgetDimension, amount: number): BudgetIncreaseRequest {
    if (amount <= 0) throw new Error('increase amount must be positive');
    this.ledger(taskId); // ensure the task exists
    const req: BudgetIncreaseRequest = {
      id: randomUUID(),
      taskId,
      dimension,
      amount,
      status: 'pending',
      requestedAt: this.clock.now(),
      resolvedAt: null,
      resolvedBy: null,
    };
    this.increases.set(req.id, req);
    return { ...req };
  }

  /** Resolve a pending increase; an approval adds to the task's budget. */
  resolveIncrease(id: string, approved: boolean, resolvedBy = 'human'): BudgetIncreaseRequest {
    const req = this.increases.get(id);
    if (!req) throw new Error(`budget increase ${id} not found`);
    if (req.status !== 'pending') throw new Error(`budget increase ${id} already ${req.status}`);
    req.status = approved ? 'approved' : 'rejected';
    req.resolvedAt = this.clock.now();
    req.resolvedBy = resolvedBy;
    if (approved) {
      const ledger = this.ledger(req.taskId);
      ledger.budget[req.dimension] += req.amount;
    }
    return { ...req };
  }

  /** Pending (unresolved) increase requests, optionally scoped to a task. */
  pendingIncreases(taskId?: string): BudgetIncreaseRequest[] {
    return [...this.increases.values()]
      .filter((r) => r.status === 'pending' && (taskId === undefined || r.taskId === taskId))
      .map((r) => ({ ...r }));
  }

  /** Reset a task's ledger (e.g. when re-running a task after failure). */
  reset(taskId: string): void {
    this.ledgers.delete(taskId);
  }

  private ledger(taskId: string): TaskLedger {
    let ledger = this.ledgers.get(taskId);
    if (!ledger) {
      ledger = {
        budget: { ...this.defaultBudget },
        used: zeroUsed(),
        runningAgents: 0,
        startedAt: null,
      };
      this.ledgers.set(taskId, ledger);
    }
    return ledger;
  }

  private usedOf(ledger: TaskLedger, dim: ConsumableDimension): number {
    if (dim === 'timeMs') return ledger.used.timeMs + this.elapsedOf(ledger);
    return ledger.used[dim];
  }

  private elapsedOf(ledger: TaskLedger): number {
    return ledger.startedAt === null ? 0 : Math.max(0, this.clock.now() - ledger.startedAt);
  }

  private exceed(
    taskId: string,
    dimension: BudgetDimension,
    used: number,
    limit: number,
    requested: number,
  ): never {
    const event: BudgetExceededEvent = {
      taskId,
      dimension,
      used,
      limit,
      requested,
      at: this.clock.now(),
    };
    if (this.onExceed) this.onExceed(event);
    throw new BudgetExceededError(dimension, taskId, used, limit);
  }
}

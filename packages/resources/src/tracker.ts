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
 *
 * §21.4 reservation lifecycle (G-35): work that must not oversell a shared
 * budget first reserve()s the amounts it needs — an atomic, all-or-nothing
 * hold: either every requested dimension fits within (limit − used − held)
 * and the hold is recorded, or BudgetExceededError is thrown and nothing
 * is held. charge() then converts hold into actual usage as work happens
 * (never more than held), settle() closes a reservation after an optional
 * final charge, and release() closes it freeing the uncharged remainder.
 * Plain consume() also respects outstanding holds, so concurrent
 * subtasks cannot oversell the parent budget between them.
 *
 * §21.4 / §27.1 unknown amounts: a measurement known to have happened
 * whose amount the provider does not report (above all money) is counted
 * via recordUnknown() and reported by unknownUsage() — it is never folded
 * into usage() as a fabricated number, and subscription usage is never
 * presented as an API dollar bill.
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

/**
 * §21.4 block conditions (G-36) — the values core's TaskConditionValue
 * gains for budget/resource overruns. This package stays dependency-free,
 * so the literals are declared here and kept string-identical to core's.
 *
 * Mapping (the spec names the pair BUDGET/RESOURCE_BLOCK without assigning
 * dimensions; this is the documented local rule): the spend dimensions —
 * money and tokens/quota — block as BUDGET_BLOCK; the capacity dimensions
 * (time, tool calls, retries, storage, processes, CPU, RAM, concurrent
 * agents) block as RESOURCE_BLOCK.
 */
export type BudgetBlockCondition = 'BUDGET_BLOCK' | 'RESOURCE_BLOCK';

export function blockConditionForDimension(dimension: BudgetDimension): BudgetBlockCondition {
  return dimension === 'moneyMinor' || dimension === 'tokens'
    ? 'BUDGET_BLOCK'
    : 'RESOURCE_BLOCK';
}

export class BudgetExceededError extends Error {
  readonly name = 'BudgetExceededError';
  /** §21.4: the task condition this overrun puts the task into (G-36). */
  readonly condition: BudgetBlockCondition;

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
    this.condition = blockConditionForDimension(dimension);
  }
}

export interface BudgetExceededEvent {
  taskId: string;
  dimension: BudgetDimension;
  used: number;
  limit: number;
  requested: number;
  at: number;
  /** §21.4 block condition for the affected task (G-36). */
  condition: BudgetBlockCondition;
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

/** §21.4 reservation lifecycle states: OPEN → SETTLED | RELEASED. */
export type BudgetReservationStatus = 'OPEN' | 'SETTLED' | 'RELEASED';

/**
 * An atomic budget hold (§21.4, G-35). `held` is what reserve() set aside;
 * `charged` is the part already converted into real usage by charge() /
 * settle(). The still-effective hold of an OPEN reservation is
 * held − charged per dimension; closing (settle/release) frees it.
 */
export interface BudgetReservation {
  id: string;
  taskId: string;
  held: Partial<Record<ConsumableDimension, number>>;
  charged: Partial<Record<ConsumableDimension, number>>;
  status: BudgetReservationStatus;
  createdAt: number;
  closedAt: number | null;
}

interface TaskLedger {
  budget: Budget;
  used: Record<ConsumableDimension, number>;
  /** §21.4: counts of measurements whose amount is unknown, per dimension. */
  unknown: Record<ConsumableDimension, number>;
  reservations: Map<string, BudgetReservation>;
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
  moneyMinor: 0,
  cpuMs: 0,
  memoryBytes: 0,
});

export class BudgetTracker {
  private readonly clock: Clock;
  private readonly onExceed: OnExceedHook | undefined;
  private readonly defaultBudget: Budget;
  private readonly ledgers = new Map<string, TaskLedger>();
  private readonly increases = new Map<string, BudgetIncreaseRequest>();
  /** Reservation id → owning task id, so charge/settle/release find the
   *  ledger without scanning every task. */
  private readonly reservationTask = new Map<string, string>();

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
   * onExceed hook) as soon as any dimension would be exhausted. Outstanding
   * reservation holds count against the limit (§21.4: no oversell), so a
   * plain consume cannot spend what a subtask has reserved.
   */
  consume(taskId: string, usage: Partial<Record<ConsumableDimension, number>>): void {
    const ledger = this.ledger(taskId);
    // Time counts wall-clock elapsed automatically: check it even when the
    // caller passes no explicit timeMs amount.
    const elapsed = this.elapsedOf(ledger);
    const explicitTime = usage.timeMs ?? 0;
    const heldTime = this.heldOf(ledger, 'timeMs');
    if (ledger.used.timeMs + elapsed + heldTime + explicitTime > ledger.budget.timeMs) {
      this.exceed(
        taskId,
        'timeMs',
        ledger.used.timeMs + elapsed + heldTime,
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
      if (used + this.heldOf(ledger, dim) + amount > limit) {
        this.exceed(taskId, dim, used + this.heldOf(ledger, dim), limit, amount);
      }
      ledger.used[dim] = used + amount;
    }
  }

  /* -------------------------------------------------------------- *
   * §21.4 atomic reserve → charge → settle/release (G-35)           *
   * -------------------------------------------------------------- */

  /**
   * Atomically hold budget for upcoming work. All-or-nothing: every
   * requested dimension must fit within limit − used − already-held, or
   * BudgetExceededError is thrown (onExceed fires) and NO hold is
   * recorded. The check-and-record happens in one synchronous step, so
   * interleaved async callers cannot oversell the budget between check
   * and hold.
   */
  reserve(
    taskId: string,
    amounts: Partial<Record<ConsumableDimension, number>>,
  ): BudgetReservation {
    const ledger = this.ledger(taskId);
    const entries = positiveEntries(amounts, 'reserve');
    for (const [dim, amount] of entries) {
      const committed = this.usedOf(ledger, dim) + this.heldOf(ledger, dim);
      if (committed + amount > ledger.budget[dim]) {
        this.exceed(taskId, dim, committed, ledger.budget[dim], amount);
      }
    }
    const reservation: BudgetReservation = {
      id: randomUUID(),
      taskId,
      held: Object.fromEntries(entries),
      charged: {},
      status: 'OPEN',
      createdAt: this.clock.now(),
      closedAt: null,
    };
    ledger.reservations.set(reservation.id, reservation);
    this.reservationTask.set(reservation.id, taskId);
    return cloneReservation(reservation);
  }

  /**
   * Convert part (or all) of an OPEN reservation's hold into real usage.
   * Charging more than the uncharged hold on any dimension throws and
   * charges nothing. Charged amounts land in used() immediately.
   */
  charge(
    reservationId: string,
    amounts: Partial<Record<ConsumableDimension, number>>,
  ): BudgetReservation {
    const { ledger, reservation } = this.openReservation(reservationId);
    const entries = positiveEntries(amounts, 'charge');
    for (const [dim, amount] of entries) {
      const held = reservation.held[dim] ?? 0;
      const charged = reservation.charged[dim] ?? 0;
      if (charged + amount > held) {
        throw new Error(
          `charge exceeds reservation hold for ${dim}: held=${held} charged=${charged} requested=${amount}`,
        );
      }
    }
    for (const [dim, amount] of entries) {
      reservation.charged[dim] = (reservation.charged[dim] ?? 0) + amount;
      ledger.used[dim] += amount;
    }
    return cloneReservation(reservation);
  }

  /**
   * Close a reservation: optionally charge final actuals first, then free
   * whatever hold remains uncharged. Terminal — a settled reservation
   * cannot be charged, settled or released again.
   */
  settle(
    reservationId: string,
    finalAmounts?: Partial<Record<ConsumableDimension, number>>,
  ): BudgetReservation {
    if (finalAmounts && Object.keys(finalAmounts).length > 0) {
      this.charge(reservationId, finalAmounts);
    }
    const { reservation } = this.openReservation(reservationId);
    reservation.status = 'SETTLED';
    reservation.closedAt = this.clock.now();
    return cloneReservation(reservation);
  }

  /**
   * Close a reservation without charging anything further. Amounts already
   * charged stay charged (the work happened); only the uncharged hold is
   * freed. Terminal, like settle().
   */
  release(reservationId: string): BudgetReservation {
    const { reservation } = this.openReservation(reservationId);
    reservation.status = 'RELEASED';
    reservation.closedAt = this.clock.now();
    return cloneReservation(reservation);
  }

  /** One reservation by id (clone), or undefined when unknown. */
  getReservation(id: string): BudgetReservation | undefined {
    const taskId = this.reservationTask.get(id);
    if (taskId === undefined) return undefined;
    const r = this.ledgers.get(taskId)?.reservations.get(id);
    return r ? cloneReservation(r) : undefined;
  }

  /** All reservations, optionally scoped to a task. */
  listReservations(taskId?: string): BudgetReservation[] {
    const out: BudgetReservation[] = [];
    for (const [id, owner] of this.reservationTask) {
      if (taskId !== undefined && owner !== taskId) continue;
      const r = this.ledgers.get(owner)?.reservations.get(id);
      if (r) out.push(cloneReservation(r));
    }
    return out;
  }

  /** Total still-held amount of one dimension across OPEN reservations. */
  held(taskId: string, dimension: ConsumableDimension): number {
    return this.heldOf(this.ledger(taskId), dimension);
  }

  /* -------------------------------------------------------------- *
   * §21.4 / §27.1 unknown amounts — counted, never fabricated       *
   * -------------------------------------------------------------- */

  /**
   * Record that a measurement on `dimension` happened but its amount is
   * unknown (the provider does not report it — classically money on a
   * subscription plan). Returns the task's new unknown count for the
   * dimension. Unknown counts never enter usage()/check(): an unknown
   * amount must not masquerade as a number (§21.4, §27.1).
   */
  recordUnknown(taskId: string, dimension: ConsumableDimension): number {
    const ledger = this.ledger(taskId);
    ledger.unknown[dimension] += 1;
    return ledger.unknown[dimension];
  }

  /** Unknown-measurement counts per dimension for a task (all zeros when
   *  everything the task consumed was measurable). */
  unknownUsage(taskId: string): Record<ConsumableDimension, number> {
    return { ...this.ledger(taskId).unknown };
  }

  /**
   * Remaining budget per dimension (never below zero): what NEW work may
   * still claim, i.e. limit − used − outstanding reservation holds for
   * consumable dimensions (§21.4).
   */
  check(taskId: string): Record<BudgetDimension, number> {
    const ledger = this.ledger(taskId);
    const remaining: Record<BudgetDimension, number> = {
      timeMs: Math.max(0, ledger.budget.timeMs - this.usedOf(ledger, 'timeMs') - this.heldOf(ledger, 'timeMs')),
      tokens: Math.max(0, ledger.budget.tokens - ledger.used.tokens - this.heldOf(ledger, 'tokens')),
      maxConcurrentAgents: Math.max(0, ledger.budget.maxConcurrentAgents - ledger.runningAgents),
      toolCalls: Math.max(0, ledger.budget.toolCalls - ledger.used.toolCalls - this.heldOf(ledger, 'toolCalls')),
      retries: Math.max(0, ledger.budget.retries - ledger.used.retries - this.heldOf(ledger, 'retries')),
      storageBytes: Math.max(0, ledger.budget.storageBytes - ledger.used.storageBytes - this.heldOf(ledger, 'storageBytes')),
      processes: Math.max(0, ledger.budget.processes - ledger.used.processes - this.heldOf(ledger, 'processes')),
      moneyMinor: Math.max(0, ledger.budget.moneyMinor - ledger.used.moneyMinor - this.heldOf(ledger, 'moneyMinor')),
      cpuMs: Math.max(0, ledger.budget.cpuMs - ledger.used.cpuMs - this.heldOf(ledger, 'cpuMs')),
      memoryBytes: Math.max(0, ledger.budget.memoryBytes - ledger.used.memoryBytes - this.heldOf(ledger, 'memoryBytes')),
    };
    return remaining;
  }

  /** Current consumption per dimension (for dashboards). Holds are not
   *  consumption — see held() / listReservations() for outstanding holds,
   *  and unknownUsage() for unmeasurable amounts. */
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
      moneyMinor: ledger.used.moneyMinor,
      cpuMs: ledger.used.cpuMs,
      memoryBytes: ledger.used.memoryBytes,
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
    const ledger = this.ledgers.get(taskId);
    if (ledger) {
      for (const id of ledger.reservations.keys()) this.reservationTask.delete(id);
    }
    this.ledgers.delete(taskId);
  }

  private ledger(taskId: string): TaskLedger {
    let ledger = this.ledgers.get(taskId);
    if (!ledger) {
      ledger = {
        budget: { ...this.defaultBudget },
        used: zeroUsed(),
        unknown: zeroUsed(),
        reservations: new Map(),
        runningAgents: 0,
        startedAt: null,
      };
      this.ledgers.set(taskId, ledger);
    }
    return ledger;
  }

  /** Uncharged hold of one dimension across the task's OPEN reservations. */
  private heldOf(ledger: TaskLedger, dim: ConsumableDimension): number {
    let total = 0;
    for (const r of ledger.reservations.values()) {
      if (r.status !== 'OPEN') continue;
      total += (r.held[dim] ?? 0) - (r.charged[dim] ?? 0);
    }
    return total;
  }

  private openReservation(id: string): { ledger: TaskLedger; reservation: BudgetReservation } {
    const taskId = this.reservationTask.get(id);
    const reservation =
      taskId !== undefined ? this.ledgers.get(taskId)?.reservations.get(id) : undefined;
    if (!reservation || taskId === undefined) {
      throw new Error(`budget reservation ${id} not found`);
    }
    if (reservation.status !== 'OPEN') {
      throw new Error(`budget reservation ${id} already ${reservation.status}`);
    }
    return { ledger: this.ledgers.get(taskId)!, reservation };
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
      condition: blockConditionForDimension(dimension),
    };
    if (this.onExceed) this.onExceed(event);
    throw new BudgetExceededError(dimension, taskId, used, limit);
  }
}

/** Validate a reserve/charge amount map: at least one dimension, every
 *  amount a positive finite number. Returns the surviving entries. */
function positiveEntries(
  amounts: Partial<Record<ConsumableDimension, number>>,
  op: string,
): Array<[ConsumableDimension, number]> {
  const entries: Array<[ConsumableDimension, number]> = [];
  for (const dim of CONSUMABLE_DIMENSIONS) {
    const amount = amounts[dim];
    if (amount === undefined) continue;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`${op} amount for ${dim} must be a positive number`);
    }
    entries.push([dim, amount]);
  }
  if (entries.length === 0) throw new Error(`${op} requires at least one dimension amount`);
  return entries;
}

function cloneReservation(r: BudgetReservation): BudgetReservation {
  return { ...r, held: { ...r.held }, charged: { ...r.charged } };
}

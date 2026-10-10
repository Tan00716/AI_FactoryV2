/**
 * Resource Management types — spec §79.
 *
 * Every task and agent is metered against six budgets:
 *   time, tokens, concurrent agents, tool calls, retries, storage, processes.
 *
 * Priorities come from spec §93 scheduler priorities; the scheduler and the
 * concurrency gate both use them.
 */

export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

/** Ranking helper: lower rank = more urgent (P0 production incident first). */
export const PRIORITY_RANK: Record<TaskPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

/** All budget dimensions defined by §79. */
export type BudgetDimension =
  | 'timeMs'
  | 'tokens'
  | 'maxConcurrentAgents'
  | 'toolCalls'
  | 'retries'
  | 'storageBytes'
  | 'processes';

/** Dimensions that BudgetTracker.consume() can decrement. Concurrency is
 *  enforced by ConcurrencyGate and synced back through recordAgents(). */
export type ConsumableDimension = Exclude<BudgetDimension, 'maxConcurrentAgents'>;

export const CONSUMABLE_DIMENSIONS: readonly ConsumableDimension[] = [
  'timeMs',
  'tokens',
  'toolCalls',
  'retries',
  'storageBytes',
  'processes',
];

export const BUDGET_DIMENSIONS: readonly BudgetDimension[] = [
  'timeMs',
  'tokens',
  'maxConcurrentAgents',
  'toolCalls',
  'retries',
  'storageBytes',
  'processes',
];

/** Resource budget for a single task — §79 example: 30 minutes,
 *  5 repair loops, 4 concurrent agents. */
export interface Budget {
  /** Wall-clock time budget in milliseconds. */
  timeMs: number;
  /** Model token budget (prompt + completion). */
  tokens: number;
  /** Max agents running concurrently for the task. */
  maxConcurrentAgents: number;
  /** Max tool invocations. */
  toolCalls: number;
  /** Max retries / repair loops (§79 example: 5). */
  retries: number;
  /** Storage budget in bytes (evidence, artifacts, scratch). */
  storageBytes: number;
  /** Max OS processes the task may spawn. */
  processes: number;
}

/** §79 example values as the factory default for every new task. */
export const DEFAULT_TASK_BUDGET: Readonly<Budget> = Object.freeze({
  /** 30 minutes — the §79 task-budget example. */
  timeMs: 30 * 60 * 1000,
  tokens: 250_000,
  /** §79 example: 4 concurrent agents. */
  maxConcurrentAgents: 4,
  toolCalls: 500,
  /** §79 example: 5 max repair loops. */
  retries: 5,
  storageBytes: 512 * 1024 * 1024,
  processes: 32,
});

export type UsageRecordKind = 'timeMs' | 'tokens' | 'toolCalls' | 'retries' | 'storageBytes' | 'processes';

/** One metered usage event — the raw input for dashboards. */
export interface UsageRecord {
  taskId: string;
  agentId: string;
  kind: UsageRecordKind;
  amount: number;
  /** Epoch millis; defaults to the recorder's clock. */
  at: number;
}

/** Inject for deterministic time-based tests. */
export interface Clock {
  now: () => number;
}

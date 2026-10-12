/**
 * Resource Management types — spec §79, extended by SPEC_V2 §21.4.
 *
 * Every task and agent is metered against budgets for: time, tokens,
 * concurrent agents, tool calls, retries, storage, processes — plus the
 * §21.4 dimensions the §79 set lacked (G-35): money (when measurable),
 * CPU and RAM. §21.4 also names disk/artifact/log (accounted here under
 * storageBytes) and agent count (maxConcurrentAgents).
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

/** All budget dimensions: §79 plus the §21.4 additions (G-35). */
export type BudgetDimension =
  | 'timeMs'
  | 'tokens'
  | 'maxConcurrentAgents'
  | 'toolCalls'
  | 'retries'
  | 'storageBytes'
  | 'processes'
  /** §21.4 money, in minor units (cents) so amounts stay integral — the
   *  same convention as the db BudgetLedger's amountMinor. Only present
   *  "when measurable"; unmeasurable cost is recorded as unknown usage on
   *  the tracker, never as a fabricated amount (§21.4, §27.1). */
  | 'moneyMinor'
  /** §21.4 CPU: accumulated CPU time in milliseconds. */
  | 'cpuMs'
  /** §21.4 RAM: accounted memory in bytes. */
  | 'memoryBytes';

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
  'moneyMinor',
  'cpuMs',
  'memoryBytes',
];

export const BUDGET_DIMENSIONS: readonly BudgetDimension[] = [
  'timeMs',
  'tokens',
  'maxConcurrentAgents',
  'toolCalls',
  'retries',
  'storageBytes',
  'processes',
  'moneyMinor',
  'cpuMs',
  'memoryBytes',
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
  /** Money budget in minor units (§21.4, when measurable). Factory
   *  default below is a local example value, not a spec figure. */
  moneyMinor: number;
  /** CPU-time budget in milliseconds (§21.4). */
  cpuMs: number;
  /** Memory budget in bytes (§21.4). */
  memoryBytes: number;
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
  /** Local factory defaults for the §21.4 dimensions (the spec sets no
   *  numbers for these): $100.00, 30 CPU-minutes, 2 GiB. */
  moneyMinor: 100_00,
  cpuMs: 30 * 60 * 1000,
  memoryBytes: 2 * 1024 * 1024 * 1024,
});

/** Metered usage kinds: every consumable dimension. */
export type UsageRecordKind = ConsumableDimension;

/** All valid usage-record kinds, for input validation. */
export const USAGE_RECORD_KINDS: readonly UsageRecordKind[] = CONSUMABLE_DIMENSIONS;

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

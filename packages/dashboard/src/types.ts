/**
 * @ai-factory/dashboard — spec §83.
 *
 * Pure aggregation: from snapshots of the existing stores (tasks, agents,
 * QA runs, deployments, approvals, resource usage) compute the §83 status
 * strip and the metric cards. No I/O, no guessing: when a backing dataset
 * is missing or empty the stat value is `null` with note '暂无数据'.
 */

/** Minimal task fields the dashboard needs. */
export interface TaskSnapshot {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** Minimal agent fields the dashboard needs. */
export interface AgentSnapshot {
  id: string;
  status: string;
}

/** Minimal QA-run fields the dashboard needs. */
export interface QaRunSnapshot {
  id: string;
  taskId: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  verdict: string | null;
  /** Loop attempts inside this run (1 = passed first try). */
  attempts: number;
}

/** Minimal deployment fields the dashboard needs. */
export interface DeploymentSnapshot {
  id: string;
  environment: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** Minimal approval fields the dashboard needs. */
export interface ApprovalSnapshot {
  id: string;
  status: string;
  decidedBy: string;
}

/** Rolled-up resource usage (from @ai-factory/resources UsageSummary.totals). */
export interface ResourceUsageSnapshot {
  records: number;
  totals: {
    timeMs: number;
    tokens: number;
    toolCalls: number;
    retries: number;
    storageBytes: number;
    processes: number;
  };
}

/**
 * Minimal outcome fields for the §1.2 primary metric (AOCR).
 * An outcome counts toward the numerator only when it was authorized,
 * completed, AND completed within its scope/budget/risk bounds — a bound
 * flag left undefined means "not recorded as violated".
 */
export interface OutcomeSnapshot {
  id: string;
  /** Was this outcome authorized (获准) by a human / policy? */
  authorized: boolean;
  completed: boolean;
  withinScope?: boolean;
  withinBudget?: boolean;
  withinRisk?: boolean;
}

/** Everything computeDashboardStats needs. All collections may be empty. */
export interface DashboardInput {
  tasks: TaskSnapshot[];
  agents: AgentSnapshot[];
  qaRuns: QaRunSnapshot[];
  deployments: DeploymentSnapshot[];
  approvals: ApprovalSnapshot[];
  /** Optional: omitted / null means no resource data was recorded. */
  resources?: ResourceUsageSnapshot | null;
  /** Optional: omitted / empty means AOCR has no backing data (null, never faked). */
  outcomes?: OutcomeSnapshot[] | null;
}

export type StatValue = number | string | null;

/**
 * One dashboard number. `value` is `null` with note '暂无数据' when there is
 * no backing data — the UI must render the note instead of inventing a 0.
 */
export interface Stat {
  key: string;
  label: string;
  value: StatValue;
  unit?: string;
  /** Which store / dataset the number came from. */
  source: string;
  note?: string;
}

export interface DashboardStatus {
  activeTasks: Stat;
  blockedTasks: Stat;
  runningAgents: Stat;
  qaFailures: Stat;
  latestDeployment: Stat;
  productionStatus: Stat;
  resourceUsage: Stat;
}

export interface DashboardMetrics {
  /** §1.2 PRIMARY metric — Authorized Outcome Completion Rate. */
  authorizedOutcomeCompletionRate: Stat;
  tasksCompleted: Stat;
  firstPassSuccessRate: Stat;
  avgTaskDuration: Stat;
  avgRepairLoops: Stat;
  failedDeployments: Stat;
  rollbackCount: Stat;
  humanInterventions: Stat;
}

export interface DashboardStats {
  generatedAt: string;
  status: DashboardStatus;
  metrics: DashboardMetrics;
}

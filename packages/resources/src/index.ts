/**
 * @ai-factory/resources — Resource Management (spec §79).
 *
 * Budgets per task, usage metering, concurrency gates, and HTTP routes
 * exposing the aggregates to the Dashboard.
 */
export * from './types';
export { BudgetExceededError, BudgetTracker } from './tracker';
export type {
  BudgetExceededEvent,
  BudgetIncreaseRequest,
  BudgetTrackerOptions,
  OnExceedHook,
} from './tracker';
export { UsageRecorder } from './usage';
export type {
  GroupSummary,
  KindTotals,
  SummarizeFilter,
  UsageSummary,
} from './usage';
export { ConcurrencyGate } from './gate';
export type { GateStats } from './gate';
export { registerResourceRoutes } from './routes';
export type {
  ResourceHttpRequest,
  ResourceHttpResponse,
  ResourceRouteDeps,
  ResourceRouter,
} from './routes';

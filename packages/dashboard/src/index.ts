/**
 * @ai-factory/dashboard — spec §83.
 *
 * Pure aggregation of §83 status strip + metric cards from snapshots of the
 * existing stores (tasks, agents, QA runs, deployments, approvals, resource
 * usage). No I/O, no invented data: when a backing dataset is empty the
 * stat value is `null` with note '暂无数据'.
 */
export * from './types';
export {
  computeAuthorizedOutcomeCompletionRate,
  computeDashboardStats,
  latestOf,
  NO_DATA_NOTE,
} from './aggregate';
export type { AocrResult, Clock } from './aggregate';

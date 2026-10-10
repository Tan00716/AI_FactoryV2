/**
 * @ai-factory/coordination — spec §61–§63.
 *
 * Safe parallel scheduling (DAG → parallel batches), file-overlap
 * detection & coordination, and six-kind task locking with an audited,
 * TTL-based LockManager (PROD deployment lock is globally single-active).
 */

export {
  schedule,
  parallelHints,
  ScheduleCycleError,
  UnknownTaskError,
} from './schedule';
export type {
  ScheduleEdge,
  ScheduleEdgeKind,
  ScheduleInput,
  ScheduleOptions,
  ScheduleResult,
} from './schedule';

export {
  detectOverlap,
  resolveOverlap,
  mergeCheck,
  normalizePath,
} from './overlap';
export type {
  OverlapKind,
  OverlapMatch,
  OverlapReport,
  OverlapReport as FileOverlapReport,
  DetectOptions,
  ResolutionStrategy,
  PlanDecision,
  CoordinationPlan,
  TestHook,
  MergeVerdict,
} from './overlap';

export { LockManager } from './locks';
export type {
  LockKind,
  LockEvent,
  LockEventType,
  LockAuditHook,
  Clock,
  AcquireOutcome,
  HeldLock,
  LockManagerOptions,
} from './locks';

export {
  handleCoordinationRoutes,
  registerCoordinationRoutes,
} from './routes';
export type {
  CoordinationRouteContext,
  CoordinationRouteDeps,
  CoordinationHandler,
} from './routes';

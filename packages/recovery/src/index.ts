/**
 * @ai-factory/recovery — snapshot / recovery engine (spec §77–§78).
 *
 * Modules:
 *  - types      failure types, strategies, snapshot manifest
 *  - snapshot   immutable SnapshotStore (take / seal / verify / restore)
 *  - classify   heuristic failure classifier (§78)
 *  - strategies escalation-chain strategy selector (§78)
 *  - loop       RecoveryLoop orchestration with injected strategy hooks
 *  - routes     registerRecoveryRoutes(router, deps) — HTTP surface
 */
export * from './types';
export * from './snapshot';
export * from './classify';
export * from './strategies';
export * from './loop';
export * from './routes';

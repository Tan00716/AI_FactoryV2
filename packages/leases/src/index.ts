/**
 * @ai-factory/leases — SPEC v2 §22 durable leases and ordered resource locks.
 *
 * Modules:
 *  - types      Lease, lock kinds/ranks, typed errors (LeaseConflictError,
 *               StaleOwnerError, LockTimeoutError)
 *  - manager    LeaseManager: single-writer acquire, renew, release,
 *               reassign with monotonic generation + fencing_token,
 *               final-execution-point validate() → STALE_OWNER
 *  - locks      ResourceLockManager: task/file/resource/branch/environment/
 *               deployment locks, global (kind,key) acquisition order,
 *               timeouts, atomic multi-acquire with rollback
 */
export * from './types';
export * from './manager';
export * from './locks';

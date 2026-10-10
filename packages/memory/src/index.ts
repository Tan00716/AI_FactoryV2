/**
 * @ai-factory/memory — structured memory engine (SPEC v2 §43).
 *
 * Modules:
 *  - types    scopes, entry types, statuses, ACL/classification/reuse
 *             fields, MemoryEntry + query/retrieve shapes            [§43.1–§43.2]
 *  - guards   §43.4 prohibitions (secrets, skip-approval conclusions,
 *             manager claims, authorization claims), MemoryError,
 *             source-authority ranking for contradiction resolution [§43.3–§43.4]
 *  - registry observable index/cache/backup reference registry used to
 *             prove purge cleanup                                    [§43.3]
 *  - store    in-memory MemoryStore: write guards, dedup/merge,
 *             ACL-first retrieve(), contradictions, expiry, confidence
 *             decay, verify(), purge()                               [§43.3]
 *  - lessons  task-end evaluation → Lesson/Failure entries
 *  - sql      MEMORY_SCHEMA DDL for packages/db                     [§43.2]
 */
export * from './types';
export * from './guards';
export * from './registry';
export * from './store';
export * from './lessons';
export * from './sql';

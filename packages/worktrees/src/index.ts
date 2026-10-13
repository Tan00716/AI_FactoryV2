/**
 * @ai-factory/worktrees — worktree allocator (spec §22.1). Public API.
 */
export {
  WorktreeAllocator,
  WorktreeError,
  WorktreeUnavailableError,
  WorktreeReleaseRefusedError,
  pathWithin,
  type WorktreeAuditHook,
  type AllocateInput,
  type AllocateResult,
  type WorktreeAllocatorOptions,
} from './allocator';
export type {
  WorktreeRecord,
  WorktreeStatus,
  WorktreeKind,
  WorktreeStore,
} from '@ai-factory/db';

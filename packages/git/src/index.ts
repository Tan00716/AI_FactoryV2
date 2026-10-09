/**
 * @ai-factory/git — Git engine (spec §34). Public API surface.
 */
export {
  GitRepo,
  GitError,
  type GitStatus,
  type BranchInfo,
  type MergeResult,
  type CommitOptions,
  type LogEntry,
  type MutatingOptions,
  type GitAuditHook,
} from './git';
export {
  taskBranchName,
  ensureTaskBranch,
  type EnsureTaskBranchOptions,
} from './taskBranch';
export {
  defaultBranchProtection,
  isProtected,
  assertPushAllowed,
  ProtectedBranchError,
  type BranchProtection,
} from './protection';
export {
  codeChangeEvidencePayload,
  mergeEvidencePayload,
  PrStore,
  type PrStatus,
  type PrRecord,
  type CreatePrInput,
  type CodeChangeLogEntry,
} from './evidence';

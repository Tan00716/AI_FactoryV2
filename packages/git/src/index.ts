/**
 * @ai-factory/git — Git engine (spec §34). Public API surface.
 */
export {
  GitRepo,
  GitError,
  type GitStatus,
  type BranchInfo,
  type MergeResult,
  type MergePreview,
  type CommitOptions,
  type LogEntry,
  type MutatingOptions,
  type GitAuditHook,
} from './git';
export {
  GitBroker,
  GitBrokerDeniedError,
  defaultGitBrokerPolicy,
  GIT_ACTIONS,
  type GitAction,
  type GitBrokerContext,
  type GitBrokerDecision,
  type GitBrokerPolicy,
  type GitBrokerAuditHook,
  type GitBrokerOptions,
} from './broker';
export {
  MergeQueue,
  type MergeQueueEntry,
  type MergeQueueEntryStatus,
  type MergeQueueCheck,
  type MergeCandidateVerification,
  type MergeCandidateVerifier,
  type MergeQueueHooks,
  type MergeQueueOptions,
  type MergeQueueEntryPersistence,
} from './mergeQueue';
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
  changeEvidenceFields,
  PrStore,
  type PrStoreApi,
  type PrStatus,
  type PrRecord,
  type CreatePrInput,
  type CodeChangeLogEntry,
  type ChangeEvidenceFields,
} from './evidence';

/**
 * Shared domain types for the AI Engineering Factory prototype.
 * Spec references: §8 Task System, §11 Task Status System,
 * §15 AI Employee, §17 Autonomy Levels, §42 Evidence Engine, §44 Permissions.
 */

/** §11 — default workflow states (happy path). */
export type WorkflowState =
  | 'TODO'
  | 'PLANNING'
  | 'IN_PROGRESS'
  | 'CODE_REVIEW'
  | 'PENDING_QA'
  | 'QA'
  | 'PENDING_UAT_MERGE'
  | 'UAT'
  | 'PENDING_PROD'
  | 'PROD_DEPLOYING'
  | 'PROD_VERIFICATION'
  | 'DONE';

/** §11 — exception states. */
export type ExceptionState =
  | 'BLOCKED'
  | 'QA_FAILED'
  | 'UAT_FAILED'
  | 'PROD_FAILED'
  | 'ROLLBACK'
  | 'CANCELLED'
  | 'REJECTED'
  | 'ESCALATED';

export type TaskStatus = WorkflowState | ExceptionState;

/** Terminal states: no outgoing transitions. */
export const TERMINAL_STATES: ReadonlySet<TaskStatus> = new Set([
  'DONE',
  'CANCELLED',
  'REJECTED',
]);

/** §42 — evidence kinds the gates understand. */
export type EvidenceType =
  | 'plan'
  | 'code_change'
  | 'code_review'
  | 'ci_result'
  | 'qa_result'
  | 'security_report'
  | 'approval'
  | 'merge'
  | 'deployment'
  | 'smoke_test'
  | 'uat_result';

export type EvidenceStatus = 'DRAFT' | 'SEALED';

/** §37-style machine-readable verdict payloads live inside `payload`. */
export interface Evidence {
  id: string;
  taskId: string;
  type: EvidenceType;
  title: string;
  /** Arbitrary machine-readable payload, e.g. { verdict:'PASS', total:524, passed:524 }. */
  payload: Record<string, unknown>;
  status: EvidenceStatus;
  createdBy: string;
  createdAt: string;
  sealedAt: string | null;
  /**
   * §16/§18.2 — the requirement version this evidence was collected
   * against, as a pin ref ('REQ-001@1'), recorded at registration time
   * when a real requirement context exists. null/absent means "never
   * recorded" (evidence predating version tracking, or collected with no
   * requirement context): gates treat unrecorded evidence as not stale —
   * a version is never invented for it after the fact.
   */
  requirementVersion?: string | null;
}

/** §8 — Task object (prototype subset of the full field list). */
export interface Task {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  title: string;
  goal: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  severity: 'BLOCKER' | 'CRITICAL' | 'MAJOR' | 'MINOR' | 'TRIVIAL';
  acceptanceCriteria: string[];
  constraints: string[];
  workspace: string;
  creator: string;
  status: TaskStatus;
  currentAgentId: string | null;
  assignedAgentIds: string[];
  subtaskIds: string[];
  /** §60 — dependency edges: { kind, taskId }. */
  dependencies: TaskDependency[];
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** SPEC_V2 §18–§20 — v2 state separation (optional; managed by WorkflowEngineV2). */
  v2?: TaskV2Extension;
}

/** §60 — dependency relationship kinds. */
export type DependencyKind =
  | 'blocked_by'
  | 'depends_on'
  | 'parallel_with'
  | 'child_of'
  | 'related_to';

/** SPEC_V2 §18–§20 — v2 three-state separation on Task (optional; owned by WorkflowEngineV2). */
import type {
  ConditionRecord,
  LifecycleMilestone,
  MilestoneStatus,
  ReleaseState,
  WorkflowStage,
} from './workflow-v2';

export interface TaskV2Extension {
  /** §18.1 workflow stage (13 stages). */
  workflowStage?: WorkflowStage;
  /** §18.3 independent condition field. */
  condition?: ConditionRecord;
  /** §19 lifecycle milestones. */
  milestones?: Partial<Record<LifecycleMilestone, MilestoneStatus>>;
  /** §19 current effective release state (history kept separately). */
  releaseState?: ReleaseState;
  /** §20.1 final seal: 1 only after finalize() commits DONE atomically. */
  finalSeal?: 0 | 1;
  /** Optimistic-concurrency version, bumped on every v2 mutation. */
  taskVersion?: number;
}

export interface TaskDependency {
  kind: DependencyKind;
  taskId: string;
}

/** §17 — autonomy levels 0–5. */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** §44 — capability permission strings (prototype subset). */
export type Permission =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'filesystem.delete'
  | 'shell.execute'
  | 'git.commit'
  | 'git.push'
  | 'git.merge'
  | 'github.pull_request'
  | 'database.read'
  | 'database.write'
  | 'deploy.dev'
  | 'deploy.uat'
  | 'deploy.prod'
  | 'secret.read'
  | 'secret.write' // §44 full list: added additively (policy package needs it)
  | 'agent.create'
  | 'agent.modify'
  | 'agent.delete'
  | 'mcp.install'
  | 'skill.install'
  | 'workflow.modify';

export const ALL_PERMISSIONS: ReadonlyArray<Permission> = [
  'filesystem.read',
  'filesystem.write',
  'filesystem.delete',
  'shell.execute',
  'git.commit',
  'git.push',
  'git.merge',
  'github.pull_request',
  'database.read',
  'database.write',
  'deploy.dev',
  'deploy.uat',
  'deploy.prod',
  'secret.read',
  'secret.write', // §44 full list: added additively (policy package needs it)
  'agent.create',
  'agent.modify',
  'agent.delete',
  'mcp.install',
  'skill.install',
  'workflow.modify',
];

/** §15 — AI Employee definition (prototype subset). */
export interface Agent {
  id: string;
  name: string;
  displayName: string;
  jobTitle: string;
  department: string;
  parentAgentId: string | null;
  mission: string;
  instructions: string;
  skills: string[];
  rules: string[];
  model: string;
  reasoningLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  tools: string[];
  permissions: Permission[];
  autonomyLevel: AutonomyLevel;
  status: 'ONLINE' | 'IDLE' | 'WORKING' | 'BLOCKED' | 'FAILED' | 'PAUSED' | 'ARCHIVED';
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** §70 — immutable audit record. §32 adds reason/result + hash-chain fields. */
export interface AuditRecord {
  id: string;
  ts: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  /**
   * §32 — why the action was taken (caller-supplied justification).
   * Optional: records written before §32 chaining, and callers that pass no
   * reason, simply lack it. Never part of the caller's `details` bag.
   */
  reason?: string;
  /**
   * §32 — outcome of the action (e.g. 'ALLOWED' / 'DENIED' / 'SUCCEEDED'),
   * caller-supplied via AuditLog.record's opts. Optional like `reason`.
   */
  result?: string;
  /**
   * §32 — sha256 over the canonical record content + `prevHash`, computed by
   * AuditLog at append time; callers can never supply it. Absent on legacy
   * records written before hash chaining existed (see verifyAuditChain).
   */
  summaryHash?: string;
  /**
   * §32 — `summaryHash` of the previous chained record, or the genesis
   * constant for the first chained record. Absent on legacy records.
   */
  prevHash?: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

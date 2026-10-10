/**
 * Workflow state machine v2 — SPEC_V2 §18 (three-state separation) + §19 milestones.
 *
 * v1 (workflow.ts) mixed 12 happy-path stages with 8 exception states in one
 * flat union. v2 stores three INDEPENDENT facts per task:
 *
 *   1. WorkflowStage     — the 13 pipeline stages (§18.1), incl. OUTCOME_VERIFICATION
 *   2. ConditionRecord   — ACTIVE / WAITING / BLOCKED / PAUSED / QUOTA_LIMITED /
 *                          REWORK / ESCALATED / FAILED / CANCELLED / REJECTED (§18.3),
 *                          with reason / resume_state / blocked_on
 *   3. Lifecycle milestones — IMPLEMENTED / VERIFIED / RELEASED /
 *                          OUTCOME_VERIFIED / DONE (§19); independent facts,
 *                          e.g. IMPLEMENTED does NOT imply merged, VERIFIED does
 *                          NOT imply released.
 *
 * Every transition declares Entry Conditions, Required Evidence, Gate
 * Predicates, Allowed Next / Failure Conditions. Denials return one of the
 * 16 machine reason codes (SPEC_V2 §49; local stand-in in reason-codes.ts).
 *
 * This module is additive: v1 workflow.ts is untouched for compatibility.
 */

import { Evidence, TaskStatus } from './types';
import { EvidenceRequirement, evaluateGate } from './workflow';
import { ReasonCode } from './reason-codes';

/** SPEC_V2 §18.1 — the 13 workflow stages (no exception states mixed in). */
export type WorkflowStage =
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
  | 'OUTCOME_VERIFICATION'
  | 'DONE';

export const WORKFLOW_STAGES: ReadonlyArray<WorkflowStage> = [
  'TODO',
  'PLANNING',
  'IN_PROGRESS',
  'CODE_REVIEW',
  'PENDING_QA',
  'QA',
  'PENDING_UAT_MERGE',
  'UAT',
  'PENDING_PROD',
  'PROD_DEPLOYING',
  'PROD_VERIFICATION',
  'OUTCOME_VERIFICATION',
  'DONE',
];

/** SPEC_V2 §18.3 — condition is an independent field, not a stage. */
export type TaskConditionValue =
  | 'ACTIVE'
  | 'WAITING'
  | 'BLOCKED'
  | 'PAUSED'
  | 'QUOTA_LIMITED'
  | 'REWORK'
  | 'ESCALATED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REJECTED';

export interface ConditionRecord {
  condition: TaskConditionValue;
  reason: string;
  /** Stage to resume at when the condition clears (null = stay). */
  resumeState: WorkflowStage | null;
  /** Refs this condition is blocked on (task ids, dependency ids, …). */
  blockedOn: string[];
  updatedAt: string;
  updatedBy: string;
}

/** SPEC_V2 §19 — five lifecycle milestones, independent facts. */
export type LifecycleMilestone =
  | 'IMPLEMENTED'
  | 'VERIFIED'
  | 'RELEASED'
  | 'OUTCOME_VERIFIED'
  | 'DONE';

export interface MilestoneStatus {
  achieved: boolean;
  at: string | null;
  evidenceRef: string | null;
}

/** Current effective release state. History is kept separately (§19). */
export type ReleaseState = 'NONE' | 'RELEASED' | 'ROLLED_BACK';

/** Actor authorization snapshot used by gate predicates (§17.2). */
export interface ActorAuthorization {
  status: 'AUTHORIZED' | 'WAITING_HUMAN_DISPATCH' | 'REVOKED' | 'EXPIRED';
  expiresAt: string | null;
}

/** Everything a gate predicate may inspect. */
export interface GateContext {
  taskId: string;
  /** Current optimistic-concurrency version of the task. */
  taskVersion: number;
  actor: string;
  actorRole?: string;
  authorization: ActorAuthorization;
  /** Pinned requirement, e.g. 'REQ-001@2'. Null = not pinned. */
  requirementVersion: string | null;
  candidateDigest: string | null;
  /** Set for independence checks (reviewer must differ from implementer). */
  implementerId: string | null;
  /** Fresh evidence attached to the task. */
  evidence: Evidence[];
  /** evidenceId -> requirement version the evidence was collected against. */
  evidenceReqVersions: Record<string, string>;
  staleEvidenceIds: string[];
  budgetOk: boolean;
  quotaOk: boolean;
  confinementOk: boolean;
  dependenciesReady: boolean;
  /** Optimistic concurrency: reject when the request was built on an old version. */
  expectedTaskVersion?: number;
}

/** One code-evaluated gate predicate (§18.2 "Gate Predicates"). */
export interface GatePredicate {
  id: string;
  description: string;
  reasonCode: ReasonCode;
  check: (ctx: GateContext) => boolean;
}

/** A single allowed edge in the v2 state graph (§18.2 transition contract). */
export interface TransitionDefV2 {
  /** AI intent name, e.g. START_TASK (§18.2). */
  intent: string;
  to: WorkflowStage;
  /** Human-readable entry conditions. */
  entryConditions: string[];
  requiredEvidence: EvidenceRequirement[];
  gatePredicates: GatePredicate[];
  /** Condition values reachable as failure outcomes of this edge. */
  failureConditions: TaskConditionValue[];
  approverPolicy?: string;
  timeoutMs?: number;
  note: string;
}

const R = (
  type: Evidence['type'],
  label: string,
  verdict?: string,
): EvidenceRequirement => ({ type, label, verdict });

function authOk(ctx: GateContext): boolean {
  if (ctx.authorization.status !== 'AUTHORIZED') return false;
  if (ctx.authorization.expiresAt === null) return true;
  return Date.now() < new Date(ctx.authorization.expiresAt).getTime();
}

const P_AUTHORIZED: GatePredicate = {
  id: 'authorization-valid',
  description: 'Actor authorization is AUTHORIZED and not expired',
  reasonCode: 'AUTHORIZATION_EXPIRED',
  check: authOk,
};

const P_REQUIREMENT_PINNED: GatePredicate = {
  id: 'requirement-pinned',
  description: 'Requirement version is pinned (e.g. REQ-001@2)',
  reasonCode: 'POLICY_DENIED',
  check: (c) => c.requirementVersion !== null,
};

const P_BUDGET: GatePredicate = {
  id: 'budget-available',
  description: 'Budget reservation covers this transition',
  reasonCode: 'BUDGET_EXCEEDED',
  check: (c) => c.budgetOk,
};

const P_QUOTA: GatePredicate = {
  id: 'quota-available',
  description: 'Model quota available for this transition',
  reasonCode: 'QUOTA_LIMITED',
  check: (c) => c.quotaOk,
};

const P_CONFINEMENT: GatePredicate = {
  id: 'confinement-available',
  description: 'Execution confinement is available (fail-closed otherwise)',
  reasonCode: 'CONFINEMENT_UNAVAILABLE',
  check: (c) => c.confinementOk,
};

const P_DEPS_READY: GatePredicate = {
  id: 'dependencies-ready',
  description: 'Hard dependencies are satisfied',
  reasonCode: 'DEPENDENCY_NOT_READY',
  check: (c) => c.dependenciesReady,
};

const P_CANDIDATE_FIXED: GatePredicate = {
  id: 'candidate-fixed',
  description: 'Candidate revision is fixed (digest pinned)',
  reasonCode: 'POLICY_DENIED',
  check: (c) => c.candidateDigest !== null,
};

function approvalPresent(label: string): GatePredicate {
  return {
    id: 'approval-present',
    description: label,
    reasonCode: 'APPROVAL_REQUIRED',
    check: (c) =>
      c.evidence.some(
        (e) =>
          e.type === 'approval' &&
          (e.payload as { verdict?: unknown }).verdict === 'APPROVED',
      ),
  };
}

const P_INDEPENDENT_REVIEWER: GatePredicate = {
  id: 'reviewer-independent',
  description: 'Review acceptor differs from the implementer (§19 independence)',
  reasonCode: 'INDEPENDENCE_REQUIRED',
  check: (c) =>
    c.implementerId === null || c.actor !== c.implementerId,
};

const BASE = [P_AUTHORIZED, P_REQUIREMENT_PINNED];

/**
 * Default v2 workflow definition (§18.1). Keys are the source stage.
 * DONE is terminal: no outgoing edges.
 */
export const DEFAULT_TRANSITIONS_V2: Record<WorkflowStage, TransitionDefV2[]> = {
  TODO: [
    {
      intent: 'START_TASK', to: 'PLANNING',
      entryConditions: ['Task is AUTHORIZED', 'Requirement version pinned'],
      requiredEvidence: [], gatePredicates: [...BASE],
      failureConditions: ['BLOCKED', 'ESCALATED', 'CANCELLED', 'REJECTED'],
      note: 'AI PM picks up the task',
    },
  ],
  PLANNING: [
    {
      intent: 'START_TASK', to: 'IN_PROGRESS',
      entryConditions: ['Plan, AC, scope, dependencies and budget validated'],
      requiredEvidence: [R('plan', 'Planning artifact (PLAN)')],
      gatePredicates: [...BASE, P_BUDGET],
      failureConditions: ['BLOCKED', 'ESCALATED'],
      note: 'Plan approved, squad assigned',
    },
  ],
  IN_PROGRESS: [
    {
      intent: 'SUBMIT_FOR_REVIEW', to: 'CODE_REVIEW',
      entryConditions: ['Delegation and workspace lease valid', 'Candidate revision fixed'],
      requiredEvidence: [R('code_change', 'Code change artifact (commit/PR)')],
      gatePredicates: [...BASE, P_CANDIDATE_FIXED, P_CONFINEMENT],
      failureConditions: ['REWORK', 'BLOCKED'],
      note: 'Implementation submitted',
    },
  ],
  CODE_REVIEW: [
    {
      intent: 'REQUEST_QA', to: 'PENDING_QA',
      entryConditions: ['Reviewer accepted the current candidate', 'Reviewer independent of implementer'],
      requiredEvidence: [R('code_review', 'Code review verdict = PASS', 'PASS')],
      gatePredicates: [...BASE, P_INDEPENDENT_REVIEWER],
      failureConditions: ['REWORK', 'BLOCKED'],
      note: 'Review approved',
    },
    {
      intent: 'SUBMIT_FOR_REVIEW', to: 'IN_PROGRESS',
      entryConditions: ['Changes requested'],
      requiredEvidence: [],
      gatePredicates: [...BASE],
      failureConditions: [],
      note: 'Changes requested — back to coder',
    },
  ],
  PENDING_QA: [
    {
      intent: 'REQUEST_QA', to: 'QA',
      entryConditions: ['QA environment and test plan ready'],
      requiredEvidence: [],
      gatePredicates: [...BASE, P_QUOTA],
      failureConditions: ['BLOCKED'],
      note: 'QA run started',
    },
  ],
  QA: [
    {
      intent: 'REQUEST_QA', to: 'PENDING_UAT_MERGE',
      entryConditions: ['Review/QA/CI/Security gates valid for the current candidate'],
      requiredEvidence: [
        R('code_review', 'Code review verdict = PASS', 'PASS'),
        R('ci_result', 'CI result = PASS', 'PASS'),
        R('qa_result', 'QA result = PASS', 'PASS'),
        R('security_report', 'Security report = PASS', 'PASS'),
      ],
      gatePredicates: [...BASE, P_DEPS_READY],
      failureConditions: ['REWORK', 'BLOCKED', 'ESCALATED', 'FAILED'],
      note: 'All quality gates passed',
    },
  ],
  PENDING_UAT_MERGE: [
    {
      intent: 'REQUEST_UAT', to: 'UAT',
      entryConditions: ['Approved immutable artifact deployed to UAT'],
      requiredEvidence: [R('merge', 'Merge artifact (PR merged)')],
      gatePredicates: [...BASE, P_CANDIDATE_FIXED],
      failureConditions: ['BLOCKED'],
      note: 'Merged to UAT branch',
    },
  ],
  UAT: [
    {
      intent: 'REQUEST_UAT', to: 'PENDING_PROD',
      entryConditions: ['Business AC accepted in UAT'],
      requiredEvidence: [R('uat_result', 'UAT result = PASS', 'PASS')],
      gatePredicates: [...BASE],
      failureConditions: ['REWORK', 'BLOCKED', 'FAILED'],
      note: 'UAT accepted',
    },
  ],
  PENDING_PROD: [
    {
      intent: 'REQUEST_PROD', to: 'PROD_DEPLOYING',
      entryConditions: ['UAT, risk, reversibility, recovery and approvals checked'],
      requiredEvidence: [],
      gatePredicates: [
        ...BASE,
        approvalPresent('Production deployment approval (APPROVED)'),
      ],
      approverPolicy: 'human-or-release-authority',
      failureConditions: ['REJECTED', 'BLOCKED'],
      note: 'Production gate approved',
    },
  ],
  PROD_DEPLOYING: [
    {
      intent: 'REQUEST_PROD', to: 'PROD_VERIFICATION',
      entryConditions: ['Deployment lease, capability, approval object and environment valid'],
      requiredEvidence: [R('deployment', 'Deployment artifact')],
      gatePredicates: [...BASE],
      failureConditions: ['FAILED'],
      note: 'Deployed',
    },
  ],
  PROD_VERIFICATION: [
    {
      intent: 'REQUEST_PROD', to: 'OUTCOME_VERIFICATION',
      entryConditions: ['Released object healthy; promotion and observation nominal'],
      requiredEvidence: [R('smoke_test', 'Production smoke test = PASS', 'PASS')],
      gatePredicates: [...BASE],
      failureConditions: ['FAILED'],
      note: 'Promoted to outcome observation',
    },
  ],
  OUTCOME_VERIFICATION: [
    {
      intent: 'REQUEST_COMPLETE', to: 'DONE',
      entryConditions: [
        'Released version current',
        'Observation window complete',
        'AC outcome decidable',
        'All applicable completion predicates hold (checked by finalize, same transaction)',
      ],
      requiredEvidence: [],
      gatePredicates: [...BASE],
      failureConditions: ['REWORK', 'ESCALATED', 'FAILED'],
      note: 'Outcome verified — finalize via finalize(), not a plain transition',
    },
  ],
  DONE: [],
};

/** AI intents (§18.2) mapped to their target stage. */
export const INTENT_TARGETS: Record<string, WorkflowStage> = {
  START_TASK: 'PLANNING',
  SUBMIT_FOR_REVIEW: 'CODE_REVIEW',
  REQUEST_QA: 'PENDING_QA',
  REQUEST_UAT: 'UAT',
  REQUEST_PROD: 'PROD_DEPLOYING',
  REQUEST_COMPLETE: 'DONE',
};

export type TransitionCheckV2 =
  | {
      ok: true;
      from: WorkflowStage;
      to: WorkflowStage;
      intent: string;
      consumedEvidence: Evidence[];
      /** Set when the result came from the idempotency cache (§18.2). */
      deduped?: boolean;
    }
  | {
      ok: false;
      from: WorkflowStage;
      to: WorkflowStage;
      reasonCode: ReasonCode;
      missing: string[];
    };

function deny(
  from: WorkflowStage,
  to: WorkflowStage,
  reasonCode: ReasonCode,
  missing: string[],
): TransitionCheckV2 {
  return { ok: false, from, to, reasonCode, missing };
}

/**
 * Pure gate check for a v2 transition. Denial order (deterministic):
 * unknown edge → stale version → missing evidence → stale evidence →
 * failed predicates. Does NOT mutate anything.
 */
export function checkTransitionV2(
  from: WorkflowStage,
  to: WorkflowStage,
  ctx: GateContext,
): TransitionCheckV2 {
  const edge = (DEFAULT_TRANSITIONS_V2[from] ?? []).find((e) => e.to === to);
  if (!edge) {
    return deny(
      from, to, 'POLICY_DENIED',
      [`Illegal jump ${from} → ${to}: no such edge in the v2 workflow`],
    );
  }

  if (
    ctx.expectedTaskVersion !== undefined &&
    ctx.expectedTaskVersion !== ctx.taskVersion
  ) {
    return deny(
      from, to, 'VERSION_CONFLICT',
      [
        `Concurrent stale request: expected task version ${ctx.expectedTaskVersion}, current is ${ctx.taskVersion}`,
      ],
    );
  }

  // v1 evaluateGate only reads `.requires`; the v1 TaskStatus union predates
  // OUTCOME_VERIFICATION, hence the narrow cast at the v1/v2 boundary.
  const gate = evaluateGate(
    { to: edge.to as unknown as TaskStatus, requires: edge.requiredEvidence, note: edge.note },
    ctx.evidence,
  );
  if (!gate.allowed) {
    return deny(from, to, 'MISSING_EVIDENCE', gate.missing);
  }
  const consumed = gate.satisfiedBy.filter(
    (e): e is Evidence => e !== null,
  );

  for (const ev of consumed) {
    if (ctx.staleEvidenceIds.includes(ev.id)) {
      return deny(
        from, to, 'STALE_EVIDENCE',
        [`Evidence ${ev.id} (${ev.title}) is stale — re-verify before promotion`],
      );
    }
    const evReq = ctx.evidenceReqVersions[ev.id];
    if (
      ctx.requirementVersion !== null &&
      evReq !== undefined &&
      evReq !== ctx.requirementVersion
    ) {
      return deny(
        from, to, 'STALE_EVIDENCE',
        [
          `Evidence ${ev.id} was collected against ${evReq}, task now requires ${ctx.requirementVersion}`,
        ],
      );
    }
  }

  const failed = edge.gatePredicates.filter((p) => !p.check(ctx));
  if (failed.length > 0) {
    return deny(
      from, to, failed[0].reasonCode,
      failed.map((p) => `${p.description} [${p.id}]`),
    );
  }

  return { ok: true, from, to, intent: edge.intent, consumedEvidence: consumed };
}

/** Convenience: legal next stages for a task (for UI). */
export function allowedNextStages(stage: WorkflowStage): TransitionDefV2[] {
  return DEFAULT_TRANSITIONS_V2[stage] ?? [];
}

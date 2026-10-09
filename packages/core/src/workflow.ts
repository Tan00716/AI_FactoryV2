/**
 * Workflow state machine — spec §11 (default state flow) + §12 (gates).
 *
 * Principle (§2.3 / §2.4): the Workflow Engine — not the AI — decides whether
 * a transition is valid, and evidence beats claims. Every transition declares
 * the evidence its gate requires; `requestTransition` refuses the move and
 * reports exactly what is missing when the gate cannot be satisfied.
 */

import {
  Evidence,
  EvidenceType,
  Task,
  TaskStatus,
  nowIso,
} from './types';

/** One evidence requirement of a gate (§12 "Required Evidence"). */
export interface EvidenceRequirement {
  type: EvidenceType;
  /** Human-readable label used in denial messages. */
  label: string;
  /**
   * When set, the evidence payload must carry this exact verdict
   * (e.g. 'PASS' for quality gates, 'BLOCK' for rejections).
   * When unset, mere presence of the evidence satisfies the requirement.
   * §37 machine-readable results.
   */
  verdict?: string;
}

/** A single allowed edge in the state graph (§12 "Allowed Next States"). */
export interface TransitionDef {
  to: TaskStatus;
  /** Gate: evidence that must be present (and passing) before the move. */
  requires: EvidenceRequirement[];
  /** Short note shown in UI / denial messages. */
  note: string;
}

const R = (type: EvidenceType, label: string, verdict?: string): EvidenceRequirement => ({
  type,
  label,
  verdict,
});

/**
 * Default workflow definition (§11). Keys are the source state.
 * Exception states (§11) are wired in as failure / recovery edges.
 */
export const DEFAULT_TRANSITIONS: Record<TaskStatus, TransitionDef[]> = {
  TODO: [
    { to: 'PLANNING', requires: [], note: 'AI PM picks up the task' },
    { to: 'CANCELLED', requires: [], note: 'Task withdrawn' },
  ],
  PLANNING: [
    { to: 'IN_PROGRESS', requires: [R('plan', 'Planning artifact (PLAN)')], note: 'Plan approved, squad assigned' },
    { to: 'BLOCKED', requires: [], note: 'Planning blocked' },
    { to: 'CANCELLED', requires: [], note: 'Task withdrawn' },
  ],
  IN_PROGRESS: [
    { to: 'CODE_REVIEW', requires: [R('code_change', 'Code change artifact (commit/PR)')], note: 'Implementation submitted' },
    { to: 'BLOCKED', requires: [], note: 'Implementation blocked' },
    { to: 'CANCELLED', requires: [], note: 'Task withdrawn' },
  ],
  CODE_REVIEW: [
    {
      to: 'PENDING_QA',
      requires: [R('code_review', 'Code review verdict = PASS', 'PASS')],
      note: 'Review approved',
    },
    { to: 'IN_PROGRESS', requires: [], note: 'Changes requested — back to coder' },
    {
      to: 'REJECTED',
      requires: [R('code_review', 'Code review verdict = BLOCK', 'BLOCK')],
      note: 'Review blocked the change',
    },
  ],
  PENDING_QA: [
    { to: 'QA', requires: [], note: 'QA run started' },
    { to: 'CANCELLED', requires: [], note: 'Task withdrawn' },
  ],
  QA: [
    {
      // §12 example: QA → PENDING UAT MERGE requires review + CI + QA + security evidence.
      to: 'PENDING_UAT_MERGE',
      requires: [
        R('code_review', 'Code review verdict = PASS', 'PASS'),
        R('ci_result', 'CI result = PASS', 'PASS'),
        R('qa_result', 'QA result = PASS', 'PASS'),
        R('security_report', 'Security report = PASS', 'PASS'),
      ],
      note: 'All quality gates passed',
    },
    { to: 'QA_FAILED', requires: [], note: 'QA reported failures' },
    { to: 'BLOCKED', requires: [], note: 'QA blocked' },
  ],
  QA_FAILED: [
    { to: 'IN_PROGRESS', requires: [], note: 'Failure analyzed — fix assigned' },
    { to: 'ESCALATED', requires: [], note: 'Repeated failure escalated to human' },
  ],
  PENDING_UAT_MERGE: [
    { to: 'UAT', requires: [R('merge', 'Merge artifact (PR merged)')], note: 'Merged to UAT branch' },
    { to: 'BLOCKED', requires: [], note: 'Merge blocked' },
  ],
  UAT: [
    { to: 'PENDING_PROD', requires: [R('uat_result', 'UAT result = PASS', 'PASS')], note: 'UAT accepted' },
    { to: 'UAT_FAILED', requires: [], note: 'UAT rejected' },
    { to: 'BLOCKED', requires: [], note: 'UAT blocked' },
  ],
  UAT_FAILED: [
    { to: 'IN_PROGRESS', requires: [], note: 'UAT issues sent back for fix' },
    { to: 'ESCALATED', requires: [], note: 'Escalated to human' },
  ],
  PENDING_PROD: [
    {
      to: 'PROD_DEPLOYING',
      requires: [R('approval', 'Production deployment approval')],
      note: 'Production gate approved (§41)',
    },
    { to: 'CANCELLED', requires: [], note: 'Release cancelled' },
  ],
  PROD_DEPLOYING: [
    { to: 'PROD_VERIFICATION', requires: [R('deployment', 'Deployment artifact')], note: 'Deployed' },
    { to: 'PROD_FAILED', requires: [], note: 'Deployment failed' },
  ],
  PROD_VERIFICATION: [
    { to: 'DONE', requires: [R('smoke_test', 'Production smoke test = PASS', 'PASS')], note: 'Verified in production' },
    { to: 'PROD_FAILED', requires: [], note: 'Smoke test failed' },
    { to: 'ROLLBACK', requires: [], note: 'Rolling back' },
  ],
  PROD_FAILED: [
    { to: 'ROLLBACK', requires: [], note: 'Rollback initiated' },
    { to: 'ESCALATED', requires: [], note: 'Escalated to human' },
  ],
  ROLLBACK: [
    { to: 'IN_PROGRESS', requires: [], note: 'Rolled back — fix and retry' },
    { to: 'ESCALATED', requires: [], note: 'Rollback failed — escalate' },
  ],
  BLOCKED: [
    { to: 'IN_PROGRESS', requires: [], note: 'Unblocked — resume work' },
    { to: 'PLANNING', requires: [], note: 'Unblocked — replan' },
    { to: 'ESCALATED', requires: [], note: 'Cannot unblock — escalate' },
    { to: 'CANCELLED', requires: [], note: 'Task withdrawn' },
  ],
  ESCALATED: [
    { to: 'IN_PROGRESS', requires: [], note: 'Human resolved — resume' },
    { to: 'CANCELLED', requires: [], note: 'Human cancelled' },
  ],
  DONE: [],
  CANCELLED: [],
  REJECTED: [],
};

/** Result of a gate evaluation (§12). */
export interface GateEvaluation {
  allowed: boolean;
  /** Evidence records that satisfied each requirement (parallel to requires). */
  satisfiedBy: (Evidence | null)[];
  /** Human-readable list of what is missing — used in denial messages. */
  missing: string[];
}

/**
 * Evaluate a gate against the evidence attached to a task.
 * "Evidence beats claims" (§2.4): a claim like "tests passed" without a
 * matching evidence record (with a passing verdict when required) fails.
 */
export function evaluateGate(
  transition: TransitionDef,
  evidence: Evidence[],
): GateEvaluation {
  const satisfiedBy: (Evidence | null)[] = [];
  const missing: string[] = [];

  for (const req of transition.requires) {
    const hit = evidence.find((e) => {
      if (e.type !== req.type) return false;
      if (req.verdict === undefined) return true;
      return (e.payload as { verdict?: unknown }).verdict === req.verdict;
    });
    satisfiedBy.push(hit ?? null);
    if (!hit) {
      missing.push(
        req.verdict !== undefined
          ? `${req.label} — missing or verdict ≠ ${req.verdict}`
          : `${req.label} — missing`,
      );
    }
  }

  return { allowed: missing.length === 0, satisfiedBy, missing };
}

export interface TransitionRequest {
  task: Task;
  to: TaskStatus;
  actor: string;
  /** Evidence currently attached to the task (fresh read). */
  evidence: Evidence[];
}

export type TransitionResult =
  | {
      ok: true;
      from: TaskStatus;
      to: TaskStatus;
      /** Evidence records consumed (and sealed) by this gate. */
      consumedEvidence: Evidence[];
    }
  | {
      ok: false;
      from: TaskStatus;
      to: TaskStatus;
      reason: 'UNKNOWN_TRANSITION' | 'GATE_DENIED';
      /** Exactly what is missing — surfaced to the requester. */
      missing: string[];
    };

/**
 * Pure gate check: is this transition defined, and does the evidence
 * satisfy its gate? Does NOT mutate anything (mutation happens in the
 * engine via the store, so sealing + audit stay atomic-ish).
 */
export function checkTransition(req: TransitionRequest): TransitionResult {
  const edges = DEFAULT_TRANSITIONS[req.task.status] ?? [];
  const edge = edges.find((e) => e.to === req.to);
  if (!edge) {
    return {
      ok: false,
      from: req.task.status,
      to: req.to,
      reason: 'UNKNOWN_TRANSITION',
      missing: [
        `No transition ${req.task.status} → ${req.to} in the default workflow`,
      ],
    };
  }

  const gate = evaluateGate(edge, req.evidence);
  if (!gate.allowed) {
    return {
      ok: false,
      from: req.task.status,
      to: req.to,
      reason: 'GATE_DENIED',
      missing: gate.missing,
    };
  }

  const consumed = gate.satisfiedBy.filter((e): e is Evidence => e !== null);
  return { ok: true, from: req.task.status, to: req.to, consumedEvidence: consumed };
}

/** Convenience: list the legal next states for a task (for UI). */
export function allowedNextStates(status: TaskStatus): TransitionDef[] {
  return DEFAULT_TRANSITIONS[status] ?? [];
}

/** Timestamp helper shared by engine mutations. */
export function stamp(): string {
  return nowIso();
}

export { nowIso };

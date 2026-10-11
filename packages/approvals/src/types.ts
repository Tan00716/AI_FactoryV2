/**
 * Approval domain types — SPEC v2 §23.3 (approval object).
 *
 * Field names follow §23.3 verbatim: approval_id, action_digest, task_id,
 * requirement_version, candidate_digest, environment, risk/reversibility_ref,
 * evidence_manifest_hash, policy_version, requester, required_approvers,
 * deadline, status, decision, decision_reason, decided_at.
 *
 * Lifecycle: PENDING → APPROVED | REJECTED | CANCELLED | EXPIRED
 *            APPROVED → INVALIDATED (bound context changed: candidate digest,
 *            evidence manifest hash, policy version, or environment)
 *
 * Approval levels for sensitive actions (§23.4): AUTO, AI_REVIEW_PLUS_POLICY,
 * HUMAN_APPROVAL, BLOCKED.
 */

/** §23.4 — risk classification of the requested action. */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** §23.3 — approval lifecycle states. INVALIDATED is new in v2. */
export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'INVALIDATED';

/** §23.4 — how much review a sensitive tool action needs. */
export type ApprovalLevel = 'AUTO' | 'AI_REVIEW_PLUS_POLICY' | 'HUMAN_APPROVAL' | 'BLOCKED';

/**
 * §23.3 approval object. An approval binds a decision to an exact context:
 * action digest, candidate digest, evidence manifest hash, policy version and
 * environment. If any of those change after APPROVED, the approval is
 * INVALIDATED and must be re-requested — an old approval can never be used
 * to deploy new code.
 */
export interface Approval {
  /** §23.3 approval_id. */
  approval_id: string;
  /** §23.3 action_digest: sha256 of the canonical action being approved. */
  action_digest: string;
  /** Human-readable action name, e.g. 'deploy.prod' (display/audit; the
   * digest is the binding). */
  action: string;
  /** §23.3 task_id. */
  task_id: string;
  /** §23.3 requirement_version. */
  requirement_version: string;
  /** §23.3 candidate_digest: digest of the code/artifact being approved. */
  candidate_digest: string;
  /** §23.3 environment: target environment name/fingerprint. */
  environment: string;
  /** §23.3 risk level. */
  risk_level: RiskLevel;
  /** §23.3 reversibility_ref: reference to the reversibility assessment. */
  reversibility_ref: string;
  /** §23.3 evidence_manifest_hash: hash of the evidence manifest at request time. */
  evidence_manifest_hash: string;
  /** §23.3 policy_version: policy version the evaluation ran against. */
  policy_version: string;
  /** §23.3 requester: identity that requested the approval. */
  requester: string;
  /**
   * §23.3 required_approvers (array). Entries are identities ('human:alice')
   * or role prefixes ('human'). A decider satisfies the requirement when its
   * identity matches an entry exactly or matches a role prefix
   * ('human' matches 'human' and 'human:alice').
   */
  required_approvers: string[];
  /** §23.3 deadline: ISO timestamp; null = never expires. */
  deadline: string | null;
  /** §23.3 status. */
  status: ApprovalStatus;
  /** §23.3 decision: '' while undecided. */
  decision: '' | 'APPROVED' | 'REJECTED';
  /** §23.3 decision_reason: human/machine-readable rationale. */
  decision_reason: string;
  /** Identity that made the decision ('' while undecided). */
  decided_by: string;
  /** §23.3 decided_at. */
  decided_at: string | null;
  /** Creation timestamp. */
  created_at: string;
}

/** Minimal storage contract — in-memory here, SQLite-backed in @ai-factory/db. */
export interface ApprovalStore {
  save(a: Approval): void;
  get(id: string): Approval | undefined;
  list(status?: ApprovalStatus): Approval[];
  listByTask(taskId: string): Approval[];
}

function copyApproval(a: Approval): Approval {
  return { ...a, required_approvers: [...a.required_approvers] };
}

export class InMemoryApprovalStore implements ApprovalStore {
  private map = new Map<string, Approval>();

  save(a: Approval): void {
    this.map.set(a.approval_id, copyApproval(a));
  }

  get(id: string): Approval | undefined {
    const a = this.map.get(id);
    return a ? copyApproval(a) : undefined;
  }

  list(status?: ApprovalStatus): Approval[] {
    return [...this.map.values()]
      .filter((a) => status === undefined || a.status === status)
      .sort((x, y) => x.created_at.localeCompare(y.created_at))
      .map(copyApproval);
  }

  listByTask(taskId: string): Approval[] {
    return [...this.map.values()]
      .filter((a) => a.task_id === taskId)
      .sort((x, y) => x.created_at.localeCompare(y.created_at))
      .map(copyApproval);
  }
}

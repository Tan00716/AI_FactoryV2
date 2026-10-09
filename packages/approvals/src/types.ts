/**
 * Approval domain types — spec §45 (Tool Approval) + §69 (Approval System).
 *
 * Sensitive actions carry an ApprovalLevel:
 *   AUTO           — no approval needed, runs immediately
 *   AI_REVIEW      — an AI reviewer must approve first
 *   HUMAN_APPROVAL — a human must approve first
 *   BLOCKED        — cannot run at all (policy forbids it)
 *
 * An Approval tracks one human/AI decision over a sensitive action. Once an
 * approval is APPROVED, its payload can be attached to a task as 'approval'
 * evidence, which satisfies the PENDING_PROD → PROD_DEPLOYING gate (§41).
 */

/** §69 — risk classification of the requested action. */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** §69 — approval lifecycle states. */
export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED';

/** §45 — how much review a sensitive tool action needs. */
export type ApprovalLevel = 'AUTO' | 'AI_REVIEW' | 'HUMAN_APPROVAL' | 'BLOCKED';

/** §69 — approval object fields. */
export interface Approval {
  id: string;
  /** Sensitive action requested, e.g. 'deploy.prod', 'secret.read'. */
  action: string;
  requestedBy: string;
  agentId: string;
  taskId: string;
  riskLevel: RiskLevel;
  /** Evidence record IDs supporting the request (context for the approver). */
  evidenceIds: string[];
  /** Who is allowed to decide: 'human', an agent id, a role… */
  requiredApprover: string;
  status: ApprovalStatus;
  decision: '' | 'APPROVED' | 'REJECTED';
  decidedBy: string;
  createdAt: string;
  decidedAt: string | null;
  /** Null = never expires. */
  expiresAt: string | null;
}

/** Minimal storage contract — in-memory here, SQLite-backed in @ai-factory/db. */
export interface ApprovalStore {
  save(a: Approval): void;
  get(id: string): Approval | undefined;
  list(status?: ApprovalStatus): Approval[];
  listByTask(taskId: string): Approval[];
}

export class InMemoryApprovalStore implements ApprovalStore {
  private map = new Map<string, Approval>();

  save(a: Approval): void {
    this.map.set(a.id, {
      ...a,
      evidenceIds: [...a.evidenceIds],
    });
  }

  get(id: string): Approval | undefined {
    const a = this.map.get(id);
    return a ? { ...a, evidenceIds: [...a.evidenceIds] } : undefined;
  }

  list(status?: ApprovalStatus): Approval[] {
    return [...this.map.values()]
      .filter((a) => status === undefined || a.status === status)
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
      .map((a) => ({ ...a, evidenceIds: [...a.evidenceIds] }));
  }

  listByTask(taskId: string): Approval[] {
    return [...this.map.values()]
      .filter((a) => a.taskId === taskId)
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
      .map((a) => ({ ...a, evidenceIds: [...a.evidenceIds] }));
  }
}

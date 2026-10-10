/**
 * Improvement proposals (§58): PROPOSED → APPROVED → APPLIED, with
 * REJECTED as the alternative terminal state.
 *
 * Governance rule (spec §58, reinforced by §59): a proposal may only reach
 * APPLIED after a recorded approval. Critical organization-rule proposals
 * need an explicit human/governance approver. The board NEVER moves
 * PROPOSED → APPLIED directly — no silent modification.
 */
import { randomUUID } from 'node:crypto';
import {
  ImprovementProposal,
  NewProposal,
  ProposalKind,
  ProposalStatus,
} from './types';

export interface ProposalBoardOptions {
  /** Defaults to `Date.now`; inject a fake clock in tests/demos. */
  now?: () => number;
  /**
   * Decides whether a proposal may skip human approval (policy auto-approve,
   * spec §59). Default: nothing auto-approves; callers encode their policy.
   * A critical org rule can never be auto-approved: `autoApprove` returning
   * true for one is rejected as a policy error.
   */
  autoApprove?: (proposal: ImprovementProposal) => boolean;
  /**
   * Decides whether an approver is allowed to approve this proposal.
   * Default: humans ('human:*') and 'governance' may approve anything;
   * agents may only approve non-critical proposals.
   */
  canApprove?: (proposal: ImprovementProposal, approver: string) => boolean;
}

export class ProposalTransitionError extends Error {
  readonly from: ProposalStatus;
  readonly to: ProposalStatus;

  constructor(from: ProposalStatus, to: ProposalStatus, reason: string) {
    super(`Invalid proposal transition ${from} → ${to}: ${reason}`);
    this.name = 'ProposalTransitionError';
    this.from = from;
    this.to = to;
  }
}

const TERMINAL: ProposalStatus[] = ['APPLIED', 'REJECTED'];

function defaultCanApprove(proposal: ImprovementProposal, approver: string): boolean {
  const isHumanOrGovernance = approver === 'governance' || approver.startsWith('human:');
  if (proposal.criticalOrgRule) return isHumanOrGovernance;
  return true;
}

export class ProposalBoard {
  private proposals = new Map<string, ImprovementProposal>();
  private readonly nowFn: () => number;
  private readonly autoApprove?: (proposal: ImprovementProposal) => boolean;
  private readonly canApprove: (proposal: ImprovementProposal, approver: string) => boolean;

  constructor(options: ProposalBoardOptions = {}) {
    this.nowFn = options.now ?? Date.now;
    this.autoApprove = options.autoApprove;
    this.canApprove = options.canApprove ?? defaultCanApprove;
  }

  /**
   * Create a proposal in PROPOSED state. If the board's policy auto-approves
   * it, the proposal moves PROPOSED → APPROVED immediately with the policy
   * recorded as the approver — never straight to APPLIED.
   */
  propose(input: NewProposal): ImprovementProposal {
    const proposal: ImprovementProposal = {
      proposalId: `prop_${randomUUID()}`,
      kind: input.kind,
      title: input.title,
      description: input.description,
      criticalOrgRule: input.criticalOrgRule ?? input.kind === 'org-rule',
      status: 'PROPOSED',
      proposedBy: input.proposedBy,
      lessonIds: [...(input.lessonIds ?? [])],
      createdAt: this.nowFn(),
    };
    this.proposals.set(proposal.proposalId, proposal);

    if (this.autoApprove?.(proposal)) {
      this.transition(proposal.proposalId, 'APPROVED', {
        approver: 'policy:auto-approve',
      });
    }
    return this.get(proposal.proposalId)!;
  }

  get(proposalId: string): ImprovementProposal | undefined {
    return this.proposals.get(proposalId);
  }

  all(): ImprovementProposal[] {
    return [...this.proposals.values()];
  }

  pending(): ImprovementProposal[] {
    return this.all().filter((p) => p.status === 'PROPOSED');
  }

  /** Approve a PROPOSED proposal. Records who approved and when. */
  approve(proposalId: string, approver: string): ImprovementProposal {
    const p = this.require(proposalId);
    if (p.status !== 'PROPOSED') {
      throw new ProposalTransitionError(p.status, 'APPROVED', 'only PROPOSED proposals can be approved');
    }
    if (!this.canApprove(p, approver)) {
      throw new ProposalTransitionError(
        p.status,
        'APPROVED',
        `approver "${approver}" may not approve a critical organization-rule proposal`,
      );
    }
    return this.transition(proposalId, 'APPROVED', { approver });
  }

  /** Reject a PROPOSED (or APPROVED) proposal — terminal. */
  reject(proposalId: string, approver: string, reason?: string): ImprovementProposal {
    const p = this.require(proposalId);
    if (p.status === 'PROPOSED' || p.status === 'APPROVED') {
      const next = this.transition(proposalId, 'REJECTED', { approver });
      if (reason) next.description = `${next.description} [rejection reason: ${reason}]`;
      return next;
    }
    throw new ProposalTransitionError(p.status, 'REJECTED', 'only PROPOSED/APPROVED proposals can be rejected');
  }

  /**
   * Apply an APPROVED proposal — the only transition into APPLIED.
   * Throws for anything not APPROVED, so unapproved work can never be
   * applied and critical org rules are never silently modified.
   */
  apply(proposalId: string): ImprovementProposal {
    const p = this.require(proposalId);
    if (p.status !== 'APPROVED') {
      throw new ProposalTransitionError(
        p.status,
        'APPLIED',
        p.status === 'PROPOSED'
          ? 'proposal must be approved before it can be applied'
          : 'only APPROVED proposals can be applied',
      );
    }
    return this.transition(proposalId, 'APPLIED', {});
  }

  private require(proposalId: string): ImprovementProposal {
    const p = this.proposals.get(proposalId);
    if (!p) throw new Error(`Unknown proposal: ${proposalId}`);
    return p;
  }

  private transition(
    proposalId: string,
    to: ProposalStatus,
    opts: { approver?: string },
  ): ImprovementProposal {
    const p = this.require(proposalId);
    const from = p.status;
    if (TERMINAL.includes(from)) {
      throw new ProposalTransitionError(from, to, 'proposal is terminal');
    }
    const allowed: Record<ProposalStatus, ProposalStatus[]> = {
      PROPOSED: ['APPROVED', 'REJECTED'],
      APPROVED: ['APPLIED', 'REJECTED'],
      REJECTED: [],
      APPLIED: [],
    };
    if (!allowed[from].includes(to)) {
      throw new ProposalTransitionError(from, to, 'transition not allowed');
    }
    // Policy safety net: critical org rules can never be auto-approved.
    if (to === 'APPROVED' && opts.approver === 'policy:auto-approve' && p.criticalOrgRule) {
      throw new ProposalTransitionError(
        from,
        to,
        'critical organization-rule proposals require explicit approval',
      );
    }
    const now = this.nowFn();
    p.status = to;
    if (to === 'APPROVED' || to === 'REJECTED') {
      p.decidedAt = now;
      p.decidedBy = opts.approver;
    }
    if (to === 'APPLIED') p.appliedAt = now;
    this.proposals.set(proposalId, { ...p });
    return this.get(proposalId)!;
  }
}

/** Convenience: is this proposal kind a critical org rule by default? */
export function isCriticalKind(kind: ProposalKind): boolean {
  return kind === 'org-rule';
}

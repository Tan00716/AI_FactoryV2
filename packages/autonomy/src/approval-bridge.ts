/**
 * Approval bridge — loose integration point with @ai-factory/approvals.
 *
 * requireApproval(action, mode) answers: does this action need an approval,
 * and what kind? The approval type vocabulary (human / ai-review / auto)
 * intentionally mirrors the approvals package's ApprovalLevel
 * (HUMAN_APPROVAL / AI_REVIEW / AUTO) WITHOUT importing it — there is no
 * hard dependency; a coordinator can translate ApprovalType into real
 * Approval records when the approvals package is wired in.
 */
import { decide, DecideOptions } from './decide';
import { ActionInput, AutonomyMode } from './types';
import type { AutonomyDecision } from './decide';

/**
 * Loose approval type. human ≈ HUMAN_APPROVAL, ai-review ≈ AI_REVIEW,
 * auto ≈ AUTO in @ai-factory/approvals.
 */
export type ApprovalType = 'human' | 'ai-review' | 'auto';

export interface ApprovalRequirement {
  /** Whether an approval step is required before the action runs. */
  required: boolean;
  approvalType: ApprovalType;
  /** The underlying §80 decision this requirement was derived from. */
  decision: AutonomyDecision;
}

/**
 * Map a §80 autonomy decision to an approval requirement.
 * - auto       → not required, type 'auto'
 * - ai-review  → required, type 'ai-review'
 * - human      → required, type 'human'
 * - denied     → required, type 'human' (only a human may override policy)
 */
export function requireApproval(
  action: ActionInput,
  mode: AutonomyMode,
  opts: DecideOptions = {},
): ApprovalRequirement {
  const decision = decide(action, mode, opts);
  switch (decision.outcome) {
    case 'auto':
      return { required: false, approvalType: 'auto', decision };
    case 'ai-review':
      return { required: true, approvalType: 'ai-review', decision };
    case 'human':
    case 'denied':
      return { required: true, approvalType: 'human', decision };
  }
}

/**
 * Translate an ApprovalType to the approvals package's ApprovalLevel
 * vocabulary. Kept as a pure string mapping so this package stays
 * dependency-free; the coordinator applies it to real Approval records.
 */
export function approvalTypeToLevel(
  t: ApprovalType,
): 'HUMAN_APPROVAL' | 'AI_REVIEW' | 'AUTO' {
  return t === 'human' ? 'HUMAN_APPROVAL' : t === 'ai-review' ? 'AI_REVIEW' : 'AUTO';
}

/**
 * Workflow gate integration (spec §12).
 *
 * A code review produces gate evidence of type 'code_review'; the workflow
 * state machine only advances past the review gate when the verdict passes.
 */
import { Finding, ReviewResult, ReviewSummary, ReviewVerdict } from './types';

/** §12 gate evidence payload for a completed code review. */
export interface CodeReviewEvidencePayload {
  type: 'code_review';
  verdict: ReviewVerdict;
  findings: Finding[];
  summary: ReviewSummary;
  reviewedAt: string;
}

/** Build the §12 gate evidence payload from a review result. */
export function reviewGateEvidence(
  review: ReviewResult,
): CodeReviewEvidencePayload {
  return {
    type: 'code_review',
    verdict: review.verdict,
    findings: review.findings,
    summary: review.summary,
    reviewedAt: review.reviewedAt,
  };
}

/**
 * Whether a review verdict opens the workflow gate.
 * Only PASS / PASS_WITH_WARNINGS let the change proceed; anything else
 * denies the transition (§12: missing required condition → denied).
 */
export function meetsGate(verdict: ReviewVerdict): boolean {
  return verdict === 'PASS' || verdict === 'PASS_WITH_WARNINGS';
}

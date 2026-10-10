/**
 * Review independence enforcement — SPEC v2 §37.
 *
 * Independence is a Gate precondition, checked in code before any review
 * verdict can open a workflow gate:
 *   - reviewer and implementer must be different effective execution identities;
 *   - the Gate Store / Evidence Collector must NOT be writable by the implementer;
 *   - the review must run in an independent Run with its own verification context;
 *   - high-risk reviews additionally require a different runtime/provider.
 *
 * "Same model, different name" is not independence. When no independent
 * reviewer is available the gate is BLOCKED — we never fabricate one.
 */
import type { ReasonCode } from '@ai-factory/api-contracts';
import type { ReviewInput, ReviewResult } from './types';
import { reviewCode } from './reviewer';

/** Context describing who implemented the change and who would review it. */
export interface IndependenceContext {
  /** Effective execution identity of the reviewer (not just a display name). */
  reviewerId: string;
  /** Run in which the review executes. */
  reviewerRunId: string;
  /** Effective execution identity of the implementer. */
  implementerId: string;
  /** Run in which the implementation was produced. */
  implementerRunId: string;
  /** True when the implementer can write the Gate Store. */
  gateStoreWritableByImplementer: boolean;
  /** True when the implementer can write the Evidence Collector. */
  collectorWritableByImplementer: boolean;
  /** High-risk changes need a different runtime/provider, not just a name. */
  highRisk?: boolean;
  reviewerRuntimeId?: string;
  implementerRuntimeId?: string;
}

/** Thrown when any independence precondition fails. Carries the §49 reason code. */
export class IndependenceRequiredError extends Error {
  readonly code: ReasonCode = 'INDEPENDENCE_REQUIRED';
  readonly failedChecks: string[];
  constructor(failedChecks: string[]) {
    super(
      `Review independence check failed (${failedChecks.join('; ')}). ` +
        'Self-review is not allowed; the gate stays closed.',
    );
    this.name = 'IndependenceRequiredError';
    this.failedChecks = failedChecks;
  }
}

/**
 * Assert all §37 independence preconditions. Throws IndependenceRequiredError
 * listing every failed check (fail-closed: no partial credit).
 */
export function assertReviewIndependence(ctx: IndependenceContext): void {
  const failed: string[] = [];
  const rid = (ctx.reviewerId ?? '').trim();
  const iid = (ctx.implementerId ?? '').trim();
  if (!rid || !iid) {
    failed.push('reviewer and implementer identities must both be known');
  } else if (rid === iid) {
    failed.push(
      `reviewer '${rid}' is the implementer — self-review is forbidden`,
    );
  }
  if ((ctx.reviewerRunId ?? '').trim() === (ctx.implementerRunId ?? '').trim()) {
    failed.push('review must run in an independent Run, not the implementation Run');
  }
  if (ctx.gateStoreWritableByImplementer) {
    failed.push('Gate Store is writable by the implementer');
  }
  if (ctx.collectorWritableByImplementer) {
    failed.push('Evidence Collector is writable by the implementer');
  }
  if (ctx.highRisk) {
    const rr = (ctx.reviewerRuntimeId ?? '').trim();
    const ir = (ctx.implementerRuntimeId ?? '').trim();
    if (!rr || !ir || rr === ir) {
      failed.push(
        'high-risk review requires a different runtime/provider (same model under another name is not independent)',
      );
    }
  }
  if (failed.length > 0) throw new IndependenceRequiredError(failed);
}

/** Outcome of trying to staff an independent review. */
export type IndependentReviewPlan =
  | { status: 'STAFFED'; reviewerId: string; reviewerRunId: string }
  | { status: 'BLOCKED'; reason: string };

/**
 * Staff an independent reviewer from the candidate pool.
 * Candidates are filtered by assertReviewIndependence; when none qualifies
 * the result is BLOCKED with an explicit reason — never a fabricated reviewer.
 */
export function planIndependentReview(
  candidates: Array<{ reviewerId: string; reviewerRunId: string }>,
  base: Omit<IndependenceContext, 'reviewerId' | 'reviewerRunId'>,
): IndependentReviewPlan {
  const rejected: string[] = [];
  for (const c of candidates) {
    try {
      assertReviewIndependence({ ...base, ...c });
      return { status: 'STAFFED', reviewerId: c.reviewerId, reviewerRunId: c.reviewerRunId };
    } catch (err) {
      rejected.push(
        `${c.reviewerId}: ${err instanceof IndependenceRequiredError ? err.failedChecks.join('; ') : String(err)}`,
      );
    }
  }
  return {
    status: 'BLOCKED',
    reason:
      'No independent reviewer available. ' +
      (rejected.length > 0 ? `Rejected: ${rejected.join(' | ')}` : 'Candidate pool is empty.') +
      ' Gate stays closed; do not fabricate a reviewer.',
  };
}

/**
 * Convenience wrapper: enforce independence, then run the deterministic review.
 * The implementer's own claims ("already verified") are readable context for
 * the reviewer but never evidence — reviewCode() only inspects files/diffs.
 */
export function reviewWithIndependence(
  input: ReviewInput,
  independence: IndependenceContext,
): ReviewResult {
  assertReviewIndependence(independence);
  return reviewCode(input);
}

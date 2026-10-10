/**
 * @ai-factory/knowledge — lifecycle state machine (spec §53).
 *
 *   DISCOVERED → UNVERIFIED → VALIDATED → EVALUATED → APPROVED → ACTIVE
 *       → DEPRECATED → RETIRED
 *
 * Gates on the forward path:
 *  - UNVERIFIED → VALIDATED  needs ≥ verificationThreshold(source) verifications [§51]
 *  - VALIDATED → EVALUATED   needs a passing evaluation score                   [§53]
 *  - EVALUATED → APPROVED    needs an explicit approval decision                [§53]
 *  - APPROVED → ACTIVE       needs a published + externally-approved proposal
 *                            applied through the promotion pipeline — new
 *                            knowledge MUST pass evaluation, never becomes
 *                            system truth silently                              [§51, §53]
 *
 * Every transition records a timestamp and the actor.
 */
import {
  verificationThreshold,
} from './sources';
import type {
  Clock,
  KnowledgeItem,
  LifecycleState,
  LifecycleTransition,
} from './types';
import { LifecycleError, systemClock } from './types';

/** Evidence that can satisfy lifecycle gates. */
export interface TransitionEvidence {
  /** Independent verifications (gate: UNVERIFIED → VALIDATED). */
  verifications?: Array<{ method: string; verifiedAt: number; by: string; notes?: string }>;
  /** Evaluation result (gate: VALIDATED → EVALUATED). */
  evaluation?: { score: number; passed: boolean; evaluatedAt: number; by: string };
  /** Human/external approval (gate: EVALUATED → APPROVED). */
  approval?: { approved: boolean; by: string; decidedAt: number };
  /** Id of the published proposal that was externally approved+applied
   *  (gate: APPROVED → ACTIVE). */
  appliedProposalId?: string;
}

export interface TransitionOptions {
  actor: string;
  note?: string;
  evidence?: TransitionEvidence;
  clock?: Clock;
}

/** Legal next states for each lifecycle state. */
export const ALLOWED_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  DISCOVERED: ['UNVERIFIED'],
  UNVERIFIED: ['VALIDATED'],
  VALIDATED: ['EVALUATED'],
  EVALUATED: ['APPROVED'],
  APPROVED: ['ACTIVE'],
  ACTIVE: ['DEPRECATED'],
  DEPRECATED: ['RETIRED'],
  RETIRED: [],
};

const EVALUATION_PASS_SCORE = 60;

/**
 * Apply one lifecycle transition. Throws LifecycleError when the
 * transition is illegal or a gate is not satisfied.
 */
export function transitionItem(
  item: KnowledgeItem,
  to: LifecycleState,
  opts: TransitionOptions,
): { item: KnowledgeItem; transition: LifecycleTransition } {
  const from = item.state;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new LifecycleError(
      `Illegal lifecycle transition for knowledge item ${item.id}: ` +
        `${from} → ${to}. Allowed next states from ${from}: ` +
        (allowed.length ? allowed.join(', ') : '(none — terminal state)') +
        '. New knowledge must pass each stage in order and may only become ' +
        'ACTIVE after evaluation and externally approved publication.',
      item.id,
      from,
      to,
    );
  }

  const evidence = opts.evidence ?? {};
  checkGate(item, from, to, evidence);

  const clock = opts.clock ?? systemClock;
  const transition: LifecycleTransition = {
    itemId: item.id,
    from,
    to,
    at: clock.now(),
    actor: opts.actor,
    ...(opts.note ? { note: opts.note } : {}),
  };

  const next: KnowledgeItem = {
    ...item,
    state: to,
    updatedAt: transition.at,
    version: item.version + 1,
  };
  return { item: next, transition };
}

function gateError(
  item: KnowledgeItem,
  from: LifecycleState,
  to: LifecycleState,
  reason: string,
): LifecycleError {
  return new LifecycleError(
    `Transition ${from} → ${to} for knowledge item ${item.id} rejected: ${reason}`,
    item.id,
    from,
    to,
  );
}

function checkGate(
  item: KnowledgeItem,
  from: LifecycleState,
  to: LifecycleState,
  evidence: TransitionEvidence,
): void {
  if (from === 'UNVERIFIED' && to === 'VALIDATED') {
    const need = verificationThreshold(item.source.type);
    const have = evidence.verifications?.length ?? 0;
    if (have < need) {
      throw gateError(
        item,
        from,
        to,
        `requires ${need} independent verification(s) for source type ` +
          `'${item.source.type}' (credibility-based threshold), got ${have}.`,
      );
    }
  }

  if (from === 'VALIDATED' && to === 'EVALUATED') {
    const ev = evidence.evaluation;
    if (!ev) {
      throw gateError(
        item,
        from,
        to,
        'requires a completed evaluation before EVALUATED — new knowledge must pass evaluation.',
      );
    }
    if (!ev.passed || ev.score < EVALUATION_PASS_SCORE) {
      throw gateError(
        item,
        from,
        to,
        `evaluation did not pass (score ${ev.score}, need ≥ ${EVALUATION_PASS_SCORE} and passed=true).`,
      );
    }
  }

  if (from === 'EVALUATED' && to === 'APPROVED') {
    const approval = evidence.approval;
    if (!approval?.approved) {
      throw gateError(
        item,
        from,
        to,
        'requires an explicit approval decision (approval.approved === true).',
      );
    }
  }

  if (from === 'APPROVED' && to === 'ACTIVE') {
    if (!evidence.appliedProposalId) {
      throw gateError(
        item,
        from,
        to,
        'requires a published proposal that was externally approved and applied ' +
          '(evidence.appliedProposalId). Knowledge must never silently rewrite agents — ' +
          'publication only produces proposal/notice objects.',
      );
    }
  }
}

/** Minimum evaluation score that counts as a pass. */
export { EVALUATION_PASS_SCORE };

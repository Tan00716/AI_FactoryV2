/**
 * V3-#7 rollback: mark steps after a target step 'superseded', never delete.
 *
 * Rules enforced here (the route layer only maps TimelineError to HTTP):
 *  - The target step must exist; an unknown label is an error, not a no-op.
 *  - A step that is already superseded cannot be rolled back to: the
 *    boundary only ever moves backwards to an earlier live step.
 *  - Steps at or before the target keep their original status and results;
 *    steps after it become 'superseded' (their original results stay in
 *    the record; only the status changes, and supersededAt records when).
 *  - Re-rollback to an earlier step extends the superseded range; it can
 *    never shrink it (no un-superseding).
 */
import { TimelineError, type TimelineRun } from './types.ts';

export interface RollbackResult {
  run: TimelineRun;
  /** Labels newly superseded by this rollback (empty when rolling back to the last step). */
  superseded: string[];
}

export function applyRollback(
  run: TimelineRun,
  stepLabel: string,
  nowIso: string,
): RollbackResult {
  const target = run.steps.findIndex((s) => s.label === stepLabel);
  if (target < 0) {
    throw new TimelineError(`no step ${stepLabel} in this timeline`, 'step-not-found');
  }
  const targetStep = run.steps[target];
  if (targetStep === undefined || targetStep.status === 'superseded') {
    throw new TimelineError(`step ${stepLabel} is already superseded`, 'already-superseded');
  }
  const superseded: string[] = [];
  const steps = run.steps.map((s, i) => {
    if (i <= target) return s;
    if (s.status !== 'superseded') superseded.push(s.label);
    return {
      ...s,
      status: 'superseded' as const,
      supersededAt: s.supersededAt ?? nowIso,
    };
  });
  return {
    run: {
      ...run,
      steps,
      supersededFrom: stepLabel,
      supersededAt: nowIso,
      rollbackCount: run.rollbackCount + 1,
    },
    superseded,
  };
}

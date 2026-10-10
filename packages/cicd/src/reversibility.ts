/**
 * Reversibility classification — SPEC v2 §41.2.
 *
 * REVERSIBLE / CONDITIONALLY_REVERSIBLE / COMPENSATABLE / IRREVERSIBLE_UNKNOWN.
 * Code rollback is not data rollback. A fake rollback of an irreversible
 * migration is forbidden — the error names what to do instead.
 */

export type ReversibilityClass =
  | 'REVERSIBLE'
  | 'CONDITIONALLY_REVERSIBLE'
  | 'COMPENSATABLE'
  | 'IRREVERSIBLE_UNKNOWN';

export interface ChangeDescriptor {
  kind: 'code' | 'db-migration' | 'data-write' | 'external-notify' | 'config' | 'secret-rotation';
  backwardCompatible?: boolean;
  hasDownMigration?: boolean;
  destructive?: boolean;
  compensationRunbook?: string;
}

/** Classify the reversibility of a change. Unknown → IRREVERSIBLE_UNKNOWN (strict). */
export function classifyReversibility(change: ChangeDescriptor): ReversibilityClass {
  if (change.destructive) return 'IRREVERSIBLE_UNKNOWN';
  switch (change.kind) {
    case 'code':
      return 'REVERSIBLE';
    case 'config':
      return 'REVERSIBLE';
    case 'secret-rotation':
      return 'CONDITIONALLY_REVERSIBLE';
    case 'db-migration':
      if (change.backwardCompatible === false) return 'IRREVERSIBLE_UNKNOWN';
      return change.hasDownMigration ? 'CONDITIONALLY_REVERSIBLE' : 'COMPENSATABLE';
    case 'data-write':
      return change.compensationRunbook ? 'COMPENSATABLE' : 'IRREVERSIBLE_UNKNOWN';
    case 'external-notify':
      return 'IRREVERSIBLE_UNKNOWN';
    default:
      return 'IRREVERSIBLE_UNKNOWN';
  }
}

export class FakeRollbackForbiddenError extends Error {
  constructor(detail: string) {
    super(
      `Fake rollback forbidden: ${detail}. ` +
        'An irreversible/unknown change cannot be "rolled back" — use an approved compensation runbook, roll-forward, or escalate.',
    );
    this.name = 'FakeRollbackForbiddenError';
  }
}

/**
 * Assert that an automatic recovery action is safe for the reversibility class.
 * Automatic emergency rollback is only allowed when the path is confirmed
 * safe-reversible or a pre-approved compensation runbook exists (§41.6).
 */
export function assertSafeAutoRecovery(input: {
  reversibility: ReversibilityClass;
  recoveryPathSafe: boolean;
  preapprovedCompensationRunbook?: string;
}): void {
  if (input.reversibility === 'REVERSIBLE' && input.recoveryPathSafe) return;
  if (
    (input.reversibility === 'CONDITIONALLY_REVERSIBLE' ||
      input.reversibility === 'COMPENSATABLE') &&
    (input.recoveryPathSafe || input.preapprovedCompensationRunbook)
  ) {
    return;
  }
  throw new FakeRollbackForbiddenError(
    `reversibility=${input.reversibility}, recoveryPathSafe=${input.recoveryPathSafe}`,
  );
}

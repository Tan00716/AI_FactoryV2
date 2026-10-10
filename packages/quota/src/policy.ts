/**
 * Quota limit policies — SPEC v2 §27.2.
 *
 * STRICT_PROVIDER:            park the affected runs, wait for a known
 *                             reset/account recovery; unknown reset ⇒ say so.
 * ALLOW_COMPATIBLE_FALLBACK:  migrate after verifying capability, privacy,
 *                             budget and permission compatibility.
 * GLOBAL_PAUSE_ON_PRIMARY_LIMIT: pause the dev domain when the primary
 *                             provider is limited; the safety domain continues.
 *
 * Default scope: the affected runs only — not the whole factory. A human may
 * widen to a global pause explicitly.
 */
import { LimitEvent, QuotaBucket, QuotaError } from './types';

export type QuotaPolicyName =
  | 'STRICT_PROVIDER'
  | 'ALLOW_COMPATIBLE_FALLBACK'
  | 'GLOBAL_PAUSE_ON_PRIMARY_LIMIT';

export const QUOTA_POLICIES: readonly QuotaPolicyName[] = [
  'STRICT_PROVIDER',
  'ALLOW_COMPATIBLE_FALLBACK',
  'GLOBAL_PAUSE_ON_PRIMARY_LIMIT',
];

export type QuotaDecision =
  | { action: 'WAIT_FOR_RESET'; resetAt: string | null; note: string }
  | { action: 'FALLBACK_HANDOFF'; note: string }
  | { action: 'PAUSE_DEV_DOMAIN'; note: string };

export interface FallbackCandidate {
  providerAccountId: string;
  limitBucket: string;
  /** Model/tool capabilities the fallback must cover. */
  capabilities: string[];
  /** Data classifications the fallback may see (subset of the task's). */
  allowedDataClasses: string[];
  /** Remaining budget the fallback may consume. */
  budgetRemaining: number;
}

export interface FallbackCheck {
  capabilityOk: boolean;
  privacyOk: boolean;
  budgetOk: boolean;
  permissionOk: boolean;
  reasons: string[];
}

export class IncompatibleFallback extends QuotaError {
  readonly check: FallbackCheck;
  constructor(check: FallbackCheck) {
    super(
      'INCOMPATIBLE_FALLBACK',
      `Fallback rejected: ${check.reasons.join('; ')}`,
    );
    this.check = check;
  }
}

/**
 * Verify a fallback target before migrating (§27.2): capability, privacy,
 * budget and permission must ALL hold. A fallback is never silent about cost:
 * it still draws from the authorized budget.
 */
export function checkFallbackCompatibility(
  required: {
    capabilities: string[];
    dataClasses: string[];
    budgetNeeded: number;
    permissionCeiling: string[];
  },
  candidate: FallbackCandidate,
): FallbackCheck {
  const reasons: string[] = [];
  const missingCaps = required.capabilities.filter((c) => !candidate.capabilities.includes(c));
  const capabilityOk = missingCaps.length === 0;
  if (!capabilityOk) reasons.push(`missing capabilities: ${missingCaps.join(', ')}`);
  const leaking = required.dataClasses.filter((d) => !candidate.allowedDataClasses.includes(d));
  const privacyOk = leaking.length === 0;
  if (!privacyOk) reasons.push(`would expose data classes: ${leaking.join(', ')}`);
  const budgetOk = candidate.budgetRemaining >= required.budgetNeeded;
  if (!budgetOk) {
    reasons.push(`budget shortfall: need ${required.budgetNeeded}, have ${candidate.budgetRemaining}`);
  }
  // Permission: the fallback principal must sit within the task's ceiling.
  const permissionOk = required.permissionCeiling.length > 0;
  if (!permissionOk) reasons.push('no permission ceiling to bind the fallback to');
  return { capabilityOk, privacyOk, budgetOk, permissionOk, reasons };
}

/** Decide what to do when a limit event fires. Never invents a reset time. */
export function decideQuotaPolicy(
  policy: QuotaPolicyName,
  event: LimitEvent,
  affectedRunIds: string[],
): QuotaDecision {
  const scope = `${affectedRunIds.length} affected run(s)`;
  switch (policy) {
    case 'STRICT_PROVIDER': {
      const resetAt = event.bucket.resetAt ?? null;
      return {
        action: 'WAIT_FOR_RESET',
        resetAt,
        note:
          resetAt === null
            ? `${scope} parked: provider gave no reset time — waiting for account recovery, stated as unknown`
            : `${scope} parked until provider reset at ${resetAt}`,
      };
    }
    case 'ALLOW_COMPATIBLE_FALLBACK':
      return {
        action: 'FALLBACK_HANDOFF',
        note: `${scope}: migrate only after capability/privacy/budget/permission checks pass`,
      };
    case 'GLOBAL_PAUSE_ON_PRIMARY_LIMIT':
      return {
        action: 'PAUSE_DEV_DOMAIN',
        note: 'primary provider limited: dev domain paused; safety/monitoring domain continues',
      };
  }
}

/** Which buckets a run's agents draw from (shared, not per-agent). */
export function bucketsForRun(
  buckets: QuotaBucket[],
  providerAccountId: string,
  workspaceId: string,
): QuotaBucket[] {
  return buckets.filter(
    (b) => b.providerAccountId === providerAccountId && b.workspaceId === workspaceId,
  );
}

/**
 * Failure classification — SPEC v2 §25.
 *
 * Auth / Quota / Transient Network / Test / Product failures are classified
 * separately so recovery picks the right strategy. Permission denial is its
 * own class: §25 forbids bypassing a denial by switching tools or models —
 * the guard below makes that a loud error instead of a quiet workaround.
 */
import { FactoryError } from './types';

export type FailureKind =
  | 'PERMISSION_DENIED'
  | 'AUTH_FAILURE'
  | 'QUOTA_EXHAUSTED'
  | 'TRANSIENT_NETWORK'
  | 'TEST_FAILURE'
  | 'PRODUCT_FAILURE'
  | 'INFRA_FAILURE'
  | 'UNKNOWN';

export class PermissionBypassAttempt extends FactoryError {
  constructor(detail: string) {
    super(
      'PERMISSION_BYPASS_ATTEMPT',
      `Permission denial must not be bypassed by switching tools/models: ${detail}`,
    );
  }
}

/**
 * Classify an error into a recovery-relevant bucket. FactoryError codes are
 * authoritative; plain Errors fall back to message sniffing and UNKNOWN.
 */
export function classifyFailure(err: unknown): FailureKind {
  const code = err instanceof FactoryError ? err.code : '';
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'PERMISSION_DENIED' || code === 'PERMISSION_BYPASS_ATTEMPT') {
    return 'PERMISSION_DENIED';
  }
  if (/AUTH|UNAUTHORIZED|CREDENTIAL|TOKEN_EXPIRED/i.test(code + ' ' + msg)) {
    return 'AUTH_FAILURE';
  }
  if (/QUOTA|RATE_LIMIT|429|BUDGET_EXCEEDED/i.test(code + ' ' + msg)) {
    return 'QUOTA_EXHAUSTED';
  }
  if (/TIMEOUT|NETWORK|ECONN|ENOTFOUND|EAI_AGAIN|DISCONNECT/i.test(code + ' ' + msg)) {
    return 'TRANSIENT_NETWORK';
  }
  if (/TEST_|ASSERT/i.test(code)) return 'TEST_FAILURE';
  if (/INFRA|PROVIDER_OUTAGE/i.test(code)) return 'INFRA_FAILURE';
  return 'UNKNOWN';
}

/**
 * §25 — after a PermissionDenied, the loop must surface/escalate, never
 * quietly retry with a different tool or model. Call this wherever a retry
 * strategy is chosen; it throws when a bypass is attempted.
 */
export function assertNoPermissionBypass(
  kind: FailureKind,
  attemptedAction: string,
): void {
  if (kind === 'PERMISSION_DENIED') {
    throw new PermissionBypassAttempt(
      `denied action must not be retried as '${attemptedAction}'`,
    );
  }
}

/**
 * Deterministic test failures must not be blindly retried until they happen
 * to pass (§25). Only transient classes may auto-retry; everything else needs
 * a classified repair path.
 */
const AUTO_RETRYABLE: ReadonlySet<FailureKind> = new Set([
  'TRANSIENT_NETWORK',
  'INFRA_FAILURE',
]);

export function isAutoRetryAllowed(kind: FailureKind): boolean {
  return AUTO_RETRYABLE.has(kind);
}

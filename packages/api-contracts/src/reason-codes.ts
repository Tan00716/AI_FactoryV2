/**
 * SPEC v2 §49 — the 16 unified reason codes.
 *
 * Every surface (UI/IPC/HTTP/Webhook/MCP) uses the same codes so a denial
 * means the same thing everywhere. Codes are the stable contract; messages
 * are human-readable hints and may be localized by the caller.
 */
export const REASON_CODES = {
  UNAUTHORIZED: 'caller is not authenticated or the identity is unknown',
  POLICY_DENIED: 'denied by the effective policy (restrictive intersection)',
  SCOPE_VIOLATION: 'cross org/project/environment reference is not permitted',
  AUTHORIZATION_EXPIRED: 'the authorization or grant has expired',
  VERSION_CONFLICT: 'expected_version does not match the current version',
  STALE_OWNER: 'writer is no longer the current owner (fencing token moved on)',
  MISSING_EVIDENCE: 'a required evidence record is absent',
  STALE_EVIDENCE: 'evidence is superseded by a newer candidate/manifest',
  INDEPENDENCE_REQUIRED: 'independent verification required; self-review is not allowed',
  DEPENDENCY_NOT_READY: 'a declared dependency is not in a ready state',
  BUDGET_EXCEEDED: 'budget reservation would exceed the available balance',
  QUOTA_LIMITED: 'model/provider quota exhausted for this bucket',
  CONFINEMENT_UNAVAILABLE: 'no qualified isolation backend is available',
  APPROVAL_REQUIRED: 'a human/AI approval is required before this action',
  UNKNOWN_SIDE_EFFECT: 'side effects cannot be confirmed; refusing to replay blindly',
  UNSUPPORTED_CAPABILITY: 'the capability is not supported on this host/adapter',
} as const;

/** Union of the 16 unified reason codes. */
export type ReasonCode = keyof typeof REASON_CODES;

/** All 16 codes, in declaration order. */
export const ALL_REASON_CODES: ReasonCode[] = Object.keys(REASON_CODES) as ReasonCode[];

/** A machine-readable denial/error body using a unified reason code. */
export interface ReasonedError {
  code: ReasonCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Build a ReasonedError for a code with optional details. */
export function reason(code: ReasonCode, details?: Record<string, unknown>): ReasonedError {
  return { code, message: REASON_CODES[code], details };
}

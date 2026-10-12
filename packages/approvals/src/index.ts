/**
 * @ai-factory/approvals — approval system (SPEC v2 §23.3, §23.4).
 *
 * Modules:
 *  - types    v2 approval object, statuses (incl. INVALIDATED), store contract [§23.3]
 *  - policy   sensitive-action → approval-level mapping + BLOCKED_ACTIONS,     [§23.4]
 *             the non-waivable set
 *  - manager  request/decide/cancel/expire/invalidate lifecycle + evidence     [§23.3]
 *             payload; DEF-001 hardening: request() refuses BLOCKED actions,
 *             decide() verifies the decider satisfies required_approvers.
 *             Also hosts §23.4 exception grants and evaluateApprovalGate().
 *  - exceptions  Exception Grant model: human-only, reasoned, TTL-capped      [§23.4]
 *             waivers; a covered gate failure is WAIVED, never PASS.
 */
export * from './types';
export * from './policy';
export * from './manager';
export * from './exceptions';

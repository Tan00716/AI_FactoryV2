/**
 * @ai-factory/approvals — approval system (SPEC v2 §23.3, §23.4).
 *
 * Modules:
 *  - types    v2 approval object, statuses (incl. INVALIDATED), store contract [§23.3]
 *  - policy   sensitive-action → approval-level mapping                        [§23.4]
 *  - manager  request/decide/cancel/expire/invalidate lifecycle + evidence     [§23.3]
 *             payload; DEF-001 hardening: request() refuses BLOCKED actions,
 *             decide() verifies the decider satisfies required_approvers.
 */
export * from './types';
export * from './policy';
export * from './manager';

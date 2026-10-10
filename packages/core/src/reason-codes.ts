/**
 * Machine reason codes — SPEC_V2 §49.
 *
 * Single source of truth is `@ai-factory/api-contracts`; this module
 * re-exports it so the workflow engine and its consumers share one
 * definition. The array form is kept for iteration convenience.
 */
export { ALL_REASON_CODES, reason } from '@ai-factory/api-contracts';
export type { ReasonCode, ReasonedError } from '@ai-factory/api-contracts';
import { ALL_REASON_CODES } from '@ai-factory/api-contracts';
import type { ReasonCode } from '@ai-factory/api-contracts';

/** The 16 unified codes as an array, in declaration order. */
export const REASON_CODES: readonly ReasonCode[] = ALL_REASON_CODES;

export function isReasonCode(v: string): v is ReasonCode {
  return (ALL_REASON_CODES as readonly string[]).includes(v);
}

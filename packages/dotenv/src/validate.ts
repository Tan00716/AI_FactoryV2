/**
 * .env validation helpers (round-6 task R6-A8): required-key (missing)
 * checks. Secret-pattern scanning lives in the route layer, which reuses
 * the canonical SECRET_PATTERNS table from @ai-factory/security — the
 * same table the R4-S1 pre-send prompt gate uses — so the editor's
 * warnings can never drift from the gate's verdicts.
 */
import type { DotEnvEntry } from './types.ts';

/** Required keys absent from the effective entry set. */
export function missingKeys(entries: DotEnvEntry[], required: string[]): string[] {
  const present = new Set(entries.map((e) => e.key));
  return required.filter((k) => !present.has(k));
}

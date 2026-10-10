/**
 * Deterministic progress engine — SPEC_V2 §20.
 *
 * progress = 100 × Σ(wᵢ × cᵢ) / Σ(wᵢ)
 *
 * - Only LEAF items carry weight. A parent summary with children must not
 *   carry weight (double counting is rejected).
 * - cᵢ ∈ [0,1] comes from discrete checkpoints against valid evidence —
 *   never from elapsed time, file counts or token counts.
 * - The root final seal is a separate weighted item; progress cannot reach
 *   100% before the seal is finalized (its weight keeps the math honest).
 * - Evidence invalidation may DECREASE cᵢ; the UI shows the reason.
 *   Monotonic-looking progress is forbidden.
 */

export interface WeightItem {
  id: string;
  label: string;
  /** wᵢ > 0. Leaf items only — see computeProgress(). */
  weight: number;
  kind: 'work' | 'seal';
  /** Informational grouping; does not affect the math. */
  parentId: string | null;
  /** Items sharing a gate ref are counted once (shared QA/release gate). */
  sharedGateRef?: string;
  phase?: string;
}

export interface WeightPlan {
  id: string;
  /** weight_plan_version — locked once planning completes (§20.3). */
  version: number;
  items: WeightItem[];
  createdAt: string;
  supersedes: number | null;
  scopeChangeNote: string | null;
  authorizations: Array<{ by: string; note: string; at: string }>;
}

export interface Checkpoint {
  id: string;
  met: boolean;
  weight: number;
}

export interface CompletionEntry {
  itemId: string;
  /** cᵢ ∈ [0,1]; or derived from checkpoints when provided. */
  c: number;
  evidenceRef: string | null;
  checkpoints?: Checkpoint[];
}

export interface ProgressItemReport {
  id: string;
  label: string;
  weight: number;
  c: number;
  contribution: number;
  evidenceRef: string | null;
  sharedGateDeduped?: boolean;
}

export interface ProgressReport {
  planId: string;
  planVersion: number;
  calculationVersion: string;
  /** 100 × Σ(wᵢcᵢ) / Σwᵢ, rounded to 2 decimals for display. */
  percent: number;
  numerator: number;
  denominator: number;
  items: ProgressItemReport[];
  sealFinalized: boolean;
  blockers: string[];
  updatedAt: string;
}

export interface CompletionLedgerEntry {
  itemId: string;
  from: number;
  to: number;
  reason: string;
  by: string;
  at: string;
}

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
  /**
   * §20.3 (G-27) — lock state, set by lockWeightPlan() when planning
   * completes. A locked plan's items/weights are immutable: any change
   * must go through a superseding version (supersedePlan / newPlanVersion).
   * Optional for backward compatibility: plans constructed or persisted
   * before the lock existed carry no lock fields and are treated as
   * unlocked (see isPlanLocked).
   */
  locked?: boolean;
  /** ISO timestamp of the lock; null while unlocked. */
  lockedAt?: string | null;
  /** Actor who locked the plan; null while unlocked. */
  lockedBy?: string | null;
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

/** One goal's progress report plus its weight in a team roll-up (§20, G-28). */
export interface TeamProgressEntry {
  goalId: string;
  teamId?: string;
  /** Goal weight in the team aggregate; must be > 0. */
  weight: number;
  report: ProgressReport;
}

export interface TeamProgressContribution {
  goalId: string;
  teamId: string | null;
  weight: number;
  percent: number;
  /** w × percent (raw numerator part, 2dp). */
  contribution: number;
  /** weight / totalWeight × 100 (2dp). */
  weightSharePercent: number;
}

export interface TeamProgressReport {
  /** Σ(w × percent) / Σw, rounded to 2 decimals. */
  percent: number;
  totalWeight: number;
  entries: TeamProgressContribution[];
}

export interface CompletionLedgerEntry {
  itemId: string;
  from: number;
  to: number;
  reason: string;
  by: string;
  at: string;
}

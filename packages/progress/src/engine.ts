/**
 * Deterministic progress engine — SPEC_V2 §20.
 */

import {
  CompletionEntry,
  CompletionLedgerEntry,
  ProgressReport,
  WeightItem,
  WeightPlan,
} from './types';

export class ProgressError extends Error {}
export class InvalidWeightError extends ProgressError {}
export class InvalidCompletionError extends ProgressError {}
export class DoubleCountError extends ProgressError {}
export class WeightConservationError extends ProgressError {}
export class UnauthorizedScopeChangeError extends ProgressError {}

/** Calculation version shown on every ticket (§20.4: % + current_gate + calculation_version + updated_at). */
export const CALCULATION_VERSION = 'progress/v2.0';

export interface EngineOptions {
  now?: () => number;
}

function iso(now?: () => number): string {
  return new Date(now ? now() : Date.now()).toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * §20.1 — compute progress = 100 × Σ(wᵢcᵢ) / Σwᵢ over leaf items only.
 * Deterministic: same plan + same completions → same report, always.
 */
export function computeProgress(
  plan: WeightPlan,
  completions: Map<string, CompletionEntry> | CompletionEntry[],
  opts: { blockers?: string[]; now?: () => number } = {},
): ProgressReport {
  const entries = Array.isArray(completions)
    ? new Map(completions.map((e) => [e.itemId, e]))
    : completions;

  // Leaf check: an item that has children must not carry weight.
  const hasChildren = new Set(
    plan.items.filter((i) => i.parentId !== null).map((i) => i.parentId as string),
  );
  for (const item of plan.items) {
    if (item.weight <= 0) {
      throw new InvalidWeightError(`Item ${item.id}: weight must be > 0, got ${item.weight}`);
    }
    if (hasChildren.has(item.id) && item.weight !== 0) {
      throw new DoubleCountError(
        `Item ${item.id} has children and weight ${item.weight}: parents aggregate leaves only, no double counting`,
      );
    }
  }

  // Shared gates counted once: keep the first item per sharedGateRef.
  const seenGates = new Set<string>();
  const counted: WeightItem[] = [];
  const deduped = new Set<string>();
  for (const item of plan.items) {
    if (hasChildren.has(item.id)) continue; // parent summaries are not leaves
    if (item.sharedGateRef !== undefined) {
      if (seenGates.has(item.sharedGateRef)) {
        deduped.add(item.id);
        continue;
      }
      seenGates.add(item.sharedGateRef);
    }
    counted.push(item);
  }

  let numerator = 0;
  let denominator = 0;
  let sealFinalized = false;
  const items = counted.map((item) => {
    const entry = entries.get(item.id);
    let c = entry?.c ?? 0;
    if (entry?.checkpoints && entry.checkpoints.length > 0) {
      const tw = entry.checkpoints.reduce((s, cp) => s + cp.weight, 0);
      if (tw <= 0) throw new InvalidCompletionError(`Item ${item.id}: checkpoint weights must sum > 0`);
      c = entry.checkpoints.reduce((s, cp) => s + (cp.met ? cp.weight : 0), 0) / tw;
    }
    if (!(c >= 0 && c <= 1)) {
      throw new InvalidCompletionError(`Item ${item.id}: c must be in [0,1], got ${c}`);
    }
    if (item.kind === 'seal' && c === 1) sealFinalized = true;
    numerator += item.weight * c;
    denominator += item.weight;
    return {
      id: item.id, label: item.label, weight: item.weight, c: round2(c),
      contribution: round2(item.weight * c),
      evidenceRef: entry?.evidenceRef ?? null,
    };
  });

  if (denominator === 0) throw new InvalidWeightError('Weight plan has no countable leaf items');

  const percent = round2((100 * numerator) / denominator);
  return {
    planId: plan.id,
    planVersion: plan.version,
    calculationVersion: CALCULATION_VERSION,
    percent,
    numerator: round2(numerator),
    denominator: round2(denominator),
    items: items.map((r) => ({
      ...r,
      ...(deduped.has(r.id) ? { sharedGateDeduped: true as const } : {}),
    })),
    sealFinalized,
    blockers: opts.blockers ?? [],
    updatedAt: iso(opts.now),
  };
}

/**
 * §20.2 — the default example weight plan.
 * Planning 10 / Implementation 30 / Independent Review 10 /
 * QA-CI-Security 20 / UAT 10 / Deployment 10 / Observation-Outcome-Seal 10.
 */
export function defaultWeightPlan(now?: () => number): WeightPlan {
  const item = (
    id: string, label: string, weight: number, phase: string, kind: 'work' | 'seal' = 'work',
  ): WeightItem => ({ id, label, weight, kind, parentId: null, phase });
  return {
    id: 'weight-plan-default',
    version: 1,
    items: [
      item('planning', 'Planning', 10, 'Planning'),
      item('implementation', 'Implementation', 30, 'Implementation'),
      item('review', 'Independent Review', 10, 'Independent Review'),
      item('qa-ci-security', 'QA / CI / Security', 20, 'QA / CI / Security'),
      item('uat', 'UAT', 10, 'UAT'),
      item('deployment', 'Deployment', 10, 'Deployment'),
      item('seal', 'Observation / Outcome / Final Seal', 10, 'Observation / Outcome / Seal', 'seal'),
    ],
    createdAt: iso(now),
    supersedes: null,
    scopeChangeNote: null,
    authorizations: [],
  };
}

/**
 * §20.3 — split an item into parts WITHOUT increasing total weight.
 * Returns a NEW plan version; the old snapshot is retained by the caller.
 */
export function splitItem(
  plan: WeightPlan,
  itemId: string,
  parts: Array<{ id: string; label: string; weight: number }>,
  by: string,
  opts: EngineOptions = {},
): WeightPlan {
  const target = plan.items.find((i) => i.id === itemId);
  if (!target) throw new ProgressError(`Item ${itemId} not found in plan ${plan.id}`);
  const sum = parts.reduce((s, p) => s + p.weight, 0);
  if (Math.abs(sum - target.weight) > 1e-9) {
    throw new WeightConservationError(
      `Splitting ${itemId}: parts sum to ${sum}, expected ${target.weight} — splitting must not change total weight`,
    );
  }
  const items = plan.items.flatMap((i) =>
    i.id === itemId
      ? parts.map((p) => ({
          id: p.id, label: p.label, weight: p.weight,
          kind: target.kind, parentId: null as string | null, phase: target.phase,
        }))
      : [i],
  );
  return {
    ...plan,
    version: plan.version + 1,
    items,
    createdAt: iso(opts.now),
    supersedes: plan.version,
    scopeChangeNote: `split ${itemId} into ${parts.map((p) => p.id).join(', ')} (weight conserved)`,
    authorizations: [...plan.authorizations, { by, note: `split ${itemId}`, at: iso(opts.now) }],
  };
}

/**
 * §20.3 — scope change produces a new weight plan version (old snapshot kept).
 * Cancelled items are removed from the denominator ONLY with an authorized
 * scope change — never silently, never counted as done.
 */
export function newPlanVersion(
  plan: WeightPlan,
  mutate: (items: WeightItem[]) => WeightItem[],
  scopeNote: string,
  authorizedBy: string,
  opts: EngineOptions = {},
): WeightPlan {
  if (!authorizedBy) {
    throw new UnauthorizedScopeChangeError('Scope change requires an authorized actor');
  }
  return {
    ...plan,
    version: plan.version + 1,
    items: mutate(plan.items.map((i) => ({ ...i }))),
    createdAt: iso(opts.now),
    supersedes: plan.version,
    scopeChangeNote: scopeNote,
    authorizations: [...plan.authorizations, { by: authorizedBy, note: scopeNote, at: iso(opts.now) }],
  };
}

/** Append-only ledger of completion changes (increases AND decreases). */
export class CompletionLedger {
  private entries: CompletionLedgerEntry[] = [];

  constructor(private opts: EngineOptions = {}) {}

  record(itemId: string, from: number, to: number, reason: string, by: string): CompletionLedgerEntry {
    const e: CompletionLedgerEntry = {
      itemId, from, to, reason, by,
      at: new Date(this.opts.now ? this.opts.now() : Date.now()).toISOString(),
    };
    this.entries.push(e);
    return e;
  }

  list(itemId?: string): CompletionLedgerEntry[] {
    return itemId ? this.entries.filter((e) => e.itemId === itemId) : [...this.entries];
  }
}

/**
 * §20.3 — evidence invalidation / rework LOWERS cᵢ. The reason is recorded
 * and surfaced; progress is never kept artificially monotonic.
 */
export function applyInvalidation(
  completions: Map<string, CompletionEntry>,
  ledger: CompletionLedger,
  itemId: string,
  to: number,
  reason: string,
  by: string,
): void {
  const cur = completions.get(itemId);
  const from = cur?.c ?? 0;
  if (to > from) {
    throw new InvalidCompletionError(
      `Invalidation must not raise completion (${from} → ${to}); use a completion update instead`,
    );
  }
  completions.set(itemId, { itemId, c: to, evidenceRef: cur?.evidenceRef ?? null });
  ledger.record(itemId, from, to, reason, by);
}

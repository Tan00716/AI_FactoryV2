/**
 * Deterministic progress engine — SPEC_V2 §20.
 */

import {
  CompletionEntry,
  CompletionLedgerEntry,
  ProgressReport,
  TeamProgressEntry,
  TeamProgressReport,
  WeightItem,
  WeightPlan,
} from './types';

export class ProgressError extends Error {}
export class InvalidWeightError extends ProgressError {}
export class InvalidCompletionError extends ProgressError {}
export class DoubleCountError extends ProgressError {}
export class WeightConservationError extends ProgressError {}
export class UnauthorizedScopeChangeError extends ProgressError {}
export class PlanLockedError extends ProgressError {}

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
 *
 * §20 hardening:
 * - (G-25) Any counted item whose effective cᵢ > 0 — declared directly
 *   or derived from checkpoints — MUST carry a non-empty evidenceRef;
 *   otherwise InvalidCompletionError. cᵢ may only come from discrete
 *   checkpoints against valid Evidence, never from elapsed time, file
 *   counts or token counts, and an evidence-free positive cᵢ is exactly
 *   how such derivations would sneak in. cᵢ = 0 needs no evidence.
 * - (G-26) A plan with no kind:'seal' item among the counted items can
 *   never show 100%: percent is capped at 99.99 (numerator/denominator
 *   stay raw) and a blocker explains why. With a seal item, its weight
 *   in the denominator already keeps percent < 100 until it finalizes.
 * - (G-29) opts.currentGate is passed through to the report (§20.4:
 *   every ticket shows % + current_gate + calculation_version +
 *   updated_at); the engine never invents a gate, default is null.
 */
export function computeProgress(
  plan: WeightPlan,
  completions: Map<string, CompletionEntry> | CompletionEntry[],
  opts: { blockers?: string[]; now?: () => number; currentGate?: string } = {},
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
    // §20 (G-25): positive completion — declared or checkpoint-derived —
    // is only legal against valid Evidence. Reject evidence-free cᵢ > 0
    // so callers cannot derive progress from time/token/file counts.
    if (c > 0) {
      const ref = entry?.evidenceRef;
      if (ref === null || ref === undefined || ref.trim() === '') {
        throw new InvalidCompletionError(
          `Item ${item.id}: c=${round2(c)} > 0 requires valid evidence (§20) — evidenceRef is missing`,
        );
      }
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

  // §20 (G-26): without a seal item among the counted items there is no
  // weighted final seal, so 100% is unreachable by definition — cap the
  // displayed percent at 99.99 (raw numerator/denominator are returned
  // unchanged) and say so in blockers instead of throwing, so existing
  // seal-less plans keep rendering.
  const blockers = [...(opts.blockers ?? [])];
  let percent = round2((100 * numerator) / denominator);
  const hasSeal = counted.some((i) => i.kind === 'seal');
  if (!hasSeal && percent > 99.99) {
    percent = 99.99;
    blockers.push('plan has no seal item: progress cannot reach 100% (§20)');
  }
  return {
    planId: plan.id,
    planVersion: plan.version,
    calculationVersion: CALCULATION_VERSION,
    currentGate: opts.currentGate ?? null,
    percent,
    numerator: round2(numerator),
    denominator: round2(denominator),
    items: items.map((r) => ({
      ...r,
      ...(deduped.has(r.id) ? { sharedGateDeduped: true as const } : {}),
    })),
    sealFinalized,
    blockers,
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
    locked: false,
    lockedAt: null,
    lockedBy: null,
  };
}

/* ------------------------------------------------------------------ */
/* §20.3 (G-27) — weight plan locking                                  */
/* ------------------------------------------------------------------ */

/** True when the plan was locked via lockWeightPlan(). Legacy plans
 *  without lock fields are unlocked. */
export function isPlanLocked(plan: WeightPlan): boolean {
  return plan.locked === true;
}

function unlockedFields(): { locked: boolean; lockedAt: null; lockedBy: null } {
  return { locked: false, lockedAt: null, lockedBy: null };
}

/**
 * §20.3 (G-27) — lock a weight plan once planning completes. Returns a
 * NEW plan object (the input is not mutated) with the lock recorded in
 * the authorization trail, in the same style as scope-change records.
 * Locking requires an authorized actor; locking twice is an error.
 */
export function lockWeightPlan(
  plan: WeightPlan,
  by: string,
  opts: EngineOptions & { note?: string } | string = {},
): WeightPlan {
  const o: EngineOptions & { note?: string } = typeof opts === 'string' ? { note: opts } : opts;
  if (!by) {
    throw new UnauthorizedScopeChangeError('Locking a weight plan requires an authorized actor');
  }
  if (isPlanLocked(plan)) {
    throw new PlanLockedError(
      `Weight plan ${plan.id} v${plan.version} is already locked by ${plan.lockedBy ?? 'unknown'} at ${plan.lockedAt ?? 'unknown'}`,
    );
  }
  const at = iso(o.now);
  const note = o.note ?? 'weight plan locked (planning complete)';
  return {
    ...plan,
    items: plan.items.map((i) => ({ ...i })),
    locked: true,
    lockedAt: at,
    lockedBy: by,
    authorizations: [...plan.authorizations, { by, note, at }],
  };
}

export interface UpdatePlanItemsOptions extends EngineOptions {
  by?: string;
  scopeChangeNote?: string;
}

/**
 * §20.3 (G-27) — direct item/weight change. Allowed only while the plan
 * is UNLOCKED (planning still in progress; same version, new plan object).
 * On a LOCKED plan this throws PlanLockedError: the change must go
 * through supersedePlan() / newPlanVersion(), which produce version+1.
 */
export function updatePlanItems(
  plan: WeightPlan,
  items: WeightItem[],
  opts: UpdatePlanItemsOptions = {},
): WeightPlan {
  if (isPlanLocked(plan)) {
    throw new PlanLockedError(
      `Weight plan ${plan.id} v${plan.version} is locked (by ${plan.lockedBy ?? 'unknown'}); ` +
        'direct weight changes are forbidden — use supersedePlan() with a scopeChangeNote and authorization',
    );
  }
  for (const item of items) {
    if (!(item.weight > 0)) {
      throw new InvalidWeightError(`Item ${item.id}: weight must be > 0, got ${item.weight}`);
    }
  }
  return {
    ...plan,
    items: items.map((i) => ({ ...i })),
    authorizations: opts.by
      ? [...plan.authorizations, { by: opts.by, note: opts.scopeChangeNote ?? 'plan items updated (unlocked)', at: iso(opts.now) }]
      : [...plan.authorizations],
  };
}

/** Alias matching the change-entry naming used in the gap audit (G-27). */
export const applyPlanChange = updatePlanItems;

export interface SupersedePlanOptions extends EngineOptions {
  /** Authorized actor — required. */
  by: string;
  /** Why the scope changed — required, recorded on the new version. */
  scopeChangeNote: string;
}

/**
 * §20.3 (G-27) — the ONLY way to change a locked plan: produce a new
 * version (version+1, supersedes = old version) carrying the new items,
 * the scope-change note and an authorization record. The old plan object
 * is left untouched. The new version starts UNLOCKED (its own planning
 * must complete and be locked again). Also valid on unlocked plans.
 */
export function supersedePlan(
  plan: WeightPlan,
  items: WeightItem[],
  opts: SupersedePlanOptions,
): WeightPlan {
  if (!opts.by) {
    throw new UnauthorizedScopeChangeError('Superseding a weight plan requires an authorized actor');
  }
  if (!opts.scopeChangeNote) {
    throw new UnauthorizedScopeChangeError('Superseding a weight plan requires a scopeChangeNote');
  }
  for (const item of items) {
    if (!(item.weight > 0)) {
      throw new InvalidWeightError(`Item ${item.id}: weight must be > 0, got ${item.weight}`);
    }
  }
  return {
    ...plan,
    version: plan.version + 1,
    items: items.map((i) => ({ ...i })),
    createdAt: iso(opts.now),
    supersedes: plan.version,
    scopeChangeNote: opts.scopeChangeNote,
    authorizations: [...plan.authorizations, { by: opts.by, note: opts.scopeChangeNote, at: iso(opts.now) }],
    ...unlockedFields(),
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
  // Splitting produces a NEW version, so it is a valid change path even
  // for a locked plan (G-27); the new version starts unlocked.
  return {
    ...plan,
    version: plan.version + 1,
    items,
    createdAt: iso(opts.now),
    supersedes: plan.version,
    scopeChangeNote: `split ${itemId} into ${parts.map((p) => p.id).join(', ')} (weight conserved)`,
    authorizations: [...plan.authorizations, { by, note: `split ${itemId}`, at: iso(opts.now) }],
    ...unlockedFields(),
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
  // Authorized scope change = the supersede path for locked plans (G-27);
  // the new version starts unlocked.
  return {
    ...plan,
    version: plan.version + 1,
    items: mutate(plan.items.map((i) => ({ ...i }))),
    createdAt: iso(opts.now),
    supersedes: plan.version,
    scopeChangeNote: scopeNote,
    authorizations: [...plan.authorizations, { by: authorizedBy, note: scopeNote, at: iso(opts.now) }],
    ...unlockedFields(),
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

/* ------------------------------------------------------------------ */
/* §20 (G-28) — team progress aggregation                              */
/* ------------------------------------------------------------------ */

/**
 * §20 (G-28) — aggregate per-goal progress reports into a team figure,
 * weighted by each goal's work weight:
 *
 *   team percent = Σ(wᵢ × percentᵢ) / Σwᵢ   (rounded to 2 decimals)
 *
 * Failure policy (explicit, by design): an EMPTY entry list throws
 * ProgressError and any entry with weight ≤ 0 (or non-finite) throws
 * InvalidWeightError — a team aggregate over no goals is meaningless,
 * and silently returning 0% would look like real data.
 */
export function aggregateTeamProgress(entries: TeamProgressEntry[]): TeamProgressReport {
  if (entries.length === 0) {
    throw new ProgressError('aggregateTeamProgress requires at least one entry');
  }
  let totalWeight = 0;
  let weighted = 0;
  const contributions = entries.map((e) => {
    if (!Number.isFinite(e.weight) || e.weight <= 0) {
      throw new InvalidWeightError(
        `Goal ${e.goalId}: team aggregation weight must be > 0, got ${e.weight}`,
      );
    }
    totalWeight += e.weight;
    weighted += e.weight * e.report.percent;
    return {
      goalId: e.goalId,
      teamId: e.teamId ?? null,
      weight: e.weight,
      percent: e.report.percent,
      contribution: round2(e.weight * e.report.percent),
    };
  });
  return {
    percent: round2(weighted / totalWeight),
    totalWeight: round2(totalWeight),
    entries: contributions.map((c) => ({
      ...c,
      weightSharePercent: round2((c.weight / totalWeight) * 100),
    })),
  };
}

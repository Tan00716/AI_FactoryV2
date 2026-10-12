/**
 * Execution Strategy Optimizer — SPEC_V2 §21.3 (G-34).
 *
 * The optimizer compares candidate execution strategies across the
 * dimensions the spec names — serial vs parallel, staff reuse vs
 * creating a specialist, model/reasoning choice, verification strength,
 * host, context vs handoff, and resource cost — and picks one. It may
 * only optimize speed and cost AFTER the hard constraints pass:
 * candidates that violate capability or policy are rejected up front
 * with their reasons, never scored.
 *
 * A Human may Override the choice (pick a different feasible candidate),
 * but an override cannot resurrect a rejected candidate: the refusal
 * comes back with a per-constraint explanation (§21.3: "若违反能力或
 * 政策，系统解释拒绝").
 *
 * Scoring is a deterministic weighted sum over the candidate's own
 * estimates. The spec fixes no weights or formula, so the weights are
 * explicit, configurable local defaults — not spec constants — and the
 * full per-candidate breakdown is recorded in the decision so the
 * choice can be explained (§21.2: scheduling records its basis).
 */

/** The §21.3 comparison dimensions of one candidate strategy. */
export interface StrategyDimensions {
  parallelism: 'serial' | 'parallel';
  staffing: 'reuse' | 'create-specialist';
  /** Model identifier the strategy would run. */
  model: string;
  reasoning?: string;
  verification: 'light' | 'standard' | 'strict';
  /** Execution host identifier. */
  host: string;
  context: 'full-context' | 'handoff';
}

export interface StrategyCandidate {
  id: string;
  label?: string;
  dimensions: StrategyDimensions;
  /** Estimated monetary cost in minor units (moneyMinor convention). */
  estimatedCostMinor: number;
  /** Estimated wall-clock duration in ms. */
  estimatedTimeMs: number;
  /** Abstract resource cost units (agents/processes/footprint), when the
   *  caller meters them; absent counts as 0. */
  estimatedResourceCost?: number;
  /**
   * Hard-constraint facts (§21.3: capability and policy gate first).
   * Either may be a plain boolean, or `false` plus a note explaining the
   * violation — notes are carried verbatim into rejection reasons and
   * override-refusal explanations.
   */
  capabilitySatisfied: boolean;
  capabilityNote?: string;
  policyAllowed: boolean;
  policyNote?: string;
}

export interface RankedCandidate {
  candidateId: string;
  /** Weighted score; lower wins. */
  score: number;
  breakdown: { cost: number; time: number; resource: number };
}

export interface RejectedCandidate {
  candidateId: string;
  /** One entry per violated hard constraint, human-readable. */
  reasons: string[];
}

export interface StrategyDecision {
  /** The optimizer's choice, or null when no candidate is feasible. */
  chosen: string | null;
  /** Feasible candidates, best first. */
  ranking: RankedCandidate[];
  /** Candidates excluded by hard constraints, with reasons. */
  rejected: RejectedCandidate[];
  /** Human-readable decision basis (§21.2). */
  basis: string;
  at: number;
}

export interface OverrideRequest {
  candidateId: string;
  /** Who is overriding (recorded; the optimizer does not authenticate). */
  by: string;
}

export type OverrideResult =
  | {
      accepted: true;
      chosen: string;
      overriddenBy: string;
      /** The optimizer's original choice (may equal `chosen`). */
      originalChosen: string | null;
    }
  | {
      accepted: false;
      candidateId: string;
      /** Per-constraint explanation of why this override is refused. */
      explanation: string[];
    };

export interface OptimizerOptions {
  /** Score weights — local defaults, NOT spec constants (§21.3 gives no
   *  formula). Defaults: cost 1 per minor unit, time 0.01 per ms (so
   *  100 ms ≈ 1 minor unit), resource 10 per unit. */
  costWeight?: number;
  timeWeight?: number;
  resourceWeight?: number;
  clock?: { now: () => number };
}

export class ExecutionStrategyOptimizer {
  private readonly costWeight: number;
  private readonly timeWeight: number;
  private readonly resourceWeight: number;
  private readonly clock: { now: () => number };

  constructor(options: OptimizerOptions = {}) {
    this.costWeight = options.costWeight ?? 1;
    this.timeWeight = options.timeWeight ?? 0.01;
    this.resourceWeight = options.resourceWeight ?? 10;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  /**
   * Compare candidates: hard constraints first (capability, policy),
   * then deterministic weighted scoring of the survivors by estimated
   * cost / time / resource use. Ties break on candidate id so the same
   * input always yields the same decision.
   */
  evaluate(candidates: StrategyCandidate[]): StrategyDecision {
    const rejected: RejectedCandidate[] = [];
    const ranking: RankedCandidate[] = [];

    for (const candidate of candidates) {
      const reasons: string[] = [];
      if (!candidate.capabilitySatisfied) {
        reasons.push(
          `capability: candidate ${candidate.id} does not satisfy the required capability` +
            (candidate.capabilityNote ? ` — ${candidate.capabilityNote}` : ''),
        );
      }
      if (!candidate.policyAllowed) {
        reasons.push(
          `policy: candidate ${candidate.id} is not allowed by policy` +
            (candidate.policyNote ? ` — ${candidate.policyNote}` : ''),
        );
      }
      if (reasons.length > 0) {
        rejected.push({ candidateId: candidate.id, reasons });
        continue;
      }
      const breakdown = {
        cost: this.costWeight * candidate.estimatedCostMinor,
        time: this.timeWeight * candidate.estimatedTimeMs,
        resource: this.resourceWeight * (candidate.estimatedResourceCost ?? 0),
      };
      ranking.push({
        candidateId: candidate.id,
        score: breakdown.cost + breakdown.time + breakdown.resource,
        breakdown,
      });
    }

    ranking.sort(
      (a, b) => a.score - b.score || (a.candidateId < b.candidateId ? -1 : 1),
    );
    const chosen = ranking[0]?.candidateId ?? null;
    const basis =
      chosen === null
        ? `no feasible candidate: ${rejected.length} rejected by hard constraints`
        : `chose ${chosen} with score ${ranking[0]!.score} ` +
          `(cost ${ranking[0]!.breakdown.cost}, time ${ranking[0]!.breakdown.time}, ` +
          `resource ${ranking[0]!.breakdown.resource}); ` +
          `${ranking.length} feasible, ${rejected.length} rejected by hard constraints`;

    return { chosen, ranking, rejected, basis, at: this.clock.now() };
  }

  /**
   * Human Override (§21.3): select a feasible candidate other than the
   * optimizer's choice. Overriding to a candidate the gate rejected is
   * refused with the per-constraint explanation — an override is a
   * choice among lawful strategies, never a waiver of capability or
   * policy.
   */
  applyOverride(decision: StrategyDecision, request: OverrideRequest): OverrideResult {
    const rejected = decision.rejected.find((r) => r.candidateId === request.candidateId);
    if (rejected) {
      return {
        accepted: false,
        candidateId: request.candidateId,
        explanation: [
          `override by ${request.by} refused: candidate ${request.candidateId} violates hard constraints`,
          ...rejected.reasons,
        ],
      };
    }
    const feasible = decision.ranking.find((r) => r.candidateId === request.candidateId);
    if (!feasible) {
      return {
        accepted: false,
        candidateId: request.candidateId,
        explanation: [
          `override by ${request.by} refused: candidate ${request.candidateId} was not part of this decision`,
        ],
      };
    }
    return {
      accepted: true,
      chosen: request.candidateId,
      overriddenBy: request.by,
      originalChosen: decision.chosen,
    };
  }
}

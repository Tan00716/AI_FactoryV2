/**
 * Progressive rollout — SPEC v2 §41.4.
 *
 * Every stage configures: cohort, traffic denominator, minimum observation
 * duration, minimum sample, SLO/error/latency/business metrics, baseline,
 * allowed thresholds, promotion/abort rules, max wait.
 *
 * "Metrics good" must be an executable predicate — a human/LLM glancing at a
 * chart never promotes to 100%. Too-small samples or lost telemetry → HOLD,
 * never promotion on zero observed errors.
 */

export type StageDecision = 'PROMOTE' | 'HOLD' | 'ABORT' | 'CONTINUE';

export interface RolloutStage {
  name: string;
  /** e.g. '5%' | 'canary-cohort-a' */
  cohort: string;
  /** Denominator the cohort is measured against, e.g. 'prod-traffic'. */
  trafficDenominator: string;
  minObservationMs: number;
  minSample: number;
  metrics: string[];
  baselineRef: string;
  thresholds: Record<string, { max?: number; min?: number }>;
  /** Executable predicate over the observation — not vibes. */
  promotionRule: (obs: StageObservation) => boolean;
  abortRule: (obs: StageObservation) => boolean;
  maxWaitMs: number;
}

export interface StageObservation {
  stageName: string;
  sampleSize: number;
  /** False when telemetry was lost for this stage. */
  telemetryPresent: boolean;
  observedMs: number;
  metricValues: Record<string, number>;
  at: string;
}

export interface CanaryPlan {
  id: string;
  artifactDigest: string;
  targetEnv: string;
  stages: RolloutStage[];
}

export function defineCanaryPlan(input: {
  artifactDigest: string;
  targetEnv: string;
  stages: RolloutStage[];
}): CanaryPlan {
  if (!input.artifactDigest) throw new Error('artifactDigest is required');
  if (!input.stages || input.stages.length === 0) {
    throw new Error('at least one rollout stage is required');
  }
  for (const s of input.stages) {
    for (const [k, v] of Object.entries({
      cohort: s.cohort,
      trafficDenominator: s.trafficDenominator,
      baselineRef: s.baselineRef,
    })) {
      if (!v || !String(v).trim()) throw new Error(`stage ${s.name}: ${k} is required`);
    }
    if (!(s.minSample > 0)) throw new Error(`stage ${s.name}: minSample must be > 0`);
    if (typeof s.promotionRule !== 'function' || typeof s.abortRule !== 'function') {
      throw new Error(`stage ${s.name}: promotionRule/abortRule must be executable predicates`);
    }
  }
  return {
    id: `canary-${Date.now().toString(36)}`,
    artifactDigest: input.artifactDigest,
    targetEnv: input.targetEnv,
    stages: input.stages,
  };
}

/**
 * Evaluate one stage observation. Order matters:
 *   1. telemetry lost or sample < minSample → HOLD (never promote);
 *   2. abort rule fires → ABORT;
 *   3. observation window too short → CONTINUE;
 *   4. promotion rule holds → PROMOTE, else HOLD.
 */
export function evaluateStage(stage: RolloutStage, obs: StageObservation): StageDecision {
  if (!obs.telemetryPresent) return 'HOLD';
  if (obs.sampleSize < stage.minSample) return 'HOLD';
  if (stage.abortRule(obs)) return 'ABORT';
  if (obs.observedMs < stage.minObservationMs) return 'CONTINUE';
  return stage.promotionRule(obs) ? 'PROMOTE' : 'HOLD';
}

/** Feature flag record — closing a flag does not necessarily undo data writes. */
export interface FeatureFlag {
  name: string;
  owner: string;
  /** ISO expiry; expired flags must be resolved, not left dangling. */
  expiresAt: string;
  configVersion: string;
  rollbackMethod: string;
  dataImpact: string;
  enabled: boolean;
}

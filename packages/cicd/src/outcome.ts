/**
 * Observation / Outcome / Emergency recovery — SPEC v2 §41.5 + §41.6.
 *
 * After 100% rollout an Observation Window still runs: configured duration,
 * minimum sample, continuous health conditions, AC outcome methods. A green
 * technical smoke test is not business outcome. Business ACs that cannot be
 * measured automatically go to Human Outcome Acceptance (WAITING, not 100%).
 * Only OUTCOME_VERIFIED feeds the final Done seal.
 *
 * Emergency recovery: threshold breach + safe recovery path → pre-authorized
 * auto rollback/flag-off/roll-forward/traffic-stop. Ordinary rollback →
 * human approval. Failed rollback / UNKNOWN data state / incompatible
 * strategy → escalate immediately.
 */
import { assertSafeAutoRecovery, ReversibilityClass } from './reversibility';

export interface ObservationWindow {
  id: string;
  deploymentId: string;
  durationMs: number;
  minSample: number;
  continuousHealthConditions: string[];
  acOutcomeMethods: Record<string, 'auto' | 'human' | 'telemetry'>;
  startedAt: string;
}

export type OutcomeStatus = 'OBSERVING' | 'OUTCOME_VERIFIED' | 'OUTCOME_FAILED' | 'WAITING_HUMAN';

export interface OutcomeEvaluation {
  status: OutcomeStatus;
  verifiedAcs: string[];
  waitingAcs: string[];
  failedAcs: string[];
  reason: string;
}

export function openObservationWindow(input: {
  deploymentId: string;
  durationMs: number;
  minSample: number;
  continuousHealthConditions?: string[];
  acOutcomeMethods?: Record<string, 'auto' | 'human' | 'telemetry'>;
  now?: () => number;
}): ObservationWindow {
  if (!(input.durationMs > 0)) throw new Error('durationMs must be > 0');
  if (!(input.minSample > 0)) throw new Error('minSample must be > 0');
  const now = input.now ?? Date.now;
  return {
    id: `obs-${now().toString(36)}`,
    deploymentId: input.deploymentId,
    durationMs: input.durationMs,
    minSample: input.minSample,
    continuousHealthConditions: input.continuousHealthConditions ?? [],
    acOutcomeMethods: input.acOutcomeMethods ?? {},
    startedAt: new Date(now()).toISOString(),
  };
}

/**
 * Evaluate outcome at the end of (or during) the observation window.
 * `acResults` maps AC id → 'pass' | 'fail' | 'pending-human'.
 */
export function evaluateOutcome(
  window: ObservationWindow,
  acResults: Record<string, 'pass' | 'fail' | 'pending-human'>,
  sampleSize: number,
): OutcomeEvaluation {
  const verified: string[] = [];
  const waiting: string[] = [];
  const failed: string[] = [];
  for (const [ac, r] of Object.entries(acResults)) {
    if (r === 'pass') verified.push(ac);
    else if (r === 'fail') failed.push(ac);
    else waiting.push(ac);
  }
  // Human-judgment ACs declared in the window methods stay WAITING.
  for (const [ac, method] of Object.entries(window.acOutcomeMethods)) {
    if (method === 'human' && !(ac in acResults)) waiting.push(ac);
  }
  if (failed.length > 0) {
    return { status: 'OUTCOME_FAILED', verifiedAcs: verified, waitingAcs: waiting, failedAcs: failed, reason: `${failed.length} AC(s) failed` };
  }
  if (sampleSize < window.minSample) {
    return { status: 'OBSERVING', verifiedAcs: verified, waitingAcs: waiting, failedAcs: failed, reason: `sample ${sampleSize} < minimum ${window.minSample} — still observing` };
  }
  if (waiting.length > 0) {
    return { status: 'WAITING_HUMAN', verifiedAcs: verified, waitingAcs: waiting, failedAcs: failed, reason: `${waiting.length} AC(s) need human outcome acceptance` };
  }
  return { status: 'OUTCOME_VERIFIED', verifiedAcs: verified, waitingAcs: waiting, failedAcs: failed, reason: 'all ACs verified with sufficient sample' };
}

export type EmergencyAction = 'AUTO_ROLLBACK' | 'FLAG_OFF' | 'ROLL_FORWARD' | 'TRAFFIC_STOP' | 'REQUIRE_HUMAN' | 'ESCALATE';

export interface EmergencyInput {
  thresholdBreached: boolean;
  reversibility: ReversibilityClass;
  recoveryPathSafe: boolean;
  preapprovedCompensationRunbook?: string;
  rollbackFailed?: boolean;
  dataStateUnknown?: boolean;
  strategyIncompatible?: boolean;
}

/**
 * Decide the emergency response (§41.6). Auto actions only when the
 * threshold fired AND the recovery path is safe-reversible or a
 * pre-approved compensation runbook exists; anything uncertain escalates.
 */
export function decideEmergencyRecovery(input: EmergencyInput): EmergencyAction {
  if (!input.thresholdBreached) return 'REQUIRE_HUMAN';
  if (input.rollbackFailed || input.dataStateUnknown || input.strategyIncompatible) {
    return 'ESCALATE';
  }
  try {
    assertSafeAutoRecovery({
      reversibility: input.reversibility,
      recoveryPathSafe: input.recoveryPathSafe,
      preapprovedCompensationRunbook: input.preapprovedCompensationRunbook,
    });
  } catch {
    return 'REQUIRE_HUMAN';
  }
  return 'AUTO_ROLLBACK';
}

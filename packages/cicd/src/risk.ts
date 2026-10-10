/**
 * Risk-based deployment assessment — SPEC v2 §41.1.
 *
 * An LLM may propose risk rationale, but the SYSTEM computes an
 * un-lowerable risk floor from rules, actual permissions/config and change
 * type. Unknown risk is treated strictly (raised, never lowered).
 *
 * Levels: LOW → auto (if policy allows); MEDIUM → project pre-auth or human;
 * HIGH → human + specialist verification; CRITICAL → unattended forbidden
 * (only an explicitly approved special runbook may proceed).
 */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export type RiskAuthorization =
  | { kind: 'AUTO' }
  | { kind: 'PROJECT_PREAUTH_OR_HUMAN' }
  | { kind: 'HUMAN_PLUS_SPECIALIST' }
  | { kind: 'DENY_UNATTENDED' };

export interface RiskInput {
  /** e.g. 'bugfix' | 'feature' | 'dependency-upgrade' | 'auth-change' | 'data-deletion' | 'payment-rule' | 'migration' */
  changeType: string;
  /** 'single-service' | 'multi-service' | 'platform-wide' | 'unbounded' */
  blastRadius: string;
  securityDataImpact: boolean;
  /** true when the change includes a DB migration */
  hasMigration: boolean;
  externalSideEffects: boolean;
  recoveryReady: boolean;
  observabilityReady: boolean;
  /** were the tests independently designed/run? */
  testIndependence: boolean;
  environmentDrift: boolean;
  businessCritical: boolean;
  /** Optional LLM-proposed rationale — advisory only, cannot lower the floor. */
  llmProposedLevel?: RiskLevel;
  llmRationale?: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  /** The system-computed floor: the final level is never below this. */
  floor: RiskLevel;
  reasons: string[];
  authorization: RiskAuthorization;
  llmRationaleNoted?: string;
}

function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

function authorizationFor(level: RiskLevel): RiskAuthorization {
  switch (level) {
    case 'LOW':
      return { kind: 'AUTO' };
    case 'MEDIUM':
      return { kind: 'PROJECT_PREAUTH_OR_HUMAN' };
    case 'HIGH':
      return { kind: 'HUMAN_PLUS_SPECIALIST' };
    case 'CRITICAL':
      return { kind: 'DENY_UNATTENDED' };
  }
}

/**
 * Assess deployment risk. The floor is computed from hard signals; an LLM
 * proposal can only be noted, never used to lower the level.
 */
export function assessRisk(input: RiskInput): RiskAssessment {
  let floor: RiskLevel = 'LOW';
  const reasons: string[] = [];

  const raise = (level: RiskLevel, reason: string) => {
    if (RISK_ORDER[level] > RISK_ORDER[floor]) floor = level;
    reasons.push(reason);
  };

  // CRITICAL signals — §41.1 examples.
  if (/data-deletion|wipe|drop-table/i.test(input.changeType)) {
    raise('CRITICAL', 'irreversible data deletion');
  }
  if (/payment|billing|charge/i.test(input.changeType) && input.externalSideEffects) {
    raise('CRITICAL', 'financial external write');
  }
  if (input.blastRadius === 'unbounded') {
    raise('CRITICAL', 'unbounded blast radius');
  }
  // HIGH signals.
  if (/auth|permission|secret/i.test(input.changeType)) {
    raise('HIGH', 'auth/permission-sensitive change');
  }
  if (input.securityDataImpact) raise('HIGH', 'security/data impact');
  if (input.hasMigration) raise('HIGH', 'includes DB migration');
  if (input.businessCritical) raise('HIGH', 'business-critical flow');
  if (input.blastRadius === 'platform-wide') raise('HIGH', 'platform-wide blast radius');
  // MEDIUM signals.
  if (input.blastRadius === 'multi-service') raise('MEDIUM', 'multi-service blast radius');
  if (/dependency-upgrade/i.test(input.changeType)) raise('MEDIUM', 'dependency upgrade');
  if (input.externalSideEffects) raise('MEDIUM', 'external side effects');
  if (input.environmentDrift) raise('MEDIUM', 'environment drift detected');
  // Unknown / missing readiness → strict.
  if (!input.recoveryReady) raise('HIGH', 'no verified recovery path (unknown → strict)');
  if (!input.observabilityReady) raise('MEDIUM', 'observability not ready (unknown → strict)');
  if (!input.testIndependence) raise('MEDIUM', 'tests not independently verified');

  // The LLM proposal is advisory: it can never lower the floor.
  let level: RiskLevel = floor;
  let llmRationaleNoted: string | undefined;
  if (input.llmProposedLevel) {
    llmRationaleNoted = input.llmRationale ?? `LLM proposed ${input.llmProposedLevel} (advisory only)`;
    level = maxLevel(floor, input.llmProposedLevel);
    if (RISK_ORDER[input.llmProposedLevel] < RISK_ORDER[floor]) {
      reasons.push(`LLM-proposed ${input.llmProposedLevel} rejected: below system floor ${floor}`);
    }
  }

  return { level, floor, reasons, authorization: authorizationFor(level), llmRationaleNoted };
}

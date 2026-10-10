/**
 * Pre-deploy gates — SPEC v2 §41.3.
 *
 * Every gate must be valid before the final submit: Build, Review,
 * applicable Unit/Integration/E2E/Regression/Security tests, UAT,
 * Risk/Reversibility, Policy/Approval, Environment Health, Recovery
 * Readiness, Observe/Outcome definitions, Budget, Deployment Lease.
 *
 * The production coder has no direct admin DB/secret access — production
 * writes go through the Release Broker under a dedicated temporary identity.
 * Right before submit we re-check: approval digest, permission revocations,
 * target drift, and the deployment lease.
 */
import { randomUUID } from 'node:crypto';

/** The §41.3 gate checklist — every key must be checked. */
export const PRE_DEPLOY_GATES = [
  'build',
  'review',
  'unitTests',
  'integrationTests',
  'e2eTests',
  'regressionTests',
  'securityTests',
  'uat',
  'risk',
  'reversibility',
  'policy',
  'approval',
  'envHealth',
  'recoveryReadiness',
  'observeOutcomeDefs',
  'budget',
  'deploymentLease',
] as const;

export type PreDeployGate = (typeof PRE_DEPLOY_GATES)[number];

export type GateState = 'VALID' | 'INVALID' | 'NOT_APPLICABLE';

export interface PreDeployInput {
  gates: Partial<Record<PreDeployGate, GateState>>;
  /** Gates that are legitimately N/A need a recorded justification. */
  naJustifications?: Partial<Record<PreDeployGate, string>>;
  /** Final submit re-checks. */
  finalRecheck?: {
    approvalDigest: string;
    expectedApprovalDigest: string;
    permissionRevoked: boolean;
    targetDrift: boolean;
    leaseValid: boolean;
  };
  now?: () => number;
}

export interface PreDeployResult {
  ok: boolean;
  missing: PreDeployGate[];
  invalid: PreDeployGate[];
  unjustifiedNa: PreDeployGate[];
  finalRecheckFailed?: string[];
}

export class FinalRecheckFailedError extends Error {
  constructor(public readonly failures: string[]) {
    super(`Final pre-submit re-check failed: ${failures.join('; ')}`);
    this.name = 'FinalRecheckFailedError';
  }
}

/** Evaluate the full pre-deploy gate checklist. */
export function checkPreDeployGates(input: PreDeployInput): PreDeployResult {
  const missing: PreDeployGate[] = [];
  const invalid: PreDeployGate[] = [];
  const unjustifiedNa: PreDeployGate[] = [];
  for (const gate of PRE_DEPLOY_GATES) {
    const state = input.gates[gate];
    if (state === undefined || state === null) {
      missing.push(gate);
    } else if (state === 'INVALID') {
      invalid.push(gate);
    } else if (state === 'NOT_APPLICABLE') {
      const j = input.naJustifications?.[gate];
      if (!j || !j.trim()) unjustifiedNa.push(gate);
    }
  }
  const finalRecheckFailed: string[] = [];
  const fr = input.finalRecheck;
  if (fr) {
    if (fr.approvalDigest !== fr.expectedApprovalDigest) {
      finalRecheckFailed.push('approval digest changed since approval');
    }
    if (fr.permissionRevoked) finalRecheckFailed.push('permission revoked since approval');
    if (fr.targetDrift) finalRecheckFailed.push('target drift detected');
    if (!fr.leaseValid) finalRecheckFailed.push('deployment lease invalid');
  }
  return {
    ok:
      missing.length === 0 &&
      invalid.length === 0 &&
      unjustifiedNa.length === 0 &&
      finalRecheckFailed.length === 0,
    missing,
    invalid,
    unjustifiedNa,
    finalRecheckFailed: finalRecheckFailed.length > 0 ? finalRecheckFailed : undefined,
  };
}

/**
 * The Release Broker identity: production deploys run under a dedicated
 * short-lived identity, never the coder's own credentials (§41.3).
 */
export interface ReleaseBrokerIdentity {
  brokerId: string;
  deploymentId: string;
  scopes: string[];
  expiresAt: string;
}

export function issueBrokerIdentity(
  deploymentId: string,
  scopes: string[],
  ttlMs: number,
  now: () => number = Date.now,
): ReleaseBrokerIdentity {
  return {
    brokerId: `broker-${randomUUID().slice(0, 8)}`,
    deploymentId,
    scopes,
    expiresAt: new Date(now() + ttlMs).toISOString(),
  };
}

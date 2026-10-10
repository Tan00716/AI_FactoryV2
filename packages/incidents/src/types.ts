/**
 * Incident domain types — SPEC v2 §42.
 */

/** §42 incident lifecycle. */
export type IncidentStatus =
  | 'DETECTED'
  | 'TRIAGED'
  | 'INVESTIGATING'
  | 'MITIGATING'
  | 'RECOVERING'
  | 'RESOLVED'
  | 'POSTMORTEM'
  | 'CLOSED';

export const ALL_INCIDENT_STATUSES: readonly IncidentStatus[] = [
  'DETECTED',
  'TRIAGED',
  'INVESTIGATING',
  'MITIGATING',
  'RECOVERING',
  'RESOLVED',
  'POSTMORTEM',
  'CLOSED',
] as const;

/** Legal lifecycle edges. Skips are not allowed — every phase is recorded. */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  DETECTED: ['TRIAGED'],
  TRIAGED: ['INVESTIGATING'],
  INVESTIGATING: ['MITIGATING', 'TRIAGED'],
  MITIGATING: ['RECOVERING', 'INVESTIGATING'],
  RECOVERING: ['RESOLVED', 'MITIGATING'],
  RESOLVED: ['POSTMORTEM'],
  POSTMORTEM: ['CLOSED'],
  CLOSED: [],
};

export type IncidentSeverity = 'P0' | 'P1' | 'P2' | 'P3';

/**
 * §42 runbook: trigger, false-positive checks, allowed envs/tools/actions,
 * max blast radius, budget, approval conditions, recovery/stop points,
 * verification and notifications. Deterministic rules only — a runbook never
 * says "let the model decide".
 */
export interface Runbook {
  id: string;
  name: string;
  trigger: string;
  falsePositiveChecks: string[];
  allowedEnvs: string[];
  allowedTools: string[];
  allowedActions: string[];
  maxBlastRadius: string;
  budgetUnits: number;
  /** When human approval is still required before auto-mitigation. */
  approvalConditions: string[];
  recoveryStopPoints: string[];
  verification: string[];
  notifications: string[];
  /** Pre-authorized by policy for automatic mitigation. */
  preauthorized: boolean;
  version: number;
}

export interface IncidentEvent {
  at: string;
  actor: string;
  kind: string;
  detail?: string;
}

export interface Incident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  detectedAt: string;
  updatedAt: string;
  /** Recovery evidence required before RESOLVED. */
  recoveryEvidenceRefs: string[];
  rootCause?: string;
  followUp?: string[];
  /** Policy may require a human to confirm closure. */
  humanConfirmedBy?: string;
  runbookId?: string;
  events: IncidentEvent[];
  /** How the incident was resolved — changing alert thresholds alone never counts. */
  resolutionBasis?: string;
}

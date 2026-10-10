/**
 * Incident manager — SPEC v2 §42.
 *
 * Monitoring agents detect, create, investigate, mitigate (only via
 * pre-authorized runbooks), recover and report. Non-incident improvements
 * without pre-authorization become TODO/Proposal, never silent auto-work.
 *
 * Hard rules:
 *  - RESOLVED requires recovery evidence;
 *  - CLOSED requires root cause + follow-ups (+ human confirmation when policy demands);
 *  - a production incident cannot be "resolved" by changing alert thresholds;
 *  - when an Emergency Stop was triggered by an untrusted tool, recovery must
 *    use an isolated path — the same tool may not run the recovery.
 */
import { randomUUID } from 'node:crypto';
import {
  ALL_INCIDENT_STATUSES,
  INCIDENT_TRANSITIONS,
  Incident,
  IncidentEvent,
  IncidentSeverity,
  IncidentStatus,
  Runbook,
} from './types';

export class IncidentNotFoundError extends Error {
  constructor(id: string) {
    super(`Incident ${id} not found`);
    this.name = 'IncidentNotFoundError';
  }
}

export class IllegalIncidentTransitionError extends Error {
  constructor(from: IncidentStatus, to: IncidentStatus) {
    super(`Illegal incident transition ${from} → ${to}`);
    this.name = 'IllegalIncidentTransitionError';
  }
}

export class MissingRecoveryEvidenceError extends Error {
  constructor() {
    super('RESOLVED requires recovery evidence — an incident is not resolved by assertion');
    this.name = 'MissingRecoveryEvidenceError';
  }
}

export class ThresholdGamingRefusedError extends Error {
  constructor() {
    super(
      'A production incident cannot be resolved by changing alert thresholds. Provide recovery evidence.',
    );
    this.name = 'ThresholdGamingRefusedError';
  }
}

export class IncompletePostmortemError extends Error {
  constructor(missing: string[]) {
    super(`CLOSED requires ${missing.join(' and ')} — postmortem is incomplete`);
    this.name = 'IncompletePostmortemError';
  }
}

export interface CreateIncidentInput {
  title: string;
  severity: IncidentSeverity;
  detectedBy: string;
  runbookId?: string;
}

export interface ClosePolicy {
  /** When true, a human must confirm closure. */
  requireHumanConfirmation: boolean;
}

export class IncidentManager {
  private readonly incidents = new Map<string, Incident>();
  private readonly runbooks = new Map<string, Runbook>();
  private readonly now: () => number;
  private readonly closePolicy: ClosePolicy;

  constructor(opts: { now?: () => number; closePolicy?: ClosePolicy } = {}) {
    this.now = opts.now ?? Date.now;
    this.closePolicy = opts.closePolicy ?? { requireHumanConfirmation: false };
  }

  registerRunbook(runbook: Runbook): Runbook {
    if (!runbook.id) throw new Error('runbook.id is required');
    this.runbooks.set(runbook.id, runbook);
    return runbook;
  }

  getRunbook(id: string): Runbook | undefined {
    return this.runbooks.get(id);
  }

  /** Detection creates the incident — always starts at DETECTED. */
  create(input: CreateIncidentInput): Incident {
    if (!input.title?.trim()) throw new Error('title is required');
    const at = new Date(this.now()).toISOString();
    const incident: Incident = {
      id: randomUUID(),
      title: input.title,
      severity: input.severity,
      status: 'DETECTED',
      detectedAt: at,
      updatedAt: at,
      recoveryEvidenceRefs: [],
      runbookId: input.runbookId,
      events: [{ at, actor: input.detectedBy, kind: 'DETECTED' }],
    };
    this.incidents.set(incident.id, incident);
    return incident;
  }

  get(id: string): Incident {
    const inc = this.incidents.get(id);
    if (!inc) throw new IncidentNotFoundError(id);
    return inc;
  }

  list(status?: IncidentStatus): Incident[] {
    const all = [...this.incidents.values()];
    return status ? all.filter((i) => i.status === status) : all;
  }

  private record(incident: Incident, event: Omit<IncidentEvent, 'at'>): void {
    incident.events.push({ ...event, at: new Date(this.now()).toISOString() });
    incident.updatedAt = new Date(this.now()).toISOString();
  }

  /** Move along the lifecycle. Only declared edges are legal. */
  transition(id: string, to: IncidentStatus, actor: string, detail?: string): Incident {
    const inc = this.get(id);
    if (!INCIDENT_TRANSITIONS[inc.status].includes(to)) {
      throw new IllegalIncidentTransitionError(inc.status, to);
    }
    if (to === 'RESOLVED') this.assertResolvable(inc);
    if (to === 'CLOSED') this.assertClosable(inc);
    const from = inc.status;
    inc.status = to;
    this.record(inc, { actor, kind: `TRANSITION:${from}→${to}`, detail });
    return inc;
  }

  /** Attach recovery evidence (required before RESOLVED). */
  addRecoveryEvidence(id: string, ref: string, actor: string): Incident {
    const inc = this.get(id);
    if (!ref?.trim()) throw new Error('evidence ref is required');
    inc.recoveryEvidenceRefs.push(ref);
    this.record(inc, { actor, kind: 'RECOVERY_EVIDENCE', detail: ref });
    return inc;
  }

  /**
   * Record how the incident was resolved. Resolving "by changing the alert
   * threshold" is refused outright — §42: production incidents don't vanish
   * by editing thresholds.
   */
  setResolutionBasis(id: string, basis: string, actor: string): Incident {
    const inc = this.get(id);
    if (/threshold/i.test(basis) && !/evidence/i.test(basis)) {
      throw new ThresholdGamingRefusedError();
    }
    inc.resolutionBasis = basis;
    this.record(inc, { actor, kind: 'RESOLUTION_BASIS', detail: basis });
    return inc;
  }

  private assertResolvable(inc: Incident): void {
    if (inc.recoveryEvidenceRefs.length === 0) throw new MissingRecoveryEvidenceError();
  }

  private assertClosable(inc: Incident): void {
    const missing: string[] = [];
    if (!inc.rootCause?.trim()) missing.push('root cause');
    if (!inc.followUp || inc.followUp.length === 0) missing.push('follow-ups');
    if (this.closePolicy.requireHumanConfirmation && !inc.humanConfirmedBy) {
      missing.push('human confirmation');
    }
    if (missing.length > 0) throw new IncompletePostmortemError(missing);
  }

  setPostmortem(
    id: string,
    input: { rootCause: string; followUp: string[]; humanConfirmedBy?: string },
    actor: string,
  ): Incident {
    const inc = this.get(id);
    inc.rootCause = input.rootCause;
    inc.followUp = [...input.followUp];
    if (input.humanConfirmedBy) inc.humanConfirmedBy = input.humanConfirmedBy;
    this.record(inc, { actor, kind: 'POSTMORTEM_RECORDED' });
    return inc;
  }

  /**
   * Whether the runbook's mitigation may run automatically: only when the
   * runbook is pre-authorized AND its approval conditions are satisfied.
   * During Factory Pause the monitor/safety domain keeps running — mitigation
   * uses independent priority and reserved resources (modeled by the caller).
   */
  canAutoMitigate(runbookId: string, approvalConditionsSatisfied: boolean): boolean {
    const rb = this.runbooks.get(runbookId);
    if (!rb) return false;
    if (!rb.preauthorized) return false;
    if (rb.approvalConditions.length > 0 && !approvalConditionsSatisfied) return false;
    return true;
  }

  /**
   * Recovery planning after an Emergency Stop: when the stop was triggered by
   * an untrusted tool, that tool must not run the recovery — an isolated
   * recovery path is required (§42).
   */
  planRecovery(input: { incidentId: string; triggeredByUntrustedTool: boolean }): {
    isolatedPathRequired: boolean;
    forbiddenTools: string[];
  } {
    this.get(input.incidentId); // validates existence
    if (input.triggeredByUntrustedTool) {
      return { isolatedPathRequired: true, forbiddenTools: ['*triggering-tool*'] };
    }
    return { isolatedPathRequired: false, forbiddenTools: [] };
  }
}

export { ALL_INCIDENT_STATUSES };

/**
 * Deploy flow — spec §41 (PRODUCTION POLICY), §77 (SNAPSHOT / RECOVERY).
 *
 * Pre-deploy gates:
 *   1. Rollback capability check — a deploy is REFUSED when the environment
 *      has no rollback method (spec §77: "Production deployments must have
 *      rollback capability before automatic deployment is enabled").
 *   2. Approval evaluation — reuses @ai-factory/approvals' evaluateAction()
 *      (never reimplemented here). When approval is required the flow returns
 *      a PendingApprovalDescriptor instead of blocking forever; the server
 *      completes the @ai-factory/approvals lifecycle (ApprovalManager.request
 *      → human decide → approvalEvidencePayload) and calls resume() with the
 *      granted approval id.
 *
 * On deploy/smoke failure the pre-deploy snapshot is restored automatically
 * (spec §77: "If failed: Restore Snapshot").
 */

import { randomUUID } from 'node:crypto';
import { nowIso } from '@ai-factory/core';
import type { ActionEvaluation, ApprovalLevel } from '@ai-factory/approvals';
import { approvalActionFor, evaluateApprovalPolicy } from './environments';
import type {
  Deployment,
  Environment,
  EnvironmentName,
  Snapshot,
} from './types';
import type { AuditFn, EvidenceFn } from './pipeline';

/** Thrown by the §77 pre-deploy gate when no rollback method is configured. */
export class RollbackCapabilityError extends Error {
  constructor(env: EnvironmentName) {
    super(
      `Deploy to ${env} refused: no rollback method configured. ` +
        `Spec §77 requires rollback capability before (automatic) deployment.`,
    );
    this.name = 'RollbackCapabilityError';
  }
}

export class SnapshotNotFoundError extends Error {
  constructor(id: string) {
    super(`Snapshot ${id} not found`);
    this.name = 'SnapshotNotFoundError';
  }
}

export class DeploymentNotFoundError extends Error {
  constructor(id: string) {
    super(`Deployment ${id} not found`);
    this.name = 'DeploymentNotFoundError';
  }
}

export class DeploymentNotPendingError extends Error {
  constructor(id: string, status: string) {
    super(
      `Deployment ${id} is ${status}, not AWAITING_APPROVAL — cannot resume`,
    );
    this.name = 'DeploymentNotPendingError';
  }
}

/** In-memory snapshot store (spec §77). */
export class SnapshotStore {
  private readonly map = new Map<string, Snapshot>();

  /**
   * Take a snapshot before a major operation. `data` is the opaque pre-op
   * state the caller wants back if the operation fails.
   */
  take(label: string, data: unknown, environment: EnvironmentName): Snapshot {
    const snap: Snapshot = {
      id: randomUUID(),
      label,
      data,
      environment,
      createdAt: nowIso(),
    };
    this.map.set(snap.id, snap);
    return snap;
  }

  get(id: string): Snapshot | undefined {
    return this.map.get(id);
  }

  list(): Snapshot[] {
    return [...this.map.values()];
  }
}

/**
 * spec §77 — restore a snapshot after a failed operation. Returns the
 * snapshot whose pre-op `data` was restored; the caller applies that data to
 * the environment (in this prototype the data is opaque).
 */
export function rollback(
  store: SnapshotStore,
  snapshotId: string,
): { snapshot: Snapshot } {
  const snap = store.get(snapshotId);
  if (!snap) throw new SnapshotNotFoundError(snapshotId);
  return { snapshot: snap };
}

/**
 * What the deploy flow hands back when the approvals policy requires a
 * decision before proceeding. The server turns `action` into an
 * ApprovalManager.request({ action, ... }) and, once a human approves,
 * resumes via DeploymentService.resume(deploymentId, { approvalId }).
 */
export interface PendingApprovalDescriptor {
  deploymentId: string;
  environment: EnvironmentName;
  /** Action name for ApprovalManager.request(), e.g. 'deploy.prod'. */
  action: string;
  level: ApprovalLevel;
  requiresApproval: boolean;
  /** Human-readable policy reason from @ai-factory/approvals. */
  reason: string;
  /** The full @ai-factory/approvals evaluation, for UI / audit display. */
  evaluation: ActionEvaluation;
}

export interface DeployOutcome {
  deployment: Deployment;
  /** Non-null when the deploy is parked waiting for an approval decision. */
  pendingApproval: PendingApprovalDescriptor | null;
}

export interface DeployFnResult {
  logs: string[];
}

export interface DeployOptions {
  pipelineId: string;
  environment: Environment;
  store: SnapshotStore;
  /**
   * Opaque pre-deploy state to snapshot (e.g. current version tag). Restored
   * automatically if the deploy or smoke test fails (spec §77).
   */
  preDeployState?: unknown;
  /**
   * Pre-granted approval id (the server verified it via ApprovalManager).
   * When set, the deploy proceeds even if the policy requires approval.
   */
  approvalId?: string;
  /** Performs the actual deployment. Defaults to a simulated success. */
  deployFn?: (env: Environment, snapshot: Snapshot) => Promise<DeployFnResult>;
  /** Post-deploy smoke test hook. Defaults to a simulated success. */
  smokeFn?: (env: Environment) => Promise<DeployFnResult>;
  evidence?: EvidenceFn;
  audit?: AuditFn;
}

export interface ResumeInput {
  approvalId: string;
}

interface StoredJob {
  deployment: Deployment;
  environment: Environment;
  snapshot: Snapshot;
  store: SnapshotStore;
  deployFn: NonNullable<DeployOptions['deployFn']>;
  smokeFn: NonNullable<DeployOptions['smokeFn']>;
  evidence: EvidenceFn;
  audit: AuditFn;
}

function noop(): void {
  // intentional
}

export class DeploymentService {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly evidence: EvidenceFn;
  private readonly audit: AuditFn;

  constructor(opts: { evidence?: EvidenceFn; audit?: AuditFn } = {}) {
    this.evidence = opts.evidence ?? noop;
    this.audit = opts.audit ?? noop;
  }

  private emit(
    action: string,
    deployment: Deployment,
    detail: Record<string, unknown> = {},
  ): void {
    this.audit(action, {
      deploymentId: deployment.id,
      pipelineId: deployment.pipelineId,
      environment: deployment.environment,
      status: deployment.status,
      ...detail,
    });
  }

  /**
   * Start a deployment. Runs the pre-deploy gates (§77 rollback capability,
   * §41 approval evaluation) and either proceeds or parks the deployment at
   * AWAITING_APPROVAL with a PendingApprovalDescriptor.
   */
  async deploy(opts: DeployOptions): Promise<DeployOutcome> {
    const { environment: env, store } = opts;

    // Gate 1 — spec §77: refuse deploys with no rollback capability.
    if (!env.rollbackMethod || env.rollbackMethod.trim() === '') {
      throw new RollbackCapabilityError(env.name);
    }

    // Gate 2 — spec §41: approval evaluation via @ai-factory/approvals.
    const evaluation: ActionEvaluation = evaluateApprovalPolicy(env.name);
    if (evaluation.level === 'BLOCKED') {
      throw new Error(
        `Deploy action '${approvalActionFor(env.name)}' is BLOCKED by approval policy`,
      );
    }

    const deployment: Deployment = {
      id: randomUUID(),
      pipelineId: opts.pipelineId,
      environment: env.name,
      status: 'PENDING',
      snapshotId: null,
      approvalId: opts.approvalId ?? null,
      startedAt: null,
      endedAt: null,
    };

    // Spec §77: snapshot before the operation.
    const snapshot = store.take(
      `pre-deploy ${deployment.id} → ${env.name}`,
      opts.preDeployState ?? null,
      env.name,
    );
    deployment.snapshotId = snapshot.id;
    this.emit('DEPLOY_SNAPSHOT_TAKEN', deployment, { snapshotId: snapshot.id });
    this.evidence('deploy-snapshot', {
      deploymentId: deployment.id,
      snapshotId: snapshot.id,
      label: snapshot.label,
    });

    const job: StoredJob = {
      deployment,
      environment: env,
      snapshot,
      store,
      deployFn:
        opts.deployFn ??
        (async () => ({ logs: [`[${env.name}] simulated deploy OK`] })),
      smokeFn:
        opts.smokeFn ??
        (async () => ({ logs: [`[${env.name}] simulated smoke test OK`] })),
      evidence: opts.evidence ?? this.evidence,
      audit: opts.audit ?? this.audit,
    };
    this.jobs.set(deployment.id, job);

    if (evaluation.requiresApproval && !opts.approvalId) {
      deployment.status = 'AWAITING_APPROVAL';
      this.emit('APPROVAL_REQUIRED', deployment, {
        action: approvalActionFor(env.name),
        level: evaluation.level,
        reason: evaluation.reason,
      });
      job.evidence('approval-request', {
        deploymentId: deployment.id,
        action: approvalActionFor(env.name),
        level: evaluation.level,
        reason: evaluation.reason,
      });
      return {
        deployment,
        pendingApproval: {
          deploymentId: deployment.id,
          environment: env.name,
          action: approvalActionFor(env.name),
          level: evaluation.level,
          requiresApproval: evaluation.requiresApproval,
          reason: evaluation.reason,
          evaluation,
        },
      };
    }

    return this.execute(job);
  }

  /**
   * Resume a deployment parked at AWAITING_APPROVAL. `approvalId` is the id
   * of the APPROVED approval (created/decided via ApprovalManager on the
   * server side); it is recorded on the deployment as evidence of the gate.
   */
  async resume(deploymentId: string, input: ResumeInput): Promise<DeployOutcome> {
    const job = this.jobs.get(deploymentId);
    if (!job) throw new DeploymentNotFoundError(deploymentId);
    if (job.deployment.status !== 'AWAITING_APPROVAL') {
      throw new DeploymentNotPendingError(deploymentId, job.deployment.status);
    }
    if (!input.approvalId) throw new Error('approvalId is required to resume');
    job.deployment.approvalId = input.approvalId;
    this.emit('DEPLOY_RESUMED', job.deployment, {
      approvalId: input.approvalId,
    });
    return this.execute(job);
  }

  /** Execute the deploy + smoke phases, auto-rolling back on failure (§77). */
  private async execute(job: StoredJob): Promise<DeployOutcome> {
    const { deployment, environment: env, snapshot, store } = job;
    deployment.status = 'DEPLOYING';
    deployment.startedAt = nowIso();
    this.emit('DEPLOY_STARTED', deployment);

    const finish = (status: Deployment['status'], extra: Record<string, unknown> = {}): void => {
      deployment.status = status;
      deployment.endedAt = nowIso();
      Object.assign(deployment, extra);
    };

    try {
      const deployResult = await job.deployFn(env, snapshot);
      job.audit('DEPLOY_STEP_OK', { deploymentId: deployment.id, phase: 'deploy', logs: deployResult.logs });

      const smokeResult = await job.smokeFn(env);
      job.audit('DEPLOY_STEP_OK', { deploymentId: deployment.id, phase: 'smoke', logs: smokeResult.logs });

      finish('SUCCEEDED');
      this.emit('DEPLOY_SUCCEEDED', deployment);
      job.evidence('deployment', {
        deploymentId: deployment.id,
        environment: deployment.environment,
        status: 'SUCCEEDED',
        approvalId: deployment.approvalId,
      });
      return { deployment, pendingApproval: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish('FAILED', { error: message });
      this.emit('DEPLOY_FAILED', deployment, { message });

      // Spec §77: failed → restore snapshot automatically.
      const { snapshot: restored } = rollback(store, snapshot.id);
      finish('ROLLED_BACK', { error: message });
      this.emit('DEPLOYMENT_ROLLED_BACK', deployment, {
        message,
        snapshotId: restored.id,
        restoredLabel: restored.label,
      });
      job.evidence('deployment', {
        deploymentId: deployment.id,
        environment: deployment.environment,
        status: 'ROLLED_BACK',
        message,
        restoredSnapshotId: restored.id,
      });
      return { deployment, pendingApproval: null };
    }
  }
}

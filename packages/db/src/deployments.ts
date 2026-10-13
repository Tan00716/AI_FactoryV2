/**
 * Durable deployment records — SPEC v2 §41 (Production Policy), §77
 * (Snapshot/Recovery), Batch 19-1.
 *
 * Parked deployment jobs used to be pure process memory (like the
 * pipeline record itself): a server restart turned every
 * AWAITING_APPROVAL deployment into a 404 at approve time — explicit,
 * but the deployment was still lost. This store persists the
 * RECONSTRUCTABLE deployment spec so a restarted server can rebuild
 * the job instead of mourning it.
 *
 * The deliberate split, pinned by tests:
 *  - what is persisted is a SPEC, not a job: argv-level detail is
 *    not needed here because the server's deployFn/smokeFn are
 *    host-injected (simulated in this prototype); what the spec
 *    captures is everything needed to REBUILD the job safely —
 *    environment + rollback capability, the §77 snapshot (id/label/
 *    opaque pre-deploy data), the §41 approval descriptor and policy
 *    evaluation snapshot, task/binding context, and secret REFERENCE
 *    names only (never values — there is no values field on this
 *    type by construction);
 *  - the rebuilt job is marked REHYDRATED in the audit trail; it is
 *    never presented as the original job. Rebuild re-validates the
 *    archive guard and rollback capability against CURRENT state —
 *    a project archived while the server was down stays refused;
 *  - statuses mirror packages/cicd's DeploymentStatus (the
 *    spec-grounded vocabulary: PENDING / AWAITING_APPROVAL /
 *    DEPLOYING / SUCCEEDED / FAILED / ROLLED_BACK); the row is a
 *    faithful projection of the deployment record plus the spec.
 *
 * Copy contract: the spec is opaque JSON (SQLite) / structuredClone
 * (memory); every read returns a fresh deep copy.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type PersistedDeploymentStatus =
  | 'PENDING'
  | 'AWAITING_APPROVAL'
  | 'DEPLOYING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'ROLLED_BACK';

/**
 * The reconstructable deployment spec. Everything in here is either
 * public metadata or secret REFERENCE NAMES. There is deliberately no
 * field for secret values: this type cannot carry one.
 */
export interface DeploymentSpec {
  /** Environment name the deploy targets (LOCAL/DEV/UAT/PROD). */
  environment: string;
  /** Rollback method declared at park time (re-checked at rebuild). */
  rollbackMethod: string | null;
  /** The §41 approval descriptor handed back when the deploy parked. */
  approvalDescriptor: {
    deploymentId: string;
    action: string;
    level: string;
    requiresApproval: boolean;
    reason: string;
  };
  /** The approval-policy evaluation at park time (budget/policy snapshot). */
  policySnapshot: unknown;
  /** Opaque pre-deploy state snapshotted per §77 (may be null). */
  preDeployState: unknown;
  /** §77 snapshot id/label/data persisted with the row. */
  snapshot: {
    id: string;
    label: string;
    data: unknown;
    createdAt: string;
  };
  /** Task the deployment is bound to (evidence + approvals hang here). */
  taskId: string | null;
  /** Actor that initiated the deploy (null when unknown). */
  actor: string | null;
  /** Secret REFERENCE names only — never values. */
  secretRefs: string[];
}

export interface PersistedDeployment {
  id: string;
  pipelineId: string;
  taskId: string | null;
  projectId: string | null;
  environment: string;
  status: PersistedDeploymentStatus;
  spec: DeploymentSpec;
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  error: string | null;
  /** ISO time of a post-restart rebuild; null when never rebuilt. */
  rehydratedAt: string | null;
}

export interface DeploymentStore {
  /** Insert or replace by id (park time and every status transition). */
  save(record: PersistedDeployment): void;
  get(id: string): PersistedDeployment | undefined;
  byPipeline(pipelineId: string): PersistedDeployment[];
  list(): PersistedDeployment[];
  /** Stamp the rebuild marker; no-op when the row is unknown. */
  markRehydrated(id: string, at: string): void;
}

const copy = <T>(v: T): T => structuredClone(v);

/** In-memory implementation: the behavior reference. */
export class InMemoryDeploymentStore implements DeploymentStore {
  private readonly map = new Map<string, PersistedDeployment>();

  save(record: PersistedDeployment): void {
    this.map.set(record.id, copy(record));
  }

  get(id: string): PersistedDeployment | undefined {
    const row = this.map.get(id);
    return row === undefined ? undefined : copy(row);
  }

  byPipeline(pipelineId: string): PersistedDeployment[] {
    return [...this.map.values()]
      .filter((r) => r.pipelineId === pipelineId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(copy);
  }

  list(): PersistedDeployment[] {
    return [...this.map.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(copy);
  }

  markRehydrated(id: string, at: string): void {
    const row = this.map.get(id);
    if (row) row.rehydratedAt = at;
  }
}

function rowOf(r: Record<string, unknown>): PersistedDeployment {
  return {
    id: r['id'] as string,
    pipelineId: r['pipeline_id'] as string,
    taskId: (r['task_id'] as string | null) ?? null,
    projectId: (r['project_id'] as string | null) ?? null,
    environment: r['environment'] as string,
    status: r['status'] as PersistedDeploymentStatus,
    spec: JSON.parse(r['spec_json'] as string) as DeploymentSpec,
    approvalId: (r['approval_id'] as string | null) ?? null,
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
    endedAt: (r['ended_at'] as string | null) ?? null,
    error: (r['error'] as string | null) ?? null,
    rehydratedAt: (r['rehydrated_at'] as string | null) ?? null,
  };
}

/** SQLite implementation, pinned against the in-memory reference. */
export class SqliteDeploymentStore implements DeploymentStore {
  // The deployments table lives in schema.ts (exec'd on open); this
  // constructor assumes the open-path migration already ran.
  constructor(private readonly db: DatabaseSync) {}

  save(record: PersistedDeployment): void {
    this.db
      .prepare(
        `INSERT INTO deployments
           (id, pipeline_id, task_id, project_id, environment, status,
            spec_json, approval_id, created_at, updated_at, ended_at,
            error, rehydrated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           pipeline_id=excluded.pipeline_id, task_id=excluded.task_id,
           project_id=excluded.project_id, environment=excluded.environment,
           status=excluded.status, spec_json=excluded.spec_json,
           approval_id=excluded.approval_id, created_at=excluded.created_at,
           updated_at=excluded.updated_at, ended_at=excluded.ended_at,
           error=excluded.error, rehydrated_at=excluded.rehydrated_at`,
      )
      .run(
        record.id,
        record.pipelineId,
        record.taskId,
        record.projectId,
        record.environment,
        record.status,
        JSON.stringify(record.spec),
        record.approvalId,
        record.createdAt,
        record.updatedAt,
        record.endedAt,
        record.error,
        record.rehydratedAt,
      );
  }

  get(id: string): PersistedDeployment | undefined {
    const row = this.db
      .prepare('SELECT * FROM deployments WHERE id = ?')
      .get(id) as unknown as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowOf(row);
  }

  byPipeline(pipelineId: string): PersistedDeployment[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM deployments WHERE pipeline_id = ? ORDER BY created_at',
        )
        .all(pipelineId) as unknown as Record<string, unknown>[]
    ).map(rowOf);
  }

  list(): PersistedDeployment[] {
    return (
      this.db
        .prepare('SELECT * FROM deployments ORDER BY created_at')
        .all() as unknown as Record<string, unknown>[]
    ).map(rowOf);
  }

  markRehydrated(id: string, at: string): void {
    this.db
      .prepare('UPDATE deployments SET rehydrated_at = ? WHERE id = ?')
      .run(at, id);
  }
}

/** Test helper: build a minimal valid spec. */
export function makeDeploymentSpec(
  overrides: Partial<DeploymentSpec> = {},
): DeploymentSpec {
  const stamp = new Date().toISOString();
  return {
    environment: 'PROD',
    rollbackMethod: 'snapshot',
    approvalDescriptor: {
      deploymentId: 'dep-x',
      action: 'deploy.prod',
      level: 'HIGH',
      requiresApproval: true,
      reason: 'PROD always requires approval',
    },
    policySnapshot: { level: 'HIGH', requiresApproval: true },
    preDeployState: { version: 'v1.2.3' },
    snapshot: { id: 'snap-x', label: 'pre-deploy', data: { version: 'v1.2.3' }, createdAt: stamp },
    taskId: 'task-x',
    actor: 'human',
    secretRefs: [],
    ...overrides,
  };
}

/** Test helper: build a minimal persisted record. */
export function makePersistedDeployment(
  overrides: Partial<PersistedDeployment> = {},
): PersistedDeployment {
  const stamp = new Date().toISOString();
  return {
    id: randomUUID(),
    pipelineId: 'pipe-x',
    taskId: 'task-x',
    projectId: null,
    environment: 'PROD',
    status: 'AWAITING_APPROVAL',
    spec: makeDeploymentSpec(),
    approvalId: null,
    createdAt: stamp,
    updatedAt: stamp,
    endedAt: null,
    error: null,
    rehydratedAt: null,
    ...overrides,
  };
}

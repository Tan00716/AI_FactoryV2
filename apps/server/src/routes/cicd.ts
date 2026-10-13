/**
 * CI/CD routes — spec §39 (CI/CD Engine), §40 (Environments), §41 (Production
 * Policy), §77 (Snapshot/Recovery).
 *
 *   GET  /api/environments                      list LOCAL/DEV/UAT/PROD
 *   POST /api/pipelines                  {environment?, commitSha?, taskId?}
 *   GET  /api/pipelines                     list pipelines (in-memory)
 *   GET  /api/pipelines/:id                 one pipeline
 *   POST /api/pipelines/:id/run             {actor?} → run the 8 stages
 *   POST /api/pipelines/:id/deploy          {environment, taskId, actor?}
 *   POST /api/pipelines/:id/approve         {approvalId, actor?} → resume parked deploy
 *   POST /api/pipelines/:id/rollback        {actor?} → rollback latest deployment
 *   GET  /api/deployments                   list deployments (in-memory)
 *
 * Deploy evidence: on success the route attaches `deployment` and `smoke_test`
 * evidence to the task (§42); every mutation writes an audit record (§70).
 * PROD deploys park at AWAITING_APPROVAL and mint a real approval ticket via
 * @ai-factory/approvals, so the Approvals panel is the human gate (§41 Mode A).
 *
 * The coordinator wires this in: handleCicdRoutes(req, res, url, ctx).
 * DURABILITY (Batch 19): deployments are durable now. Every deploy is
 * written through to `fdb.deployments` with its reconstructable spec
 * (environment, §77 snapshot, §41 approval descriptor + policy
 * snapshot, task binding, actor, secret REFERENCE names only — never
 * values); a restarted server REBUILDS a parked job from that spec
 * (marked REHYDRATED in audit) instead of 404ing it, re-validating
 * the archive guard and rollback capability first. Rebuild failures
 * return 410 DEPLOYMENT_UNRECOVERABLE with the reason — never silent.
 * Pipeline RECORDS and STAGE definitions are still process memory:
 * GET /api/pipelines/:id on a rebuilt pipeline returns an honest
 * REHYDRATED stub, and /run on it is refused (its stages were never
 * persisted). Stage handlers, deployFn and smokeFn are still
 * simulated — this batch persists the spec, not host closures.
 *
 * Archived-project write guard (Batch 15, shared decision in
 * routes/project-guard.ts): every POST here binds to a task — at
 * creation, via the pipeline record, or via the deploy's approval
 * ticket — and hangs evidence or deployment facts on it, so all five
 * refuse with 409 PROJECT_ARCHIVED while the task's project is
 * archived, before any side effect:
 *   POST /api/pipelines            (when taskId is given)
 *   POST /api/pipelines/:id/run    (record.taskId)
 *   POST /api/pipelines/:id/deploy (body taskId ?? record.taskId)
 *   POST /api/pipelines/:id/approve (record.taskId, else the approval
 *                                   ticket's task_id — the ticket is
 *                                   fetched before any resume happens)
 *   POST /api/pipelines/:id/rollback (record.taskId)
 * A pipeline with no resolvable task cannot be tied to a project and
 * stays unguarded, exactly like unknown tasks in project-guard.ts.
 * GETs are reads and stay open. Like qa.ts, this module imports
 * project-guard directly (it is only loaded through the compiled
 * server, never straight from src by tests).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DeploymentService,
  DeploymentUnrecoverableError,
  ENVIRONMENTS,
  PipelineRunner,
  SnapshotStore,
  getEnvironment,
  rollback,
  type Deployment,
  type DeploymentJobRegistry,
  type DeploymentRehydrationSpec,
  type EnvironmentName,
  type Pipeline,
  type PipelineStatus,
} from '@ai-factory/cicd';
import type { DeploymentSpec, PersistedDeployment } from '@ai-factory/db';
import type { ApprovalLevel } from '@ai-factory/approvals';
import { nowIso } from '@ai-factory/core';
import { ApprovalManager } from '@ai-factory/approvals';
import type { EvidenceType } from '@ai-factory/core';
import type { RouteContext } from './context';
import {
  isTaskProjectArchived,
  projectArchivedBody,
  projectIdOfTask,
} from './project-guard';

/** The uniform archived-project refusal for a task-bound pipeline write. */
function archivedRefusal(
  ctx: RouteContext,
  res: ServerResponse,
  taskId: string,
): boolean {
  if (!isTaskProjectArchived(ctx.fdb, taskId)) return false;
  ctx.json(
    res,
    409,
    projectArchivedBody(projectIdOfTask(ctx.fdb, taskId) as string),
  );
  return true;
}

const PREFIX = '/api/pipelines';

interface PipelineRecord {
  pipeline: Pipeline;
  taskId: string | null;
  deployments: Deployment[];
  /**
   * Batch 19 — true when this record was reconstructed from the
   * persisted deployment rows after a restart (its stages were never
   * persisted, so stage execution is refused with 409).
   */
  rehydrated: boolean;
}

/**
 * Batch 19 — project the persisted row to the Deployment shape for
 * list surfaces. The reconstructable spec is NOT returned by list
 * reads (it is available at approve/rebuild time through the store);
 * rehydratedAt is surfaced so readers can tell a rebuilt deployment
 * apart from an in-process one.
 */
function persistedToDeployment(r: PersistedDeployment): Deployment & { rehydratedAt: string | null } {
  return {
    id: r.id,
    pipelineId: r.pipelineId,
    environment: r.environment as EnvironmentName,
    status: r.status,
    snapshotId: r.spec.snapshot.id,
    approvalId: r.approvalId,
    startedAt: null,
    endedAt: r.endedAt,
    ...(r.error ? { error: r.error } : {}),
    rehydratedAt: r.rehydratedAt,
  };
}

const pipelines = new Map<string, PipelineRecord>();
const deployments = new Map<string, { pipelineId: string; deployment: Deployment }>();
const snapshotStore = new SnapshotStore();

/**
 * Parked deployment jobs, shared by every DeploymentService this module
 * constructs (Batch 16 fix). Handlers build a fresh service per request,
 * but a job parked by POST /deploy must still be there when POST
 * /approve — a different request, a different service instance — calls
 * resume(): with a per-instance registry the approve always threw
 * DeploymentNotFoundError and the deployment stayed AWAITING_APPROVAL
 * forever. The registry therefore lives at module level, alongside
 * `pipelines` / `deployments` / `snapshotStore`, and is injected into
 * each instance. It is in-memory like the rest of that state: a server
 * restart loses pipelines, deployments, snapshots and parked jobs
 * together, and an approve after a restart fails explicitly (404
 * pipeline not found above) instead of silently dropping the deploy.
 */
const deploymentJobs: DeploymentJobRegistry = new Map();

/**
 * Batch 19 — deployment persistence (spec §41/§77).
 *
 * Every deployment is written through to `fdb.deployments` at park
 * time and on every status transition. The persisted row carries the
 * RECONSTRUCTABLE spec (environment, §77 snapshot, §41 approval
 * descriptor + policy snapshot, task binding, actor, secret REFERENCE
 * names only) — enough to REBUILD a parked job after a restart.
 * A write-through failure never rolls back the deploy; it writes
 * DEPLOYMENT_PERSIST_FAILED (same seam contract as the outbox sink).
 */
function persistDeployment(
  ctx: RouteContext,
  deployment: Deployment,
  spec: DeploymentRehydrationSpec | null,
  taskId: string | null,
): void {
  try {
    const existing = ctx.fdb.deployments.get(deployment.id);
    const stamp = nowIso();
    let specBody: DeploymentSpec;
    if (spec !== null) {
      const pd = spec.pendingApproval;
      specBody = {
        environment: spec.environmentName,
        rollbackMethod: spec.rollbackMethod,
        approvalDescriptor: {
          deploymentId: pd?.deploymentId ?? deployment.id,
          action: pd?.action ?? '',
          level: pd?.level ?? '',
          requiresApproval: pd?.requiresApproval ?? false,
          reason: pd?.reason ?? '',
        },
        policySnapshot: spec.policySnapshot,
        preDeployState: spec.preDeployState,
        snapshot: spec.snapshot,
        taskId: spec.taskId,
        actor: spec.actor,
        secretRefs: spec.secretRefs,
      };
    } else if (existing) {
      specBody = existing.spec;
    } else {
      specBody = {
        environment: deployment.environment,
        rollbackMethod: null,
        approvalDescriptor: {
          deploymentId: deployment.id,
          action: '',
          level: '',
          requiresApproval: false,
          reason: '',
        },
        policySnapshot: null,
        preDeployState: null,
        snapshot: {
          id: deployment.snapshotId ?? '',
          label: '',
          data: null,
          createdAt: stamp,
        },
        taskId,
        actor: null,
        secretRefs: [],
      };
    }
    const row: PersistedDeployment = {
      id: deployment.id,
      pipelineId: deployment.pipelineId,
      taskId: taskId ?? existing?.taskId ?? null,
      projectId: taskId
        ? ((projectIdOfTask(ctx.fdb, taskId) as string | null) ?? null)
        : (existing?.projectId ?? null),
      environment: deployment.environment,
      status: deployment.status,
      spec: specBody,
      approvalId: deployment.approvalId,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      endedAt: deployment.endedAt,
      error: deployment.error ?? null,
      rehydratedAt: existing?.rehydratedAt ?? null,
    };
    ctx.fdb.deployments.save(row);
  } catch (e) {
    ctx.audit.record('system', 'DEPLOYMENT_PERSIST_FAILED', 'deployment', deployment.id, {
      pipelineId: deployment.pipelineId,
      message: (e as Error).message,
    });
  }
}

type RehydrateResult =
  | { kind: 'record'; record: PipelineRecord }
  | { kind: 'archived'; projectId: string; taskId: string }
  | { kind: 'unrecoverable'; reason: string };

/**
 * Batch 19 — rebuild a pipeline record from persisted deployment
 * rows after a restart. Only parked (AWAITING_APPROVAL) rows yield
 * live jobs; finished rows are re-attached as read-only history.
 * The archive guard is re-validated BEFORE any job is rebuilt —
 * a project archived while the server was down refuses the rebuild
 * with 409 PROJECT_ARCHIVED, never silently.
 */
function rehydratePipelineRecord(ctx: RouteContext, id: string): RehydrateResult | null {
  const rows = ctx.fdb.deployments.byPipeline(id);
  if (rows.length === 0) return null;
  const taskId = rows.find((r) => r.status === 'AWAITING_APPROVAL')?.taskId
    ?? rows[0].taskId ?? null;
  if (taskId && isTaskProjectArchived(ctx.fdb, taskId)) {
    const projectId = (projectIdOfTask(ctx.fdb, taskId) as string | null) ?? '';
    ctx.audit.record('system', 'DEPLOYMENT_REBUILD_REFUSED', 'pipeline', id, {
      taskId,
      projectId,
      reason: 'project archived while the server was down',
    });
    return { kind: 'archived', projectId, taskId };
  }

  const record: PipelineRecord = {
    pipeline: {
      id,
      commitSha: 'REHYDRATED',
      environment: rows[0].environment as EnvironmentName,
      stages: [],
      status: 'REHYDRATED' as PipelineStatus,
      createdAt: rows[0].createdAt,
      updatedAt: nowIso(),
    },
    taskId,
    deployments: [],
    rehydrated: true,
  };
  let rebuilt = 0;
  let unrecoverable = 0;
  for (const row of rows) {
    if (row.status !== 'AWAITING_APPROVAL') {
      record.deployments.push(persistedToDeployment(row) as Deployment);
      continue;
    }
    const service = new DeploymentService({
      jobs: deploymentJobs,
      evidence: (type, payload) => {
        if (!row.taskId) return;
        const evidenceType = toEvidenceType(type);
        if (!evidenceType) return;
        ctx.evidence.create({
          taskId: row.taskId,
          type: evidenceType,
          title: `Deploy → ${row.environment} — ${type} (rehydrated)`,
          payload,
          createdBy: row.spec.actor ?? 'system',
        });
      },
      audit: (action, details) =>
        ctx.audit.record(
          row.spec.actor ?? 'system',
          action,
          'deployment',
          String(details['deploymentId'] ?? row.id),
          details,
        ),
    });
    try {
      // Map the persisted (flat, serializable) spec back to the
      // cicd-side rehydration shape: the DB row owns deployment
      // identity/status, the spec owns the rebuildable context.
      const s = row.spec;
      const cicdSpec: DeploymentRehydrationSpec = {
        deployment: {
          id: row.id,
          pipelineId: row.pipelineId,
          environment: row.environment as EnvironmentName,
          status: row.status,
          snapshotId: s.snapshot.id,
          approvalId: row.approvalId,
          startedAt: null,
          endedAt: row.endedAt,
          ...(row.error ? { error: row.error } : {}),
        },
        environmentName: s.environment as EnvironmentName,
        rollbackMethod: s.rollbackMethod ?? '',
        snapshot: {
          id: s.snapshot.id,
          label: s.snapshot.label,
          data: s.snapshot.data,
          environment: s.environment as EnvironmentName,
          createdAt: s.snapshot.createdAt,
        },
        pendingApproval: s.approvalDescriptor.requiresApproval
          ? {
              deploymentId: row.id,
              environment: s.environment as EnvironmentName,
              action: s.approvalDescriptor.action,
              level: s.approvalDescriptor.level as ApprovalLevel,
              requiresApproval: true,
              reason: s.approvalDescriptor.reason,
              evaluation: s.policySnapshot as never,
            }
          : null,
        policySnapshot: s.policySnapshot,
        preDeployState: s.preDeployState,
        taskId: s.taskId,
        actor: s.actor,
        secretRefs: s.secretRefs,
      };
      const job = service.rehydrate(cicdSpec);
      snapshotStore.restore(job.snapshot);
      record.deployments.push(job.deployment);
      deployments.set(job.deployment.id, { pipelineId: id, deployment: job.deployment });
      ctx.fdb.deployments.markRehydrated(row.id, nowIso());
      rebuilt += 1;
    } catch (e) {
      unrecoverable += 1;
      ctx.audit.record('system', 'DEPLOYMENT_REBUILD_FAILED', 'deployment', row.id, {
        pipelineId: id,
        message: (e as Error).message,
        name: (e as Error).name,
      });
    }
  }
  if (rebuilt === 0 && record.deployments.length === 0) {
    return { kind: 'unrecoverable', reason: `${unrecoverable} parked deployment(s) failed rebuild` };
  }
  pipelines.set(id, record);
  return { kind: 'record', record };
}

/**
 * Read-only snapshot of all deployments for cross-module aggregation
 * (e.g. GET /api/stats). Returns cloned records.
 */
export function listDeployments(): Deployment[] {
  return [...deployments.values()].map((d) => ({ ...d.deployment }));
}

const ENV_NAMES: EnvironmentName[] = ['LOCAL', 'DEV', 'UAT', 'PROD'];

function isEnv(v: unknown): v is EnvironmentName {
  return typeof v === 'string' && (ENV_NAMES as string[]).includes(v);
}

/**
 * Map cicd-internal evidence kinds to core EvidenceType (§42). Internal
 * bookkeeping kinds (snapshots, approval requests) are not task evidence.
 */
function toEvidenceType(t: string): EvidenceType | null {
  if (t === 'deployment') return 'deployment';
  if (t === 'stage-artifact') return 'ci_result';
  if (t === 'smoke_test') return 'smoke_test';
  return null;
}

function approvalManager(ctx: RouteContext): ApprovalManager {
  return new ApprovalManager(ctx.fdb.approvals, {
    audit: (action, entityId, details) =>
      ctx.audit.record('cicd-service', action, 'approval', entityId, details),
  });
}

function serializePipeline(r: PipelineRecord) {
  return { ...r.pipeline, taskId: r.taskId, deployments: r.deployments, rehydrated: r.rehydrated };
}

export async function handleCicdRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;

  // GET /api/environments
  if (method === 'GET' && path === '/api/environments') {
    return ctx.json(res, 200, {
      environments: ENV_NAMES.map((n) => ({ ...ENVIRONMENTS[n] })),
    }), true;
  }

  // GET /api/deployments — live records first, persisted rows
  // (Batch 19) fill in what a restart took out of memory. Live
  // records win on id clashes; the persisted projection never leaks
  // the rebuild spec (secret refs stay out of list reads).
  if (method === 'GET' && path === '/api/deployments') {
    const live = [...deployments.values()].map((d) => d.deployment);
    const seen = new Set(live.map((d) => d.id));
    const persisted = ctx.fdb.deployments
      .list()
      .filter((r) => !seen.has(r.id))
      .map(persistedToDeployment);
    return ctx.json(res, 200, [...live, ...persisted]), true;
  }

  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // POST /api/pipelines
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req);
    const environment = body['environment'];
    const env: EnvironmentName = isEnv(environment) ? environment : 'DEV';
    const commitSha = typeof body['commitSha'] === 'string' ? body['commitSha'] : 'HEAD';
    const taskId = typeof body['taskId'] === 'string' ? body['taskId'] : null;
    // Batch 15 — a pipeline created for a task is a task-scoped
    // record: refused while the task's project is archived, before
    // the record exists. No taskId → no project → unguarded.
    if (taskId && archivedRefusal(ctx, res, taskId)) return true;
    const runner = new PipelineRunner();
    const pipeline = runner.createPipeline(env, commitSha);
    pipelines.set(pipeline.id, { pipeline, taskId, deployments: [], rehydrated: false });
    ctx.audit.record('human', 'PIPELINE_CREATED', 'pipeline', pipeline.id, {
      environment: env,
      commitSha,
      taskId,
    });
    return ctx.json(res, 201, serializePipeline(pipelines.get(pipeline.id)!)), true;
  }

  // GET /api/pipelines
  if (method === 'GET' && path === PREFIX) {
    return ctx.json(
      res,
      200,
      [...pipelines.values()].map(serializePipeline),
    ), true;
  }

  const idMatch = path.match(/^\/api\/pipelines\/([^/]+)(\/.*)?$/);
  if (!idMatch) return false;
  const id = idMatch[1];
  const rest = idMatch[2] ?? '';
  // Batch 19 — the pipeline record is process memory, but its
  // deployments are durable now: a missing record is rebuilt from
  // the persisted rows before we declare it gone. A pipeline with no
  // persisted deployments at all still 404s exactly as before.
  let record = pipelines.get(id);
  if (!record) {
    const re = rehydratePipelineRecord(ctx, id);
    if (!re) {
      return ctx.json(res, 404, { error: `pipeline ${id} not found` }), true;
    }
    if (re.kind === 'archived') {
      return ctx.json(res, 409, projectArchivedBody(re.projectId)), true;
    }
    if (re.kind === 'unrecoverable') {
      return ctx.json(
        res,
        410,
        { error: re.reason, name: 'DeploymentUnrecoverableError' },
      ), true;
    }
    record = re.record;
  }

  // GET /api/pipelines/:id
  if (method === 'GET' && rest === '') {
    return ctx.json(res, 200, serializePipeline(record)), true;
  }

  // POST /api/pipelines/:id/run
  if (method === 'POST' && rest === '/run') {
    const body = await ctx.readBody(req);
    const actor = typeof body['actor'] === 'string' ? body['actor'] : 'human';
    // Batch 19 — a rehydrated stub has no stages (stages were never
    // persisted): running it would "succeed" on an empty stage list,
    // so it is refused explicitly instead of faking a run.
    if (record.rehydrated) {
      return ctx.json(
        res,
        409,
        {
          error: `pipeline ${id} was rebuilt from persisted deployments after a restart; stage definitions were not persisted and cannot be re-run`,
          name: 'PIPELINE_NOT_REHYDRATABLE',
        },
      ), true;
    }
    // Batch 15 — a run hangs stage evidence on the pipeline's task:
    // refused while archived, before any stage executes.
    if (record.taskId && archivedRefusal(ctx, res, record.taskId)) return true;
    const runner = new PipelineRunner({
      evidence: (type, payload) => {
        if (!record.taskId) return;
        const evidenceType = toEvidenceType(type);
        if (!evidenceType) return;
        ctx.evidence.create({
          taskId: record.taskId,
          type: evidenceType,
          title: `Pipeline ${record.pipeline.id.slice(0, 8)} — ${type}`,
          payload,
          createdBy: actor,
        });
      },
      audit: (action, details) =>
        ctx.audit.record(actor, action, 'pipeline', record.pipeline.id, details),
    });
    try {
      const pipeline = await runner.run(record.pipeline);
      record.pipeline = pipeline;
      // §91 — CI pipeline completion on the bus.
      ctx.bus.emit(
        'CI_COMPLETED',
        { pipelineId: record.pipeline.id, status: pipeline.status, actor },
        'cicd',
      );
      return ctx.json(res, 200, serializePipeline(record)), true;
    } catch (e) {
      return ctx.json(res, 409, { error: (e as Error).message }), true;
    }
  }

  // POST /api/pipelines/:id/deploy
  if (method === 'POST' && rest === '/deploy') {
    const body = await ctx.readBody(req);
    const actor = typeof body['actor'] === 'string' ? body['actor'] : 'human';
    const taskId = typeof body['taskId'] === 'string' ? body['taskId'] : record.taskId;
    if (!isEnv(body['environment'])) {
      return ctx.json(res, 400, { error: 'environment must be LOCAL|DEV|UAT|PROD' }), true;
    }
    if (!taskId) {
      return ctx.json(res, 400, { error: 'taskId is required (deployments attach evidence + approvals to a task)' }), true;
    }
    // Batch 15 — a deploy hangs deployment/smoke evidence (and, when
    // parked, an approval ticket) on the task: refused while its
    // project is archived, before the deployment starts.
    if (archivedRefusal(ctx, res, taskId)) return true;
    const env = getEnvironment(body['environment']);
    const service = new DeploymentService({
      jobs: deploymentJobs,
      evidence: (type, payload) => {
        const evidenceType = toEvidenceType(type);
        if (!evidenceType) return;
        ctx.evidence.create({
          taskId,
          type: evidenceType,
          title: `Deploy → ${env.name} — ${type}`,
          payload,
          createdBy: actor,
        });
      },
      audit: (action, details) =>
        ctx.audit.record(actor, action, 'deployment', String(details['deploymentId'] ?? ''), details),
    });
    try {
      // §91 — deployment lifecycle on the bus.
      ctx.bus.emit(
        'DEPLOYMENT_STARTED',
        { pipelineId: record.pipeline.id, environment: env.name, taskId, actor },
        'cicd',
      );
      const outcome = await service.deploy({
        pipelineId: record.pipeline.id,
        environment: env,
        store: snapshotStore,
        preDeployState: { version: `pipeline-${record.pipeline.id.slice(0, 8)}` },
        taskId: taskId ?? undefined,
        actor,
      });
      // Batch 19 — write the deployment (and its reconstructable
      // spec) through to the durable store, parked or not.
      try {
        persistDeployment(ctx, outcome.deployment, service.specOf(outcome.deployment.id), taskId);
      } catch {
        // persistDeployment already audits its own failure.
      }
      ctx.bus.emit(
        'DEPLOYMENT_COMPLETED',
        {
          deploymentId: outcome.deployment.id,
          environment: env.name,
          status: outcome.deployment.status,
          pendingApproval: outcome.pendingApproval != null,
          taskId,
        },
        'cicd',
      );
      record.deployments.push(outcome.deployment);
      deployments.set(outcome.deployment.id, {
        pipelineId: record.pipeline.id,
        deployment: outcome.deployment,
      });
      // Notification trigger (module 30): successful deployment → INFO.
      if (outcome.deployment.status === 'SUCCEEDED') {
        ctx.notify.emit({
          type: 'DEPLOYMENT_COMPLETED',
          actor,
          entity: { kind: 'deployment', id: outcome.deployment.id, label: outcome.deployment.id },
          detail: { environment: env.name, taskId },
        });
      }
      // Parked on approval → mint a real approval ticket so the Approvals
      // panel becomes the human gate (spec §41 Mode A).
      let approval: unknown = null;
      if (outcome.pendingApproval) {
        const manager = approvalManager(ctx);
        approval = manager.request({
          action: outcome.pendingApproval.action,
          requester: actor,
          task_id: taskId,
          risk_level: 'HIGH',
        });
      }
      return ctx.json(res, 200, {
        deployment: outcome.deployment,
        pendingApproval: outcome.pendingApproval,
        approval,
      }), true;
    } catch (e) {
      const err = e as Error;
      const status = err.name === 'RollbackCapabilityError' ? 422 : 409;
      return ctx.json(res, status, { error: err.message, name: err.name }), true;
    }
  }

  // POST /api/pipelines/:id/approve
  if (method === 'POST' && rest === '/approve') {
    const body = await ctx.readBody(req);
    const actor = typeof body['actor'] === 'string' ? body['actor'] : 'human';
    const approvalId = body['approvalId'];
    if (typeof approvalId !== 'string' || !approvalId) {
      return ctx.json(res, 400, { error: 'approvalId is required' }), true;
    }
    // Batch 15 — resuming a parked deploy completes a deployment
    // bound to a task: refused while that task's project is archived.
    // The binding is the pipeline record's task, or — for pipelines
    // created without one — the approval ticket's own task_id (the
    // ticket is fetched read-only below, before any resume).
    if (record.taskId && archivedRefusal(ctx, res, record.taskId)) return true;
    const parked = record.deployments.find((d) => d.status === 'AWAITING_APPROVAL');
    if (!parked) {
      return ctx.json(res, 409, { error: 'no deployment awaiting approval for this pipeline' }), true;
    }
    const manager = approvalManager(ctx);
    const approval = manager.get(approvalId);
    if (!approval) {
      return ctx.json(res, 404, { error: `approval ${approvalId} not found` }), true;
    }
    if (
      approval.task_id &&
      approval.task_id !== record.taskId &&
      archivedRefusal(ctx, res, approval.task_id)
    ) {
      return true;
    }
    if (approval.status !== 'APPROVED') {
      return ctx.json(res, 409, { error: `approval is ${approval.status}, not APPROVED` }), true;
    }
    const service = new DeploymentService({
      jobs: deploymentJobs,
      audit: (action, details) =>
        ctx.audit.record(actor, action, 'deployment', parked.id, details),
    });
    try {
      const outcome = await service.resume(parked.id, { approvalId });
      Object.assign(parked, outcome.deployment);
      // Batch 19 — the completed deployment is written back over its
      // parked row; the spec is preserved as the park-time record.
      try {
        persistDeployment(ctx, parked, null, record.taskId);
      } catch {
        // persistDeployment already audits its own failure.
      }
      return ctx.json(res, 200, { deployment: parked }), true;
    } catch (e) {
      const err = e as Error;
      if (err.name === 'DeploymentUnrecoverableError') {
        return ctx.json(res, 410, { error: err.message, name: err.name }), true;
      }
      return ctx.json(res, 409, { error: err.message }), true;
    }
  }

  // POST /api/pipelines/:id/rollback
  if (method === 'POST' && rest === '/rollback') {
    const body = await ctx.readBody(req);
    const actor = typeof body['actor'] === 'string' ? body['actor'] : 'human';
    // Batch 15 — a rollback rewrites the deployment state of the
    // pipeline's task: refused while its project is archived, before
    // any snapshot is restored.
    if (record.taskId && archivedRefusal(ctx, res, record.taskId)) return true;
    const latest = [...record.deployments].reverse().find((d) => d.snapshotId);
    if (!latest || !latest.snapshotId) {
      return ctx.json(res, 409, { error: 'no deployment with a snapshot to roll back' }), true;
    }
    try {
      // §91 — rollback lifecycle on the bus.
      ctx.bus.emit(
        'ROLLBACK_STARTED',
        { deploymentId: latest.id, pipelineId: record.pipeline.id, actor },
        'cicd',
      );
      const restored = rollback(snapshotStore, latest.snapshotId);
      latest.status = 'ROLLED_BACK';
      ctx.bus.emit(
        'ROLLBACK_COMPLETED',
        { deploymentId: latest.id, pipelineId: record.pipeline.id, restored: restored != null },
        'cicd',
      );
      ctx.audit.record(actor, 'DEPLOYMENT_ROLLBACK', 'deployment', latest.id, {
        pipelineId: record.pipeline.id,
        snapshotId: latest.snapshotId,
        restored,
      });
      return ctx.json(res, 200, { deployment: latest, restored }), true;
    } catch (e) {
      return ctx.json(res, 409, { error: (e as Error).message }), true;
    }
  }

  return false;
}

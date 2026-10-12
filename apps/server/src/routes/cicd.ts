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
 * PROTOTYPE NOTE: pipelines/deployments/snapshots are in-memory (lost on
 * restart); stage handlers, deployFn and smokeFn are simulated. Real projects
 * would inject their own handlers into PipelineRunner/DeploymentService.
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
  ENVIRONMENTS,
  PipelineRunner,
  SnapshotStore,
  getEnvironment,
  rollback,
  type Deployment,
  type EnvironmentName,
  type Pipeline,
} from '@ai-factory/cicd';
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
}

const pipelines = new Map<string, PipelineRecord>();
const deployments = new Map<string, { pipelineId: string; deployment: Deployment }>();
const snapshotStore = new SnapshotStore();

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
  return { ...r.pipeline, taskId: r.taskId, deployments: r.deployments };
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

  // GET /api/deployments
  if (method === 'GET' && path === '/api/deployments') {
    return ctx.json(
      res,
      200,
      [...deployments.values()].map((d) => d.deployment),
    ), true;
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
    pipelines.set(pipeline.id, { pipeline, taskId, deployments: [] });
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
  const record = pipelines.get(id);
  if (!record) {
    return ctx.json(res, 404, { error: `pipeline ${id} not found` }), true;
  }

  // GET /api/pipelines/:id
  if (method === 'GET' && rest === '') {
    return ctx.json(res, 200, serializePipeline(record)), true;
  }

  // POST /api/pipelines/:id/run
  if (method === 'POST' && rest === '/run') {
    const body = await ctx.readBody(req);
    const actor = typeof body['actor'] === 'string' ? body['actor'] : 'human';
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
      });
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
      audit: (action, details) =>
        ctx.audit.record(actor, action, 'deployment', parked.id, details),
    });
    try {
      const outcome = await service.resume(parked.id, { approvalId });
      Object.assign(parked, outcome.deployment);
      return ctx.json(res, 200, { deployment: parked }), true;
    } catch (e) {
      return ctx.json(res, 409, { error: (e as Error).message }), true;
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

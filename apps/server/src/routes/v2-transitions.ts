/**
 * v2 workflow wiring — SPEC_V2 §18.2 (gap G-18).
 *
 * Until now WorkflowEngineV2 (packages/core/src/engine-v2.ts) was dead code
 * outside the core package: the Board and the HTTP API only ever called the
 * v1 engine. This module wires the v2 engine into the server for real:
 *
 *   POST /api/tasks/:id/v2-transition  { toState|to, by|actor, ...gate inputs }
 *   GET  /api/tasks/:id/v2-state
 *
 * Design (deliberately narrow, no fake wiring):
 * - The service holds ONE WorkflowEngineV2 instance and keeps an in-memory
 *   mirror of each task's v2 state, keyed by taskId.
 * - SEEDING: on first v2 access for a task, the mirror is registered with
 *   the stage mapped from the task's current DB (v1) status — the DB stays
 *   the durable source of truth. v1 exception statuses (BLOCKED, QA_FAILED,
 *   …) have no v2 stage; they seed an approximate stage plus the matching
 *   v2 condition, because v1 never recorded the stage separately (that is
 *   exactly the §18 flaw v2 fixes). After the first successful v2
 *   transition the mirror and the DB status move together via write-back.
 * - WRITE-BACK: a successful v2 transition writes the resulting stage back
 *   to the DB via TaskManager.setStatus (the same engine-only write the v1
 *   engine uses). v2's OUTCOME_VERIFICATION has no v1 status; it writes
 *   back as PROD_VERIFICATION and the exact stage is only visible via
 *   GET /v2-state (documented in docs/KNOWN_LIMITATIONS.md).
 * - GATES: the GateContext is assembled from real server-side facts where
 *   they exist (evidence rows from the DB, dependency readiness computed
 *   from DB task statuses, implementer = current agent) and from explicit
 *   caller attestations where the server has no service to verify them
 *   yet (budgetOk / quotaOk / confinementOk default FALSE — fail-closed:
 *   an unattested gate input denies the transition, it never waves it
 *   through). Authorization is a caller-supplied snapshot, the same trust
 *   model as the rest of this local API (no auth layer exists yet).
 * - DENIALS: a v2 gate denial returns 422 with the engine's reasonCode and
 *   missing list, and the DB row is NOT touched.
 *
 * The v1 endpoint POST /api/tasks/:id/transition is unchanged, and the
 * desktop Board still uses it — see docs/KNOWN_LIMITATIONS.md for why the
 * Board was not switched in this batch.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  AuditLog,
  EvidenceEngine,
  TaskManager,
  WorkflowEngineV2,
  WORKFLOW_STAGES,
} from '@ai-factory/core';
import type {
  ActorAuthorization,
  GateContext,
  Task,
  TaskConditionValue,
  TaskStatus,
  TaskV2State,
  WorkflowStage,
} from '@ai-factory/core';
import type { RouteContext } from './context';

/** v1 happy-path statuses map 1:1 onto v2 stages. */
const STAGE_BY_STATUS: Partial<Record<TaskStatus, WorkflowStage>> = {
  TODO: 'TODO',
  PLANNING: 'PLANNING',
  IN_PROGRESS: 'IN_PROGRESS',
  CODE_REVIEW: 'CODE_REVIEW',
  PENDING_QA: 'PENDING_QA',
  QA: 'QA',
  PENDING_UAT_MERGE: 'PENDING_UAT_MERGE',
  UAT: 'UAT',
  PENDING_PROD: 'PENDING_PROD',
  PROD_DEPLOYING: 'PROD_DEPLOYING',
  PROD_VERIFICATION: 'PROD_VERIFICATION',
  DONE: 'DONE',
  // v1 exception statuses: best-effort stage approximation for first seed.
  BLOCKED: 'TODO',
  ESCALATED: 'TODO',
  CANCELLED: 'TODO',
  REJECTED: 'TODO',
  QA_FAILED: 'QA',
  UAT_FAILED: 'UAT',
  PROD_FAILED: 'PROD_VERIFICATION',
  ROLLBACK: 'PROD_VERIFICATION',
};

/** v1 exception statuses seed the orthogonal v2 condition (§18.3). */
const CONDITION_BY_STATUS: Partial<Record<TaskStatus, TaskConditionValue>> = {
  BLOCKED: 'BLOCKED',
  ESCALATED: 'ESCALATED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  QA_FAILED: 'FAILED',
  UAT_FAILED: 'FAILED',
  PROD_FAILED: 'FAILED',
  ROLLBACK: 'FAILED',
};

/** Write-back map: v2 stage → v1 DB status (OUTCOME_VERIFICATION is lossy). */
export const DB_STATUS_BY_STAGE: Record<WorkflowStage, TaskStatus> = {
  TODO: 'TODO',
  PLANNING: 'PLANNING',
  IN_PROGRESS: 'IN_PROGRESS',
  CODE_REVIEW: 'CODE_REVIEW',
  PENDING_QA: 'PENDING_QA',
  QA: 'QA',
  PENDING_UAT_MERGE: 'PENDING_UAT_MERGE',
  UAT: 'UAT',
  PENDING_PROD: 'PENDING_PROD',
  PROD_DEPLOYING: 'PROD_DEPLOYING',
  PROD_VERIFICATION: 'PROD_VERIFICATION',
  // v1 has no OUTCOME_VERIFICATION status; the DB row stays at
  // PROD_VERIFICATION and the exact v2 stage lives in the engine mirror.
  OUTCOME_VERIFICATION: 'PROD_VERIFICATION',
  DONE: 'DONE',
};

export interface V2TransitionDeps {
  tasks: TaskManager;
  evidence: EvidenceEngine;
  audit: AuditLog;
}

export interface V2StateView {
  taskId: string;
  /** §18.1 execution axis: the workflow stage. */
  stage: WorkflowStage;
  /** §18.3 independent condition record. */
  condition: TaskV2State['condition'];
  /** §19 lifecycle milestones (verification/business axis). */
  milestones: TaskV2State['milestones'];
  releaseState: TaskV2State['releaseState'];
  finalSeal: 0 | 1;
  taskVersion: number;
  requirementRef: string | null;
  completionTarget: TaskV2State['completionTarget'];
  /** The DB (v1) status, for cross-checking the mirror against the row. */
  dbStatus: TaskStatus;
  updatedAt: string;
}

export class V2TransitionService {
  readonly engine: WorkflowEngineV2;
  private deps: V2TransitionDeps;

  constructor(deps: V2TransitionDeps) {
    this.deps = deps;
    this.engine = new WorkflowEngineV2({ audit: deps.audit });
  }

  /**
   * Ensure the engine mirror exists for this task, seeding from the DB row
   * on first access. Returns the DB task (throws TaskNotFoundError via
   * TaskManager.get when the task does not exist).
   */
  ensureSeeded(taskId: string, requirementRef?: string | null): Task {
    const task = this.deps.tasks.get(taskId);
    try {
      this.engine.get(taskId);
      return task;
    } catch {
      // Not mirrored yet — seed below.
    }
    const stage =
      task.v2?.workflowStage ?? STAGE_BY_STATUS[task.status] ?? 'TODO';
    this.engine.register(taskId, {
      stage,
      requirementRef: requirementRef ?? undefined,
    });
    const condition = CONDITION_BY_STATUS[task.status];
    if (condition) {
      this.engine.setCondition(
        taskId,
        condition,
        `seeded from v1 status ${task.status} (v1 did not record the v2 stage separately)`,
        'system',
        { resumeState: null },
      );
    }
    return task;
  }

  /** Three-state view of a task (§18 stage + §18.3 condition + §19 milestones). */
  stateView(taskId: string): V2StateView {
    const task = this.ensureSeeded(taskId);
    const s = this.engine.get(taskId);
    return {
      taskId,
      stage: s.stage,
      condition: s.condition,
      milestones: s.milestones,
      releaseState: s.releaseState,
      finalSeal: s.finalSeal,
      taskVersion: s.taskVersion,
      requirementRef: s.requirementRef,
      completionTarget: s.completionTarget,
      dbStatus: task.status,
      updatedAt: s.updatedAt,
    };
  }

  /** Assemble the GateContext from DB facts + explicit caller attestations. */
  private gateContext(
    task: Task,
    actor: string,
    body: Record<string, unknown>,
  ): GateContext & { idempotencyKey?: string } {
    const authStatus = body['authorizationStatus'];
    const authorization: ActorAuthorization = {
      status:
        authStatus === 'WAITING_HUMAN_DISPATCH' ||
        authStatus === 'REVOKED' ||
        authStatus === 'EXPIRED'
          ? authStatus
          : 'AUTHORIZED',
      expiresAt:
        typeof body['authorizationExpiresAt'] === 'string'
          ? body['authorizationExpiresAt']
          : null,
    };
    // Dependency readiness is a real server-side fact: every hard
    // dependency (depends_on / blocked_by) must point at a DONE task.
    const dependenciesReady = task.dependencies
      .filter((d) => d.kind === 'depends_on' || d.kind === 'blocked_by')
      .every((d) => {
        try {
          return this.deps.tasks.get(d.taskId).status === 'DONE';
        } catch {
          return false; // dangling dependency → not ready (fail-closed)
        }
      });
    return {
      taskId: task.id,
      taskVersion: this.engine.get(task.id).taskVersion,
      actor,
      actorRole:
        typeof body['actorRole'] === 'string' ? body['actorRole'] : undefined,
      authorization,
      // Fall back to the requirement pinned at seed time — the engine's
      // gate needs the effective pin, and a literal null here would fail
      // the requirement-pinned predicate even for a pinned task.
      requirementVersion:
        typeof body['requirementVersion'] === 'string'
          ? body['requirementVersion']
          : this.engine.get(task.id).requirementRef,
      candidateDigest:
        typeof body['candidateDigest'] === 'string'
          ? body['candidateDigest']
          : null,
      implementerId:
        typeof body['implementerId'] === 'string'
          ? body['implementerId']
          : task.currentAgentId,
      evidence: this.deps.evidence.listByTask(task.id),
      // The server does not yet track per-evidence requirement versions or
      // a staleness set; the engine treats absent entries as "not stale".
      evidenceReqVersions: {},
      staleEvidenceIds: [],
      // Fail-closed attestations: only an explicit `true` in the request
      // asserts these operational facts; the server cannot verify them yet.
      budgetOk: body['budgetOk'] === true,
      quotaOk: body['quotaOk'] === true,
      confinementOk: body['confinementOk'] === true,
      dependenciesReady,
      expectedTaskVersion:
        typeof body['expectedTaskVersion'] === 'number'
          ? body['expectedTaskVersion']
          : undefined,
      idempotencyKey:
        typeof body['idempotencyKey'] === 'string'
          ? body['idempotencyKey']
          : undefined,
    };
  }

  /**
   * Run one v2 transition. On success the result stage is written back to
   * the DB; on a gate denial nothing is written.
   */
  transition(
    taskId: string,
    to: WorkflowStage,
    actor: string,
    body: Record<string, unknown>,
  ):
    | { ok: true; from: WorkflowStage; to: WorkflowStage; intent: string; deduped?: boolean; state: V2StateView }
    | { ok: false; from: WorkflowStage; to: WorkflowStage; reasonCode: string; missing: string[] } {
    const task = this.ensureSeeded(
      taskId,
      typeof body['requirementVersion'] === 'string'
        ? body['requirementVersion']
        : null,
    );
    const check = this.engine.requestTransitionV2(
      taskId,
      to,
      actor,
      this.gateContext(task, actor, body),
    );
    if (!check.ok) {
      return {
        ok: false,
        from: check.from,
        to: check.to,
        reasonCode: check.reasonCode,
        missing: check.missing,
      };
    }
    // Write-back: persist the v2 result into the DB row (v1 status column).
    const dbStatus = DB_STATUS_BY_STAGE[check.to];
    const fresh = this.deps.tasks.get(taskId);
    if (fresh.status !== dbStatus) {
      this.deps.tasks.setStatus(taskId, dbStatus);
    }
    return {
      ok: true,
      from: check.from,
      to: check.to,
      intent: check.intent,
      deduped: check.deduped,
      state: this.stateView(taskId),
    };
  }
}

/** Process-wide singleton, lazily built from the first request context. */
let shared: V2TransitionService | null = null;
export function getV2TransitionService(ctx: RouteContext): V2TransitionService {
  if (!shared) {
    shared = new V2TransitionService({
      tasks: ctx.tasks,
      evidence: ctx.evidence,
      audit: ctx.audit,
    });
  }
  return shared;
}

/** Test seam: build an isolated service instead of the shared singleton. */
export function createV2TransitionService(deps: V2TransitionDeps): V2TransitionService {
  return new V2TransitionService(deps);
}

const TASK_V2_RE = /^\/api\/tasks\/([^/]+)\/(v2-transition|v2-state)$/;

export async function handleV2TransitionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const m = url.pathname.match(TASK_V2_RE);
  if (!m) return false;
  const taskId = decodeURIComponent(m[1]);
  const method = req.method ?? 'GET';
  const service = getV2TransitionService(ctx);

  if (method === 'GET' && m[2] === 'v2-state') {
    try {
      ctx.json(res, 200, service.stateView(taskId));
    } catch (e) {
      ctx.json(res, 404, { error: (e as Error).message });
    }
    return true;
  }

  if (method === 'POST' && m[2] === 'v2-transition') {
    const body = await ctx.readBody(req);
    const toRaw = body['toState'] ?? body['to'];
    if (typeof toRaw !== 'string' || !toRaw) {
      ctx.json(res, 400, { error: 'toState (target v2 stage) is required' });
      return true;
    }
    if (!(WORKFLOW_STAGES as ReadonlyArray<string>).includes(toRaw)) {
      ctx.json(res, 400, {
        error: `unknown v2 stage ${toRaw}; valid stages: ${WORKFLOW_STAGES.join(', ')}`,
      });
      return true;
    }
    const actor =
      (typeof body['by'] === 'string' && body['by']) ||
      (typeof body['actor'] === 'string' && body['actor']) ||
      'human';
    try {
      const r = service.transition(taskId, toRaw as WorkflowStage, actor, body);
      if (!r.ok) {
        // Gate denial: 422, DB untouched (the service only writes on ok).
        ctx.json(res, 422, r);
        return true;
      }
      ctx.bus.emit(
        'WORKFLOW_TRANSITIONED',
        { taskId, from: r.from, to: r.to, actor, engine: 'v2' },
        'workflow',
      );
      ctx.json(res, 200, r);
    } catch (e) {
      ctx.json(res, 404, { error: (e as Error).message });
    }
    return true;
  }

  return false;
}

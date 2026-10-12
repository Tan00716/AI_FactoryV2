/**
 * v2 workflow wiring — SPEC_V2 §18.2 (gap G-18).
 *
 * Until now WorkflowEngineV2 (packages/core/src/engine-v2.ts) was dead code
 * outside the core package: the Board and the HTTP API only ever called the
 * v1 engine. This module wires the v2 engine into the server for real:
 *
 *   POST /api/tasks/:id/v2-transition  { toState|to, by|actor, ...gate inputs }
 *   POST /api/tasks/:id/v2-complete    { by|actor, ...attestations }
 *   GET  /api/tasks/:id/v2-state
 *   GET  /api/tasks/:id/outbox         (pending §18.2 events, Batch 17)
 *
 * Design (deliberately narrow, no fake wiring):
 * - The service holds ONE WorkflowEngineV2 instance and keeps an in-memory
 *   mirror of each task's v2 state, keyed by taskId.
 * - SEEDING: on first v2 access for a task with NO persisted v2 state,
 *   the mirror is registered with the stage mapped from the task's
 *   current DB (v1) status. v1 exception statuses (BLOCKED, QA_FAILED,
 *   …) have no v2 stage; they seed an approximate stage plus the matching
 *   v2 condition, because v1 never recorded the stage separately (that is
 *   exactly the §18 flaw v2 fixes). After the first successful v2
 *   transition the mirror and the DB status move together via write-back.
 * - PERSISTENCE (§18/§19/§20.1, Batch 13): when a TaskV2StateStore is
 *   wired (FactoryDatabase.taskV2States), the mirror itself is durable.
 *   Every engine-committed mutation the service drives (seed,
 *   transition, milestone reconciliation, finalize) is followed by a
 *   verbatim snapshot put(); on first access a stored state is hydrated
 *   back into the engine and takes precedence over the approximate
 *   seed, so a restart restores the exact stage, condition, recorded
 *   milestones, histories, outcome-gate validity, taskVersion and the
 *   §20.1 final seal (the Batch 12 F1 residual: a re-seeded mirror used
 *   to report finalSeal 0 for a DONE task). What is NOT persisted: the
 *   engine's idempotency result cache and G-21 failure-event log —
 *   neither is part of TaskV2State; the audit log (already durable) is
 *   their record. The G-17 outbox queue is not TaskV2State either, but
 *   since Batch 17 it has its own durable store: when
 *   FactoryDatabase.outbox is wired, the engine appends every committed
 *   event to the §48.4 outbox_events table and restores the
 *   undispatched ones at construction (drain confirms via
 *   dispatched_at, never deletes), and GET /api/tasks/:id/outbox
 *   serves the pending queue. Hydration restores engine-
 *   produced state through the engine's getMutable() accessor: it
 *   replays no transition and bypasses no gate — every stored state was
 *   reached via the engine's own gated mutators in an earlier process.
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
 * - COMPATIBILITY (§16): GateContext.compatibleEvidenceIds is filled from
 *   the shared RequirementManager — the same instance that
 *   POST /api/requirements/:id/compatibility writes declarations to — for
 *   evidence the manager explicitly declares compatible with the task's
 *   pinned version (canReuseEvidence). Assembled from real declarations
 *   only, never inferred.
 * - EVIDENCE VERSIONS (§16/§18.2, Batch 8): GateContext.evidenceReqVersions
 *   is assembled from the version recorded on each evidence row at
 *   registration time (POST /api/tasks/:id/evidence accepts an explicit
 *   requirementId + requirementVersion, validated against the manager, and
 *   persists the pin ref 'REQ-001@1' on the row). The engine's
 *   version-mismatch STALE branch therefore fires over HTTP for real:
 *   evidence collected against REQ@1 blocks promotion once the task pins
 *   REQ@2, unless a §16 compatibility declaration exempts it. Evidence
 *   with no recorded version (registered without a requirement context,
 *   or predating Batch 8) is absent from the map and treated as not
 *   stale — no version is ever invented for it.
 * - COMPLETION (§20.1, Batch 12 — walkthrough finding F1): until now the
 *   v2 lifecycle dead-ended over HTTP one step before DONE — the engine
 *   requires finalize() for DONE and no route exposed it, so API users
 *   detoured through the v1 endpoint and lost the completion predicates,
 *   the final seal, and mirror/DB consistency. POST /v2-complete now
 *   assembles a CompletionSnapshot from server-side facts (see
 *   completionSnapshot() for the exact rule per field — nothing is
 *   waved through: a field the server cannot verify is either a real
 *   recorded fact or an explicit caller attestation in the established
 *   fail-closed style) and calls engine.finalize(). On success DONE +
 *   final_seal=1 commit in the engine and DONE is written back to the
 *   DB row, so the mirror and the row agree. POST /v2-transition to
 *   DONE still returns 422 by engine design — finalize is the only
 *   road to DONE, now reachable.
 * - EVIDENCE SEALING (§42, Batch 12 — walkthrough finding F3): the
 *   engine's onSealEvidence hook is wired to EvidenceEngine.seal, so
 *   the evidence a gate consumes becomes immutable the moment the
 *   transition commits. Denied transitions consume nothing and seal
 *   nothing. Predicate-checked evidence (e.g. the production approval,
 *   read by a gate predicate rather than consumed as a requirement) is
 *   NOT sealed — sealing tracks consumption, exactly §42's rule.
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
  CompletionSnapshot,
  Evidence,
  GateContext,
  LifecycleMilestone,
  OutboxEvent,
  OutboxSink,
  Task,
  TaskConditionValue,
  TaskStatus,
  TaskV2State,
  WorkflowStage,
} from '@ai-factory/core';
import type { RequirementManager } from '@ai-factory/requirements';
import type { RouteContext } from './context';
import { getRequirementManager } from './requirements';
import {
  isTaskProjectArchived,
  projectArchivedBody,
  projectIdOfTask,
} from './project-guard';

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
  /**
   * §16 compatibility declarations (optional). When present, gate
   * assembly fills GateContext.compatibleEvidenceIds from real
   * canReuseEvidence records for the task's pinned requirement version.
   * Absent = the field is omitted and behavior is unchanged. Also the
   * source of the pinned version's acceptance criteria for the §20.1
   * completion snapshot (getVersion).
   */
  requirements?: Pick<RequirementManager, 'canReuseEvidence' | 'getVersion'>;
  /**
   * Task approval records (optional, §20.1). When present, the
   * completion snapshot's authorizationsComplete additionally requires
   * that no approval for the task is still PENDING or lapsed EXPIRED.
   * Absent = the caller's authorization snapshot is the only
   * authorization fact, mirroring gateContext's trust model.
   */
  approvals?: {
    listByTask(taskId: string): ReadonlyArray<{ status: string }>;
  };
  /**
   * Durable v2 mirror store (optional, Batch 13). When present, the
   * engine's TaskV2State is persisted after every mutation the service
   * commits and hydrated from the store on first access, so a restart
   * restores the exact v2 state instead of the approximate v1-row seed.
   * Absent = the mirror is process-local (the pre-Batch-13 behavior).
   * Structural on purpose: the concrete store is db's
   * SqliteTaskV2StateStore, wired in getV2TransitionService behind the
   * same shape guard as approvals.
   */
  v2States?: {
    get(taskId: string): TaskV2State | undefined;
    put(state: TaskV2State): void;
  };
  /**
   * Durable outbox sink (optional, Batch 17). When present, it is handed
   * to the engine as its OutboxSink: every committed transition/finalize
   * appends its §18.2 event to the outbox_events table in the same
   * step, and the engine's pending queue is restored from the table at
   * construction — undispatched events survive restarts until drained.
   * Absent = the outbox stays process-local (the pre-Batch-17
   * behavior). The concrete store is db's SqliteOutboxStore, wired in
   * getV2TransitionService behind the same shape guard as v2States.
   */
  outbox?: OutboxSink;
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

/** Parse a requirement pin ref ('REQ-001@2') into id + version. */
function parsePin(pin: string): { id: string; version: number } | null {
  const at = pin.lastIndexOf('@');
  if (at <= 0) return null;
  const version = Number(pin.slice(at + 1));
  if (!Number.isInteger(version) || version < 1) return null;
  return { id: pin.slice(0, at), version };
}

/**
 * §20.1 AC verification, judged from recorded evidence only. An
 * acceptance criterion declares what evidence must exist in its own
 * `expectedEvidence` — the recorded shape is '<type> with verdict <V>'
 * (e.g. 'qa_result with verdict PASS'; see AcceptanceCriterion). The AC
 * counts verified iff a task evidence record of that type exists whose
 * payload verdict equals <V> (a bare '<type>' requires the type alone).
 * An expectedEvidence string in any other shape names no machine-
 * checkable evidence and the AC counts UNVERIFIED — fail-closed, never
 * inferred from prose.
 */
function acVerifiedByEvidence(
  ac: { expectedEvidence: string },
  evidence: Evidence[],
): boolean {
  const m = /^([A-Za-z0-9_]+)(?:\s+with\s+verdict\s+(\S+))?/i.exec(
    ac.expectedEvidence.trim(),
  );
  if (!m) return false;
  const type = m[1];
  const verdict = m[2];
  return evidence.some((e) => {
    if (e.type !== type) return false;
    if (verdict === undefined) return true;
    const v = (e.payload as { verdict?: unknown }).verdict;
    return typeof v === 'string' && v === verdict;
  });
}

/** §19 milestones each completion target requires (DONE excluded — finalize sets it). */
const MILESTONES_BY_TARGET: Record<
  TaskV2State['completionTarget'],
  LifecycleMilestone[]
> = {
  IMPLEMENTATION: ['IMPLEMENTED'],
  VERIFIED_DELIVERY: ['IMPLEMENTED', 'VERIFIED'],
  RELEASED_OUTCOME: ['IMPLEMENTED', 'VERIFIED', 'RELEASED', 'OUTCOME_VERIFIED'],
};

/**
 * The stage at which a milestone is demonstrably achieved: reaching the
 * stage means the gate guarding it was passed (its evidence consumed).
 */
const MILESTONE_STAGE: ReadonlyArray<
  readonly [LifecycleMilestone, WorkflowStage]
> = [
  ['IMPLEMENTED', 'CODE_REVIEW'],
  ['VERIFIED', 'PENDING_PROD'],
  ['RELEASED', 'PROD_VERIFICATION'],
  ['OUTCOME_VERIFIED', 'OUTCOME_VERIFICATION'],
];

export type CompleteResult =
  | {
      ok: true;
      taskId: string;
      finalSeal: 1;
      taskVersion: number;
      snapshot: CompletionSnapshot;
      warnings: string[];
      state: V2StateView;
    }
  | {
      ok: false;
      reasonCode: string;
      missing: string[];
      snapshot?: CompletionSnapshot;
      warnings?: string[];
    };

export class V2TransitionService {
  readonly engine: WorkflowEngineV2;
  private deps: V2TransitionDeps;

  constructor(deps: V2TransitionDeps) {
    this.deps = deps;
    this.engine = new WorkflowEngineV2({
      audit: deps.audit,
      // §18.2 (Batch 17): the durable outbox sink, when wired — the
      // engine appends every committed event to outbox_events and
      // restores the undispatched ones into its queue right here, so
      // a restart loses no committed-but-undrained event.
      outboxSink: deps.outbox,
      // §42 (F3): the engine names the evidence each successful gate
      // consumed; seal those records in the store so a judged record
      // can no longer be edited after the fact (EvidenceEngine.update /
      // delete throw on SEALED). Idempotent. The hook runs AFTER the
      // transition commits, so a seal failure must not un-commit it —
      // it is audit-logged (EVIDENCE_SEAL_FAILED), never thrown, never
      // silent.
      onSealEvidence: (ids) => {
        for (const id of ids) {
          try {
            deps.evidence.seal(id);
          } catch (e) {
            deps.audit.record('system', 'EVIDENCE_SEAL_FAILED', 'evidence', id, {
              error: (e as Error).message,
            });
          }
        }
      },
    });
  }

  /**
   * Persist the engine's current state for this task, verbatim, when a
   * store is wired. engine.get() returns a deep-frozen snapshot clone,
   * so the store receives exactly the committed state and nothing the
   * caller can still mutate. No store wired = no-op (the mirror stays
   * process-local, the pre-Batch-13 behavior).
   */
  private persist(taskId: string): void {
    if (!this.deps.v2States) return;
    this.deps.v2States.put(this.engine.get(taskId));
  }

  /**
   * Restore a persisted state into the engine. register() can only
   * seed stage/requirementRef/completionTarget — the remaining fields
   * (condition, milestones + histories, release state, outcome-gate
   * validity, finalSeal, taskVersion, updatedAt) are restored onto the
   * live state via getMutable(). This is restoration, not a state
   * change: the stored snapshot was produced by the engine itself and
   * persisted immediately after an engine-committed mutation, so
   * writing it back replays no transition and bypasses no gate.
   */
  private hydrate(taskId: string, saved: TaskV2State): void {
    this.engine.register(taskId, {
      stage: saved.stage,
      requirementRef: saved.requirementRef ?? undefined,
      completionTarget: saved.completionTarget,
    });
    const live = this.engine.getMutable(taskId);
    const snap = structuredClone(saved);
    live.stage = snap.stage;
    live.condition = snap.condition;
    live.milestones = snap.milestones;
    live.milestoneHistory = snap.milestoneHistory;
    live.releaseState = snap.releaseState;
    live.releaseHistory = snap.releaseHistory;
    live.outcomeGateValid = snap.outcomeGateValid;
    live.finalSeal = snap.finalSeal;
    live.taskVersion = snap.taskVersion;
    live.requirementRef = snap.requirementRef;
    live.completionTarget = snap.completionTarget;
    live.completionHistory = snap.completionHistory;
    live.updatedAt = snap.updatedAt;
  }

  /**
   * Ensure the engine mirror exists for this task. On first access the
   * persisted state wins when a store is wired and holds a row for the
   * task (hydration — the exact pre-restart state); only a task with
   * no stored state takes the legacy approximate seed from the DB row,
   * and that seed is then persisted immediately so every later access
   * (in this or any future process) hydrates instead. Returns the DB
   * task (throws TaskNotFoundError via TaskManager.get when the task
   * does not exist).
   */
  ensureSeeded(taskId: string, requirementRef?: string | null): Task {
    const task = this.deps.tasks.get(taskId);
    try {
      this.engine.get(taskId);
      return task;
    } catch {
      // Not mirrored yet — hydrate or seed below.
    }
    const saved = this.deps.v2States?.get(taskId);
    if (saved) {
      this.hydrate(taskId, saved);
      return task;
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
    this.persist(taskId);
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

  /**
   * §18.2 outbox read surface (Batch 17): this task's pending
   * committed-transition events, oldest first — the engine's queue,
   * which (with the durable sink wired) was restored from
   * outbox_events at construction, so the answer is the same before
   * and after a restart until somebody drains. Read-only: draining
   * stays the in-process consumer's acknowledgement, exactly the
   * engine's drainOutbox contract. Throws for an unknown task (via
   * ensureSeeded), like stateView.
   */
  outboxView(taskId: string): { taskId: string; events: OutboxEvent[] } {
    this.ensureSeeded(taskId);
    return { taskId, events: this.engine.listOutbox(taskId) };
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
    const evidence = this.deps.evidence.listByTask(task.id);
    // Fall back to the requirement pinned at seed time — the engine's
    // gate needs the effective pin, and a literal null here would fail
    // the requirement-pinned predicate even for a pinned task.
    const requirementVersion =
      typeof body['requirementVersion'] === 'string'
        ? body['requirementVersion']
        : this.engine.get(task.id).requirementRef;
    const compatibleEvidenceIds = this.compatibleEvidenceIds(
      evidence,
      requirementVersion,
    );
    // §16/§18.2 (Batch 8): per-evidence requirement versions from the
    // recorded rows (see header). Unrecorded evidence stays absent from
    // the map — the engine treats absent entries as "not stale".
    const evidenceReqVersions: Record<string, string> = {};
    for (const e of evidence) {
      if (e.requirementVersion) evidenceReqVersions[e.id] = e.requirementVersion;
    }
    return {
      taskId: task.id,
      taskVersion: this.engine.get(task.id).taskVersion,
      actor,
      actorRole:
        typeof body['actorRole'] === 'string' ? body['actorRole'] : undefined,
      authorization,
      requirementVersion,
      candidateDigest:
        typeof body['candidateDigest'] === 'string'
          ? body['candidateDigest']
          : null,
      implementerId:
        typeof body['implementerId'] === 'string'
          ? body['implementerId']
          : task.currentAgentId,
      evidence,
      evidenceReqVersions,
      // The server has no independent staleness set; staleness is judged
      // purely from the recorded per-evidence versions above.
      staleEvidenceIds: [],
      // §16 explicit compatibility (see compatibleEvidenceIds() below):
      // undefined unless the requirements manager declares task evidence
      // compatible with the pinned version — omitting the field keeps the
      // engine's behavior exactly as before.
      compatibleEvidenceIds,
      // Fail-closed attestations: only an explicit `true` in the request
      // asserts these operational facts; the server cannot verify them yet.
      budgetOk: body['budgetOk'] === true,
      quotaOk: body['quotaOk'] === true,
      confinementOk: body['confinementOk'] === true,
      // §18.2 (G-16): lease gate — same fail-closed declaration pattern;
      // IN_PROGRESS→CODE_REVIEW and PROD_DEPLOYING→PROD_VERIFICATION
      // require leaseValid === true or the engine denies with STALE_OWNER.
      leaseValid: body['leaseValid'] === true,
      leaseId: typeof body['leaseId'] === 'string' ? body['leaseId'] : undefined,
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
   * §16 explicit compatibility set for GateContext: ids of the task's
   * evidence that the requirements manager explicitly declares compatible
   * with the pinned requirement version (canReuseEvidence — a recorded
   * declaration for exactly that version, never inferred from version
   * proximity). Returns undefined — field omitted, engine behavior
   * unchanged — when no manager is wired, the pin is not a parseable
   * 'ID@N' ref, or no declaration matches (fail-closed in every case).
   */
  private compatibleEvidenceIds(
    evidence: Evidence[],
    pin: string | null,
  ): ReadonlySet<string> | undefined {
    const mgr = this.deps.requirements;
    if (!mgr || pin === null) return undefined;
    const parsed = parsePin(pin);
    if (!parsed) return undefined;
    const { id: requirementId, version } = parsed;
    const ids = new Set<string>();
    for (const e of evidence) {
      if (mgr.canReuseEvidence(e.id, requirementId, version)) ids.add(e.id);
    }
    return ids.size > 0 ? ids : undefined;
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
    // §19: record the milestone this stage demonstrably achieves, so the
    // milestone axis is real recorded state (not re-derived at read time).
    this.reconcileMilestones(taskId, actor, check.consumedEvidence[0]?.id);
    // Batch 13: the transition + milestone reconciliation are committed
    // engine mutations — persist the resulting mirror verbatim.
    this.persist(taskId);
    return {
      ok: true,
      from: check.from,
      to: check.to,
      intent: check.intent,
      deduped: check.deduped,
      state: this.stateView(taskId),
    };
  }

  /**
   * §19 — mark every milestone the task's current stage demonstrably
   * implies and that is not yet recorded. Idempotent; called after each
   * successful transition and before finalize, so a mirror seeded
   * mid-lifecycle catches up from its stage alone. DONE is never marked
   * here — only finalize() commits it, together with the seal.
   */
  private reconcileMilestones(
    taskId: string,
    actor: string,
    evidenceRef?: string,
  ): void {
    const s = this.engine.get(taskId);
    const stageIdx = WORKFLOW_STAGES.indexOf(s.stage);
    for (const [milestone, threshold] of MILESTONE_STAGE) {
      if (
        stageIdx >= WORKFLOW_STAGES.indexOf(threshold) &&
        !s.milestones[milestone].achieved
      ) {
        this.engine.markMilestone(
          taskId,
          milestone,
          actor,
          threshold === s.stage ? evidenceRef : undefined,
        );
      }
    }
  }

  /**
   * §20.1 — assemble the CompletionSnapshot finalize() judges, from
   * server-side facts. The rule per field (nothing is waved through):
   * - applicableAcs: the pinned requirement version's ACs from the
   *   requirements manager, each verified per acVerifiedByEvidence
   *   against the task's recorded evidence. No pin → no ACs apply.
   *   A pin the manager cannot resolve (unknown requirement/version —
   *   including the pre-persistence in-memory manager after a restart,
   *   finding F2) enumerates NO ACs and is surfaced in `warnings` and
   *   the audit log (COMPLETION_ACS_UNRESOLVED) instead of silently
   *   passing or hard-denying on another subsystem's data loss.
   * - gatesValid: the engine's outcomeGateValid — the one recorded
   *   invalidation signal for already-passed gates (a rollback flips
   *   it). Per-evidence staleness is NOT re-litigated here: it is
   *   judged by checkTransitionV2 at the gate that consumes the
   *   evidence, which is §16's enforcement point.
   * - milestonesValid: every milestone applicable to the task's
   *   completionTarget is recorded achieved (reconcileMilestones ran
   *   first, so recorded state reflects the walked stages).
   * - pendingBlocks: the condition's blockedOn list plus every hard
   *   dependency (depends_on / blocked_by) not DONE — real DB facts,
   *   the same computation gateContext makes for dependenciesReady.
   * - authorizationsComplete: the caller's authorization snapshot
   *   resolves AUTHORIZED and unexpired (same parsing as gateContext),
   *   and — when an approvals store is wired — no approval record for
   *   the task is still PENDING or lapsed EXPIRED. REJECTED records are
   *   complete (decided); the gates that needed them already judged
   *   the outcome during the stage walk.
   * - releaseApplicable: releaseState is RELEASED, or the RELEASED
   *   milestone is recorded (the task demonstrably passed the
   *   deployment gate; recordRelease has no HTTP route yet, so the
   *   milestone is the server-observable release fact).
   * - releaseNaAuthorized: explicit caller attestation only
   *   (body.releaseNaAuthorized === true), the established fail-closed
   *   pattern for facts the server cannot verify itself.
   */
  private completionSnapshot(
    task: Task,
    body: Record<string, unknown>,
  ): { snapshot: CompletionSnapshot; warnings: string[] } {
    const state = this.engine.get(task.id);
    const evidence = this.deps.evidence.listByTask(task.id);
    const warnings: string[] = [];

    const applicableAcs: Array<{ id: string; verified: boolean }> = [];
    const mgr = this.deps.requirements;
    const pin = state.requirementRef;
    if (pin !== null) {
      const parsed = parsePin(pin);
      if (!mgr || !parsed) {
        warnings.push(
          `pinned requirement ${pin} cannot be resolved here — no acceptance criteria were enumerated for the completion check`,
        );
        this.deps.audit.record('system', 'COMPLETION_ACS_UNRESOLVED', 'task', task.id, {
          requirementRef: pin,
        });
      } else {
        try {
          const ver = mgr.getVersion(parsed.id, parsed.version);
          for (const ac of ver.acceptanceCriteria) {
            applicableAcs.push({
              id: ac.id,
              verified: acVerifiedByEvidence(ac, evidence),
            });
          }
        } catch {
          warnings.push(
            `pinned requirement ${pin} is unknown to the requirements manager — no acceptance criteria were enumerated for the completion check`,
          );
          this.deps.audit.record('system', 'COMPLETION_ACS_UNRESOLVED', 'task', task.id, {
            requirementRef: pin,
          });
        }
      }
    }

    const gatesValid = state.outcomeGateValid;

    const milestonesValid = MILESTONES_BY_TARGET[state.completionTarget].every(
      (ms) => state.milestones[ms].achieved,
    );

    const pendingBlocks: string[] = state.condition.blockedOn.map(
      (b) => `blocked on ${b}`,
    );
    for (const d of task.dependencies) {
      if (d.kind !== 'depends_on' && d.kind !== 'blocked_by') continue;
      let done = false;
      try {
        done = this.deps.tasks.get(d.taskId).status === 'DONE';
      } catch {
        done = false; // dangling dependency → still blocking (fail-closed)
      }
      if (!done) pendingBlocks.push(`dependency ${d.taskId} is not DONE`);
    }

    const authStatus = body['authorizationStatus'];
    const callerStatus =
      authStatus === 'WAITING_HUMAN_DISPATCH' ||
      authStatus === 'REVOKED' ||
      authStatus === 'EXPIRED'
        ? authStatus
        : 'AUTHORIZED';
    const expiresAt =
      typeof body['authorizationExpiresAt'] === 'string'
        ? body['authorizationExpiresAt']
        : null;
    const callerExpired =
      expiresAt !== null &&
      Number.isFinite(Date.parse(expiresAt)) &&
      Date.parse(expiresAt) <= Date.now();
    let authorizationsComplete = callerStatus === 'AUTHORIZED' && !callerExpired;
    if (authorizationsComplete && this.deps.approvals) {
      const rows = this.deps.approvals.listByTask(task.id);
      if (rows.some((a) => a.status === 'PENDING' || a.status === 'EXPIRED')) {
        authorizationsComplete = false;
      }
    }

    const releaseApplicable =
      state.releaseState === 'RELEASED' || state.milestones.RELEASED.achieved;
    const releaseNaAuthorized = body['releaseNaAuthorized'] === true;

    return {
      snapshot: {
        applicableAcs,
        gatesValid,
        milestonesValid,
        pendingBlocks,
        authorizationsComplete,
        releaseApplicable,
        releaseNaAuthorized,
      },
      warnings,
    };
  }

  /**
   * §20.1 — complete a task over HTTP (F1): assemble the snapshot from
   * server facts, run engine.finalize() (completion predicates + DONE +
   * final_seal=1 in one commit), and write DONE back to the DB row so
   * the v2 mirror and the row agree. On a predicate denial nothing is
   * written — the engine state and the DB row are both untouched.
   */
  complete(
    taskId: string,
    actor: string,
    body: Record<string, unknown>,
  ): CompleteResult {
    const task = this.ensureSeeded(
      taskId,
      typeof body['requirementVersion'] === 'string'
        ? body['requirementVersion']
        : null,
    );
    this.reconcileMilestones(taskId, actor);
    // Batch 13: milestone reconciliation above is a committed mutation
    // even when finalize() below denies — persist it either way, then
    // persist again after a successful finalize (DONE + finalSeal).
    this.persist(taskId);
    const { snapshot, warnings } = this.completionSnapshot(task, body);
    const result = this.engine.finalize(taskId, actor, snapshot);
    if (!result.ok) {
      return {
        ok: false,
        reasonCode: result.reasonCode,
        missing: result.missing,
        snapshot,
        warnings,
      };
    }
    const fresh = this.deps.tasks.get(taskId);
    if (fresh.status !== 'DONE') {
      this.deps.tasks.setStatus(taskId, 'DONE');
    }
    this.persist(taskId);
    return {
      ok: true,
      taskId,
      finalSeal: 1,
      taskVersion: result.taskVersion,
      snapshot,
      warnings,
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
      // The same RequirementManager instance the requirements routes
      // write compatibility declarations to (single process, one store).
      requirements: getRequirementManager(),
      // §20.1: real approval records for the completion snapshot. The
      // shape guard keeps minimal embedder contexts (no DB) working —
      // they simply get the caller-snapshot-only authorization rule.
      approvals:
        ctx.fdb && typeof ctx.fdb.approvals?.listByTask === 'function'
          ? ctx.fdb.approvals
          : undefined,
      // Batch 13: the durable v2 mirror store (task_v2_state table).
      // Same shape-guard pattern: a context without the SQLite store
      // keeps the process-local mirror.
      v2States:
        ctx.fdb &&
        typeof ctx.fdb.taskV2States?.get === 'function' &&
        typeof ctx.fdb.taskV2States?.put === 'function'
          ? ctx.fdb.taskV2States
          : undefined,
      // Batch 17: the durable outbox store (outbox_events table). Same
      // shape-guard pattern: a context without the SQLite store keeps
      // the process-local outbox queue.
      outbox:
        ctx.fdb &&
        typeof ctx.fdb.outbox?.append === 'function' &&
        typeof ctx.fdb.outbox?.listPending === 'function' &&
        typeof ctx.fdb.outbox?.markDispatched === 'function'
          ? ctx.fdb.outbox
          : undefined,
    });
  }
  return shared;
}

/** Test seam: build an isolated service instead of the shared singleton. */
export function createV2TransitionService(deps: V2TransitionDeps): V2TransitionService {
  return new V2TransitionService(deps);
}

const TASK_V2_RE = /^\/api\/tasks\/([^/]+)\/(v2-transition|v2-state|v2-complete|outbox)$/;

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

  if (method === 'GET' && m[2] === 'outbox') {
    // §18.2 (Batch 17) — the task's pending outbox events for
    // downstream consumers to pull. Read-only like every GET here
    // (archived projects included): it reports committed facts and
    // drains nothing — acknowledgement stays with the in-process
    // consumer via engine.drainOutbox.
    try {
      ctx.json(res, 200, service.outboxView(taskId));
    } catch (e) {
      ctx.json(res, 404, { error: (e as Error).message });
    }
    return true;
  }

  if (method === 'POST' && m[2] === 'v2-transition') {
    // Batch 14 — archived projects are closed to new facts: refuse
    // before the service is touched, so neither the engine mirror nor
    // the DB row changes (GET /v2-state above stays readable). The
    // ctx.fdb shape guard matches this module's optional-store stance:
    // no DB in the context means no archived projects can exist.
    if (ctx.fdb && isTaskProjectArchived(ctx.fdb, taskId)) {
      ctx.json(res, 409, projectArchivedBody(projectIdOfTask(ctx.fdb, taskId) as string));
      return true;
    }
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

  if (method === 'POST' && m[2] === 'v2-complete') {
    // Batch 14 — same archive guard as v2-transition: finalize() must
    // not commit DONE/final_seal under an archived project.
    if (ctx.fdb && isTaskProjectArchived(ctx.fdb, taskId)) {
      ctx.json(res, 409, projectArchivedBody(projectIdOfTask(ctx.fdb, taskId) as string));
      return true;
    }
    const body = await ctx.readBody(req);
    const actor =
      (typeof body['by'] === 'string' && body['by']) ||
      (typeof body['actor'] === 'string' && body['actor']) ||
      'human';
    try {
      const r = service.complete(taskId, actor, body);
      if (!r.ok) {
        // Completion predicates unmet (or wrong stage/condition): 422,
        // engine state and DB row untouched. The assembled snapshot is
        // returned so the caller can see exactly which fact failed.
        ctx.json(res, 422, r);
        return true;
      }
      ctx.bus.emit(
        'WORKFLOW_TRANSITIONED',
        { taskId, from: 'OUTCOME_VERIFICATION', to: 'DONE', actor, engine: 'v2', intent: 'REQUEST_COMPLETE' },
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

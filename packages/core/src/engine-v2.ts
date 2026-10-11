/**
 * Workflow engine v2 — SPEC_V2 §18 (transition contract) + §19 (milestones).
 *
 * The engine — never the AI — decides whether a transition is valid.
 * Board drag-and-drop and the HTTP API MUST call the same
 * `requestTransitionV2` / `requestIntent` methods below; direct writes to
 * stage/condition/milestone fields are not allowed (no other writer exists).
 *
 * Additive: v1 WorkflowEngine (engine.ts) is untouched.
 */

import { AuditLog } from './audit';
import { nowIso } from './types';
import { ReasonCode } from './reason-codes';
import {
  ActorAuthorization,
  ConditionRecord,
  GateContext,
  INTENT_TARGETS,
  LifecycleMilestone,
  MilestoneStatus,
  ReleaseState,
  TransitionCheckV2,
  WorkflowStage,
  checkTransitionV2,
} from './workflow-v2';

export interface TaskV2State {
  taskId: string;
  stage: WorkflowStage;
  condition: ConditionRecord;
  milestones: Record<LifecycleMilestone, MilestoneStatus>;
  milestoneHistory: Array<{
    milestone: LifecycleMilestone;
    at: string;
    by: string;
    invalidatedAt?: string;
  }>;
  releaseState: ReleaseState;
  releaseHistory: Array<{
    state: ReleaseState;
    at: string;
    by: string;
    reason: string;
  }>;
  /** Outcome gate validity; a rollback invalidates it (§19). */
  outcomeGateValid: boolean;
  /** §20.1 final seal: committed in the SAME transaction as DONE. */
  finalSeal: 0 | 1;
  /** Optimistic-concurrency version, bumped on every mutation. */
  taskVersion: number;
  requirementRef: string | null;
  completionTarget: 'IMPLEMENTATION' | 'VERIFIED_DELIVERY' | 'RELEASED_OUTCOME';
  completionHistory: Array<{
    kind: 'COMPLETED' | 'COMPLETION_INVALIDATED' | 'CANCELLED';
    at: string;
    by: string;
    reason: string;
  }>;
  updatedAt: string;
}

export interface EngineV2Deps {
  audit: AuditLog;
  /** Deterministic clock for tests. */
  now?: () => number;
  /** Called with sealed evidence ids after a successful transition. */
  onSealEvidence?: (ids: string[]) => void;
  /**
   * Best-effort lease release on cancelTask(). The engine does not track
   * leases itself; the coordinator wires this to the @ai-factory/leases
   * manager (release by task-owned lease ids). Returns the number of
   * leases released. Throwing aborts nothing — the failure is audit-logged.
   */
  releaseLeases?: (taskId: string) => number;
}

/** Snapshot the completion predicates are evaluated against (§20.1). */
export interface CompletionSnapshot {
  applicableAcs: Array<{ id: string; verified: boolean }>;
  gatesValid: boolean;
  milestonesValid: boolean;
  pendingBlocks: string[];
  authorizationsComplete: boolean;
  /** False when completion_target is VERIFIED_DELIVERY with recorded N/A. */
  releaseApplicable: boolean;
  releaseNaAuthorized: boolean;
}

export interface CompletionPredicate {
  id: string;
  description: string;
  reasonCode: ReasonCode;
  check: (snap: CompletionSnapshot) => boolean;
}

/** §20.1 — the applicable completion predicates, checked independently. */
export const STANDARD_COMPLETION_PREDICATES: CompletionPredicate[] = [
  {
    id: 'all-acs-verified',
    description: 'All applicable acceptance criteria are verified',
    reasonCode: 'MISSING_EVIDENCE',
    check: (s) => s.applicableAcs.every((a) => a.verified),
  },
  {
    id: 'gates-valid',
    description: 'All applicable gates are currently valid (no stale evidence)',
    reasonCode: 'STALE_EVIDENCE',
    check: (s) => s.gatesValid,
  },
  {
    id: 'milestones-valid',
    description: 'All applicable lifecycle milestones hold',
    reasonCode: 'POLICY_DENIED',
    check: (s) => s.milestonesValid,
  },
  {
    id: 'no-pending-blocks',
    description: 'No pending blocks',
    reasonCode: 'DEPENDENCY_NOT_READY',
    check: (s) => s.pendingBlocks.length === 0,
  },
  {
    id: 'authorizations-complete',
    description: 'All required authorizations are complete and unexpired',
    reasonCode: 'AUTHORIZATION_EXPIRED',
    check: (s) => s.authorizationsComplete,
  },
  {
    id: 'release-or-na',
    description: 'Released, or release N/A authorized for VERIFIED_DELIVERY',
    reasonCode: 'APPROVAL_REQUIRED',
    check: (s) => s.releaseApplicable || s.releaseNaAuthorized,
  },
];

export type FinalizeResult =
  | { ok: true; taskId: string; finalSeal: 1; taskVersion: number }
  | {
      ok: false;
      reasonCode: ReasonCode;
      missing: string[];
    };

const AUTHORIZED: ActorAuthorization = { status: 'AUTHORIZED', expiresAt: null };

/** Recursively freeze an object graph. Used by get() (§18.2 read barrier). */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  for (const key of Object.getOwnPropertyNames(obj)) {
    deepFreeze((obj as Record<string, unknown>)[key]);
  }
  return Object.freeze(obj);
}

function emptyMilestones(): Record<LifecycleMilestone, MilestoneStatus> {
  const m = (achieved: boolean): MilestoneStatus => ({
    achieved,
    at: null,
    evidenceRef: null,
  });
  return {
    IMPLEMENTED: m(false),
    VERIFIED: m(false),
    RELEASED: m(false),
    OUTCOME_VERIFIED: m(false),
    DONE: m(false),
  };
}

export class WorkflowEngineV2 {
  private states = new Map<string, TaskV2State>();
  /** idempotencyKey -> last result (duplicate events are deduped, §18.2). */
  private seen = new Map<string, TransitionCheckV2>();

  constructor(private deps: EngineV2Deps) {}

  private iso(): string {
    return new Date(this.deps.now ? this.deps.now() : Date.now()).toISOString();
  }

  register(
    taskId: string,
    init?: Partial<Pick<TaskV2State, 'requirementRef' | 'completionTarget'>>,
  ): TaskV2State {
    const now = this.iso();
    const state: TaskV2State = {
      taskId,
      stage: 'TODO',
      condition: {
        condition: 'ACTIVE',
        reason: 'registered',
        resumeState: null,
        blockedOn: [],
        updatedAt: now,
        updatedBy: 'system',
      },
      milestones: emptyMilestones(),
      milestoneHistory: [],
      releaseState: 'NONE',
      releaseHistory: [],
      outcomeGateValid: true,
      finalSeal: 0,
      taskVersion: 1,
      requirementRef: init?.requirementRef ?? null,
      completionTarget: init?.completionTarget ?? 'RELEASED_OUTCOME',
      completionHistory: [],
      updatedAt: now,
    };
    this.states.set(taskId, state);
    this.deps.audit.record('system', 'TASK_V2_REGISTERED', 'task', taskId, {
      requirementRef: state.requirementRef,
      completionTarget: state.completionTarget,
    });
    return state;
  }

  /**
   * §18.2 — internal live accessor. Returns the mutable engine-owned state.
   * Engine mutators (and package tests setting up fixtures) use this;
   * external callers MUST use get(), which returns a deep-frozen snapshot.
   */
  getMutable(taskId: string): TaskV2State {
    const s = this.states.get(taskId);
    if (!s) throw new Error(`Unknown task ${taskId}`);
    return s;
  }

  /**
   * §18.2 read barrier — public read returns a deep copy, deep-frozen.
   * Mutating the returned object (or any nested object) throws, so a
   * caller cannot bypass gate checks by rewriting stage / condition /
   * milestones on the object it was handed.
   */
  get(taskId: string): TaskV2State {
    return deepFreeze(structuredClone(this.getMutable(taskId)));
  }

  private mutate(taskId: string, fn: (s: TaskV2State) => void): TaskV2State {
    const s = this.getMutable(taskId);
    fn(s);
    s.taskVersion += 1;
    s.updatedAt = this.iso();
    return s;
  }

  /**
   * §18.2 — request a stage transition. Board drag-and-drop and the HTTP API
   * both call this method; there is no other writer for stage/condition.
   * `to === 'DONE'` is rejected here: DONE requires finalize() so the
   * completion predicates and final_seal commit in one transaction (§20.1).
   */
  requestTransitionV2(
    taskId: string,
    to: WorkflowStage,
    actor: string,
    ctx: GateContext & { idempotencyKey?: string },
  ): TransitionCheckV2 {
    if (ctx.idempotencyKey !== undefined) {
      const prior = this.seen.get(ctx.idempotencyKey);
      if (prior) return prior.ok ? { ...prior, deduped: true } : prior;
    }

    const s = this.get(taskId);
    if (to === 'DONE') {
      const denied: TransitionCheckV2 = {
        ok: false,
        from: s.stage,
        to,
        reasonCode: 'POLICY_DENIED',
        missing: [
          'DONE requires finalize(): completion predicates + final_seal commit atomically (§20.1)',
        ],
      };
      this.deps.audit.record(actor, 'WORKFLOW_V2_DENIED', 'task', taskId, {
        from: s.stage, to, reasonCode: denied.reasonCode, missing: denied.missing,
      });
      return denied;
    }

    const check = checkTransitionV2(s.stage, to, {
      ...ctx,
      taskId,
      taskVersion: s.taskVersion,
      requirementVersion: ctx.requirementVersion ?? s.requirementRef,
    });

    if (!check.ok) {
      this.deps.audit.record(actor, 'WORKFLOW_V2_DENIED', 'task', taskId, {
        from: check.from, to: check.to,
        reasonCode: check.reasonCode, missing: check.missing,
      });
      return check;
    }

    this.mutate(taskId, (st) => {
      st.stage = to;
    });
    this.deps.onSealEvidence?.(check.consumedEvidence.map((e) => e.id));
    this.deps.audit.record(actor, 'WORKFLOW_V2_TRANSITIONED', 'task', taskId, {
      from: check.from,
      to: check.to,
      intent: check.intent,
      taskVersion: this.get(taskId).taskVersion,
    });

    if (ctx.idempotencyKey !== undefined) this.seen.set(ctx.idempotencyKey, check);
    return check;
  }

  /** §18.2 AI intents. REPORT_BLOCKED sets the condition; REQUEST_COMPLETE finalizes. */
  requestIntent(
    taskId: string,
    intent: string,
    actor: string,
    ctx: GateContext & {
      idempotencyKey?: string;
      completionSnapshot?: CompletionSnapshot;
      blockReason?: string;
    },
  ): TransitionCheckV2 | FinalizeResult {
    if (intent === 'REPORT_BLOCKED') {
      this.setCondition(taskId, 'BLOCKED', ctx.blockReason ?? 'reported blocked', actor, {
        resumeState: this.get(taskId).stage,
      });
      return {
        ok: true,
        from: this.get(taskId).stage,
        to: this.get(taskId).stage,
        intent,
        consumedEvidence: [],
      };
    }
    if (intent === 'REQUEST_COMPLETE') {
      if (!ctx.completionSnapshot) {
        return {
          ok: false,
          reasonCode: 'MISSING_EVIDENCE',
          missing: ['Completion snapshot is required for REQUEST_COMPLETE'],
        };
      }
      return this.finalize(taskId, actor, ctx.completionSnapshot);
    }
    const target = INTENT_TARGETS[intent];
    if (!target) {
      const s = this.get(taskId);
      return {
        ok: false,
        from: s.stage,
        to: s.stage,
        reasonCode: 'UNSUPPORTED_CAPABILITY',
        missing: [`Unknown intent ${intent}`],
      };
    }
    return this.requestTransitionV2(taskId, target, actor, ctx);
  }

  /** §18.3 — set the independent condition field (with reason/resume/blocked_on). */
  setCondition(
    taskId: string,
    condition: TaskV2State['condition']['condition'],
    reason: string,
    actor: string,
    opts?: { resumeState?: WorkflowStage | null; blockedOn?: string[] },
  ): TaskV2State {
    const s = this.mutate(taskId, (st) => {
      st.condition = {
        condition,
        reason,
        resumeState: opts?.resumeState ?? null,
        blockedOn: opts?.blockedOn ?? [],
        updatedAt: this.iso(),
        updatedBy: actor,
      };
    });
    this.deps.audit.record(actor, 'TASK_CONDITION_SET', 'task', taskId, {
      condition, reason,
    });
    return s;
  }

  markMilestone(
    taskId: string,
    milestone: LifecycleMilestone,
    actor: string,
    evidenceRef?: string,
  ): TaskV2State {
    const now = this.iso();
    const s = this.mutate(taskId, (st) => {
      st.milestones[milestone] = { achieved: true, at: now, evidenceRef: evidenceRef ?? null };
      st.milestoneHistory.push({ milestone, at: now, by: actor });
    });
    this.deps.audit.record(actor, 'MILESTONE_ACHIEVED', 'task', taskId, {
      milestone, evidenceRef: evidenceRef ?? null,
    });
    return s;
  }

  /**
   * §19/§20.1 — finalize to DONE. Breaks the "100% requires Done, Done
   * requires 100%" loop: the completion predicates are checked INDEPENDENTLY
   * (not via progress == 100), then DONE + final_seal=1 commit in ONE
   * synchronous block — no interleaving, no partial commit. On denial the
   * state is untouched.
   */
  finalize(
    taskId: string,
    actor: string,
    snapshot: CompletionSnapshot,
  ): FinalizeResult {
    const s = this.get(taskId);
    if (s.stage !== 'OUTCOME_VERIFICATION') {
      return {
        ok: false,
        reasonCode: 'POLICY_DENIED',
        missing: [
          `finalize() only from OUTCOME_VERIFICATION, current stage is ${s.stage}`,
        ],
      };
    }
    if (s.condition.condition !== 'ACTIVE') {
      return {
        ok: false,
        reasonCode: 'POLICY_DENIED',
        missing: [
          `Cannot finalize while condition is ${s.condition.condition}: ${s.condition.reason}`,
        ],
      };
    }

    const failed = STANDARD_COMPLETION_PREDICATES.filter((p) => !p.check(snapshot));
    if (failed.length > 0) {
      this.deps.audit.record(actor, 'WORKFLOW_FINALIZE_DENIED', 'task', taskId, {
        failedPredicates: failed.map((p) => p.id),
      });
      return {
        ok: false,
        reasonCode: failed[0].reasonCode,
        missing: failed.map((p) => `${p.description} [${p.id}]`),
      };
    }

    // Single transaction: checks above, then commit below — nothing in between.
    const now = this.iso();
    this.mutate(taskId, (st) => {
      st.stage = 'DONE';
      st.finalSeal = 1;
      st.milestones.DONE = { achieved: true, at: now, evidenceRef: null };
      st.milestoneHistory.push({ milestone: 'DONE', at: now, by: actor });
      st.completionHistory.push({ kind: 'COMPLETED', at: now, by: actor, reason: 'all completion predicates hold' });
    });
    this.deps.audit.record(actor, 'WORKFLOW_FINALIZED', 'task', taskId, {
      finalSeal: 1,
      taskVersion: this.get(taskId).taskVersion,
      predicates: STANDARD_COMPLETION_PREDICATES.map((p) => p.id),
    });
    return { ok: true, taskId, finalSeal: 1, taskVersion: this.get(taskId).taskVersion };
  }

  /**
   * §19 — rollback: the RELEASED history event is kept, the CURRENT effective
   * release state becomes ROLLED_BACK, and the outcome gate is invalidated.
   */
  recordRollback(taskId: string, actor: string, reason: string): TaskV2State {
    const now = this.iso();
    const s = this.mutate(taskId, (st) => {
      st.releaseState = 'ROLLED_BACK';
      st.releaseHistory.push({ state: 'ROLLED_BACK', at: now, by: actor, reason });
      st.outcomeGateValid = false;
    });
    this.deps.audit.record(actor, 'RELEASE_ROLLED_BACK', 'task', taskId, { reason });
    return s;
  }

  /** Mark the release itself (used before a rollback can exist). */
  recordRelease(taskId: string, actor: string, reason: string): TaskV2State {
    const now = this.iso();
    const s = this.mutate(taskId, (st) => {
      st.releaseState = 'RELEASED';
      st.releaseHistory.push({ state: 'RELEASED', at: now, by: actor, reason });
      st.milestones.RELEASED = { achieved: true, at: now, evidenceRef: null };
      st.milestoneHistory.push({ milestone: 'RELEASED', at: now, by: actor });
    });
    this.deps.audit.record(actor, 'RELEASE_RECORDED', 'task', taskId, { reason });
    return s;
  }

  /**
   * §19 — post-DONE regression: append COMPLETION_INVALIDATED and reopen.
   * History is NEVER rewritten: milestoneHistory keeps the earlier DONE.
   */
  invalidateCompletion(taskId: string, actor: string, reason: string): TaskV2State {
    const s = this.get(taskId);
    if (s.stage !== 'DONE') {
      throw new Error(`invalidateCompletion() requires stage DONE, got ${s.stage}`);
    }
    const now = this.iso();
    const out = this.mutate(taskId, (st) => {
      st.completionHistory.push({ kind: 'COMPLETION_INVALIDATED', at: now, by: actor, reason });
      const doneEntry = st.milestoneHistory.find(
        (h) => h.milestone === 'DONE' && h.invalidatedAt === undefined,
      );
      if (doneEntry) doneEntry.invalidatedAt = now;
      st.milestones.DONE = { achieved: false, at: null, evidenceRef: null };
      st.finalSeal = 0;
      st.stage = 'IN_PROGRESS';
      st.condition = {
        condition: 'REWORK',
        reason,
        resumeState: 'IN_PROGRESS',
        blockedOn: [],
        updatedAt: now,
        updatedBy: actor,
      };
    });
    this.deps.audit.record(actor, 'COMPLETION_INVALIDATED', 'task', taskId, { reason });
    return out;
  }

  /**
   * Cancel a task. Sets the orthogonal condition to CANCELLED (the workflow
   * stage is left untouched — §18.3 three-state separation), appends a
   * CANCELLED completion-history entry, writes a TASK_CANCELLED audit event,
   * and best-effort releases task-associated leases. Idempotent: cancelling
   * an already-cancelled task is a no-op. Lease-release failures are
   * audit-logged and never fatal.
   */
  cancelTask(taskId: string, actor: string, reason: string): TaskV2State {
    const s = this.get(taskId);
    if (s.condition.condition === 'CANCELLED') return s;
    const now = this.iso();
    const out = this.mutate(taskId, (st) => {
      st.condition = {
        condition: 'CANCELLED',
        reason,
        resumeState: null,
        blockedOn: [],
        updatedAt: now,
        updatedBy: actor,
      };
      st.completionHistory.push({ kind: 'CANCELLED', at: now, by: actor, reason });
    });
    let leasesReleased = 0;
    const releaser = this.deps.releaseLeases;
    if (releaser) {
      try {
        leasesReleased = releaser(taskId);
      } catch (err) {
        this.deps.audit.record(actor, 'TASK_CANCEL_LEASE_RELEASE_FAILED', 'task', taskId, {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.deps.audit.record(actor, 'TASK_CANCELLED', 'task', taskId, {
      reason,
      leasesReleased,
    });
    return out;
  }
}

export { nowIso };

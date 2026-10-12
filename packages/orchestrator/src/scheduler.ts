/**
 * Scheduler — spec §93, hardened to SPEC_V2 §21 (G-30…G-34, G-36).
 *
 * Decides which tasks run when: priority ordering, dependency gating,
 * concurrency limits, and per-agent workload tracking.
 *
 * All scheduling policy is code (deterministic), per the §92 rule that
 * scheduling must never be owned by an LLM. The only AI-adjacent input is
 * the priority assigned upstream — once assigned, ordering is pure.
 *
 * §21 additions over the §93 baseline:
 *  - G-31: priorities are the five §21.1 levels P0–P4 (aligned with core
 *    and resources; the old P0–P3 type contradicted both).
 *  - G-30: a unified pre-dispatch gate over the nine §21.1 hard
 *    constraints (see HARD_CONSTRAINTS). evaluateBatch() reports every
 *    failing constraint per task in structured form; nextBatch() keeps
 *    its old signature and simply never selects a gated-out task.
 *  - G-32: enqueue() rejects invalid authority before the task can take
 *    part in any priority comparison; queue ordering is multi-factor
 *    (Severity/Priority, SLA deadline, critical path, risk, used
 *    capacity, fairness) instead of priority+FIFO alone.
 *  - G-33: aging (bounded priority boost while waiting), P0 safe-point
 *    preemption directives with migration protection for the preempted
 *    task, and capacity reserved for Monitor/Recovery lanes — when only
 *    reserved slots remain, new development runs are refused (§21.2).
 *  - §21.2: every batch evaluation is recorded in a bounded decision
 *    log with the ordering basis, so a scheduling decision can be
 *    explained after the fact.
 */

export type SchedulerPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

/** §21.1: P0 Production Incident → P1 Critical Bug → P2 Normal Task → P3 Enhancement → P4 Research. */
const PRIORITY_RANK: Record<SchedulerPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

/**
 * The nine §21.1 hard constraints that must pass before dispatch, in the
 * order the spec lists them: Authorization, Authority, Dependency,
 * Capability, Isolation, Verification Independence, Resource Locks,
 * Budget Reservation, Model Availability.
 */
export const HARD_CONSTRAINTS = [
  'authorization',
  'authority',
  'dependency',
  'capability',
  'isolation',
  'verificationIndependence',
  'resourceLocks',
  'budgetReservation',
  'modelAvailability',
] as const;

export type HardConstraint = (typeof HARD_CONSTRAINTS)[number];

/** One failed gate check: which constraint, and why it failed. */
export interface ConstraintFailure {
  constraint: HardConstraint | 'reservedCapacity';
  reason: string;
}

/** A queued task the gate kept out of a batch, with every failure. */
export interface BlockedTask {
  taskId: string;
  failures: ConstraintFailure[];
}

/**
 * §21.2 preemption directive: the scheduler cannot stop a running task
 * itself — the runner stops `preemptTaskId` at its next safe point,
 * releases its slot, then calls applyPreemption() and re-evaluates.
 */
export interface PreemptionDirective {
  preemptTaskId: string;
  forTaskId: string;
  reason: string;
}

/** The factor values that ordered one task in a batch evaluation. */
export interface OrderingFactors {
  priority: SchedulerPriority;
  /** Priority rank after aging boost (lower = earlier). */
  effectiveRank: number;
  severity: number;
  slaDeadline: number | null;
  criticalPathLength: number;
  risk: number;
  /** Tasks currently running for the task's pinned agent. */
  agentLoad: number;
  /** Tasks currently running under the same authority principal. */
  principalRunning: number;
  preempted: boolean;
}

/** Full result of one batch evaluation (nextBatch() is its projection). */
export interface BatchEvaluation {
  selected: string[];
  blocked: BlockedTask[];
  /** A P0 safe-point preemption opportunity, when one exists. */
  preemption: PreemptionDirective | null;
  /** Ordering basis for every selected and blocked task. */
  basis: Record<string, OrderingFactors>;
  at: number;
}

/** One recorded scheduling decision (§21.2: decisions keep their basis). */
export interface DecisionEntry {
  at: number;
  kind: 'batch' | 'enqueue-rejected' | 'preemption-applied';
  summary: string;
  selected?: string[];
  blocked?: BlockedTask[];
  basis?: Record<string, OrderingFactors>;
  directive?: PreemptionDirective;
}

/** enqueue() rejected a task whose authority is invalid (§21.1). */
export class InvalidAuthorityError extends Error {
  readonly name = 'InvalidAuthorityError';
  constructor(
    readonly taskId: string,
    readonly reason: string,
  ) {
    super(`invalid authority for task ${taskId}: ${reason}`);
  }
}

/** Which capacity lane a task draws from (§21.2 reserved capacity). */
export type SchedulerLane = 'development' | 'monitor' | 'recovery';

export interface SchedulableTask {
  id: string;
  priority: SchedulerPriority;
  /** Task ids that must be in `done` before this task is eligible. */
  dependsOn: string[];
  /** Agent this task is pinned to (optional). */
  agentId?: string;
  /** §21.1 Severity — higher is more severe; breaks priority ties. */
  severity?: number;
  /** §21.1 SLA deadline (epoch ms) — earlier deadlines schedule first. */
  slaDeadline?: number;
  /** §21.1 dependency critical-path length — longer paths first, so the
   *  chain that unblocks the most downstream work starts earliest. */
  criticalPathLength?: number;
  /** §21.1 risk — higher risk first (documented local policy: risky work
   *  is surfaced while capacity is fresh; aging + fairness keep it from
   *  starving everything else). The spec names the factor, not a sign. */
  risk?: number;
  /** §21.1 the superior/principal dispatching this task. Invalid
   *  authority is rejected at enqueue, before any priority comparison. */
  authority?: { principal: string };
  /** Capacity lane; default 'development'. Monitor/Recovery tasks may
   *  use the slots reserved by `reservedSlots` (§21.2). */
  lane?: SchedulerLane;
  /** True while the task is inside a non-interruptible transaction
   *  (e.g. a database migration): §21.2 forbids pretending a killed
   *  mid-transaction task rolled back, so it is never preempted. */
  protectedFromPreemption?: boolean;
  /**
   * Caller-attested hard-constraint facts (§21.1). `false` fails the
   * gate; `true` passes it; absent means "not attested" — passing unless
   * the scheduler runs with requireAllConstraints or a checker for that
   * constraint (checkers take precedence over attestation).
   */
  constraints?: Partial<Record<HardConstraint, boolean>>;
}

export interface AgentWorkload {
  agentId: string;
  activeCount: number;
}

export interface Clock {
  now: () => number;
}

const defaultClock: Clock = { now: () => Date.now() };

export interface SchedulerOptions {
  /** Max tasks that may run concurrently. Default: 4. */
  concurrencyLimit?: number;
  clock?: Clock;
  /**
   * Dynamic hard-constraint checkers (§21.1): return a failure reason or
   * null. A checker, when present for a constraint, is the authority for
   * that constraint (overrides task attestation) — this is where live
   * facts belong, e.g. "budget reservation available" asked of the
   * resource BudgetTracker, or "model available" asked of the router.
   */
  constraintCheckers?: Partial<Record<HardConstraint, (task: SchedulableTask) => string | null>>;
  /**
   * Strict gate mode: a constraint with neither attestation nor checker
   * counts as FAILED ("not evaluated") instead of passing. Default false
   * so bare §93-style tasks keep scheduling exactly as before.
   */
  requireAllConstraints?: boolean;
  /** Validate a task's authority at enqueue; return a reason or null. */
  authorityValidator?: (task: SchedulableTask) => string | null;
  /** Reject enqueue() for tasks carrying no authority at all. */
  requireAuthority?: boolean;
  /**
   * §21.2 aging: a waiting task gains one effective priority level per
   * intervalMs waited, up to maxBoostLevels (and never above P0). Off by
   * default; ordering without it is unchanged.
   */
  aging?: { intervalMs: number; maxBoostLevels: number };
  /**
   * §21.2: slots held back for Monitor/Recovery. Development tasks may
   * only use (concurrencyLimit − reservedSlots) slots; when those are
   * exhausted, development tasks are refused (blocked with a
   * 'reservedCapacity' failure) while monitor/recovery tasks may still
   * start in the reserve. Default 0.
   */
  reservedSlots?: number;
  /** How long a preempted task is protected from being preempted again
   *  after it resumes (migration protection, §21.2). Default 60_000. */
  preemptionProtectionMs?: number;
  /** Bound on the in-memory decision log. Default 100 entries. */
  decisionLogLimit?: number;
}

interface QueuedTask extends SchedulableTask {
  /** Monotonic sequence so FIFO breaks ties deterministically. */
  seq: number;
  enqueuedAt: number;
  /** This task was preempted once and is waiting to resume. */
  preempted: boolean;
  /** Not preemptible again before this epoch-ms instant. */
  preemptProtectedUntil: number;
}

interface RunningMeta {
  lane: SchedulerLane;
  principal: string;
  priority: SchedulerPriority;
}

export class Scheduler {
  private readonly concurrencyLimit: number;
  private readonly clock: Clock;
  private readonly constraintCheckers: SchedulerOptions['constraintCheckers'];
  private readonly requireAllConstraints: boolean;
  private readonly authorityValidator: SchedulerOptions['authorityValidator'];
  private readonly requireAuthority: boolean;
  private readonly aging: SchedulerOptions['aging'];
  private readonly reservedSlots: number;
  private readonly preemptionProtectionMs: number;
  private readonly decisionLogLimit: number;

  private readonly queue = new Map<string, QueuedTask>();
  private readonly running = new Set<string>();
  private readonly done = new Set<string>();
  private readonly workload = new Map<string, number>();
  private readonly runningMeta = new Map<string, RunningMeta>();
  private readonly runningPrincipals = new Map<string, number>();
  private readonly safePoints = new Set<string>();
  private readonly decisions: DecisionEntry[] = [];
  private seq = 0;

  constructor(options: SchedulerOptions = {}) {
    this.concurrencyLimit = options.concurrencyLimit ?? 4;
    this.clock = options.clock ?? defaultClock;
    this.constraintCheckers = options.constraintCheckers;
    this.requireAllConstraints = options.requireAllConstraints ?? false;
    this.authorityValidator = options.authorityValidator;
    this.requireAuthority = options.requireAuthority ?? false;
    this.aging = options.aging;
    this.reservedSlots = Math.max(0, options.reservedSlots ?? 0);
    this.preemptionProtectionMs = options.preemptionProtectionMs ?? 60_000;
    this.decisionLogLimit = Math.max(1, options.decisionLogLimit ?? 100);
  }

  /**
   * Add (or re-add) a task to the pending queue.
   *
   * §21.1: invalid authority is rejected FIRST — the task never enters
   * the queue and never takes part in a priority comparison. Authority
   * is invalid when a present principal is blank, when the configured
   * authorityValidator rejects it, or (with requireAuthority) when the
   * task carries no authority at all.
   */
  enqueue(task: SchedulableTask): void {
    const problem = this.authorityProblem(task);
    if (problem !== null) {
      this.recordDecision({
        at: this.clock.now(),
        kind: 'enqueue-rejected',
        summary: `enqueue ${task.id} rejected: ${problem}`,
      });
      throw new InvalidAuthorityError(task.id, problem);
    }
    const existing = this.queue.get(task.id);
    const record: QueuedTask = {
      ...task,
      seq: existing?.seq ?? this.seq++,
      enqueuedAt: existing?.enqueuedAt ?? this.clock.now(),
      preempted: existing?.preempted ?? false,
      preemptProtectedUntil: existing?.preemptProtectedUntil ?? 0,
    };
    this.queue.set(task.id, record);
    this.lastKnown.set(task.id, record);
  }

  /** Remove a task from the queue entirely. */
  dequeue(id: string): boolean {
    return this.queue.delete(id);
  }

  /** Mark a task as started. Tracks per-agent workload. */
  start(id: string): void {
    const task = this.queue.get(id);
    if (!task) return;
    this.queue.delete(id);
    this.running.add(id);
    this.safePoints.delete(id);
    this.runningMeta.set(id, {
      lane: task.lane ?? 'development',
      principal: principalOf(task),
      priority: task.priority,
    });
    const principal = principalOf(task);
    this.runningPrincipals.set(principal, (this.runningPrincipals.get(principal) ?? 0) + 1);
    if (task.agentId) {
      this.workload.set(task.agentId, (this.workload.get(task.agentId) ?? 0) + 1);
    }
  }

  /** Mark a task as finished. Decrements per-agent workload. */
  finish(id: string): void {
    if (!this.running.delete(id)) return;
    this.done.add(id);
    this.releaseRunning(id);
    // Decrement workload for whichever agent ran this task; we track the
    // agent id alongside running ids to keep this exact.
    const agentId = this.runningAgents.get(id);
    this.runningAgents.delete(id);
    if (agentId !== undefined) {
      const next = (this.workload.get(agentId) ?? 1) - 1;
      if (next <= 0) this.workload.delete(agentId);
      else this.workload.set(agentId, next);
    }
  }

  private readonly runningAgents = new Map<string, string>();

  /** Convenience: start() while remembering the agent for finish(). */
  startOn(id: string, agentId: string): void {
    const task = this.queue.get(id);
    if (task) task.agentId = agentId;
    this.start(id);
    this.runningAgents.set(id, agentId);
  }

  /** Tasks currently running. */
  runningIds(): string[] {
    return [...this.running];
  }

  /** Tasks finished. */
  doneIds(): string[] {
    return [...this.done];
  }

  /**
   * Report that a running task has reached a safe point (a step/checkpoint
   * boundary where stopping loses no in-flight transaction), or that it
   * has left one. Only safe-point tasks are preemption candidates (§21.2).
   */
  markSafePoint(id: string, safe = true): void {
    if (!this.running.has(id)) return;
    if (safe) this.safePoints.add(id);
    else this.safePoints.delete(id);
  }

  /** Whether a running task is currently at a safe point. */
  isAtSafePoint(id: string): boolean {
    return this.safePoints.has(id);
  }

  /**
   * Evaluate the §21.2 P0 preemption opportunity without acting on it.
   *
   * Returns a directive when: no slot is free, a genuine P0 task is
   * queued and gate-passing, and a development-lane task is running at a
   * safe point, is not inside a protected transaction, and is not in its
   * post-preemption protection window. The victim is the lowest-priority
   * such task (oldest first on ties). Otherwise null.
   */
  evaluatePreemption(): PreemptionDirective | null {
    if (this.concurrencyLimit - this.running.size > 0) return null;
    return this.findPreemption();
  }

  /** The directive search itself, for callers (evaluateBatch) that have
   *  already established that no usable slot is free. */
  private findPreemption(): PreemptionDirective | null {
    const now = this.clock.now();
    const p0 = [...this.queue.values()]
      .filter((t) => t.priority === 'P0' && !this.done.has(t.id))
      .sort((a, b) => this.compareTasks(a, b, now))
      .find((t) => this.evaluateConstraints(t).length === 0);
    if (!p0) return null;

    const victims = [...this.running]
      .map((id) => ({ id, meta: this.runningMeta.get(id), task: this.lastKnown.get(id) }))
      .filter(
        (v) =>
          v.meta !== undefined &&
          v.task !== undefined &&
          v.meta.lane === 'development' &&
          v.meta.priority !== 'P0' &&
          this.safePoints.has(v.id) &&
          !(v.task.protectedFromPreemption ?? false) &&
          now >= (v.task.preemptProtectedUntil ?? 0),
      )
      .sort(
        (a, b) =>
          PRIORITY_RANK[b.meta!.priority] - PRIORITY_RANK[a.meta!.priority] ||
          (a.task!.seq - b.task!.seq),
      );
    const victim = victims[0];
    if (!victim) return null;
    return {
      preemptTaskId: victim.id,
      forTaskId: p0.id,
      reason:
        `P0 task ${p0.id} waits with no free slot; ${victim.id} ` +
        `(${victim.meta!.priority}) is at a safe point and preemptible`,
    };
  }

  /**
   * Carry out a preemption directive: the runner has stopped the victim
   * at its safe point. The victim returns to the queue with its original
   * sequence (migration protection: it resumes ahead of fresh work of its
   * class and cannot be preempted again during the protection window);
   * it is NOT marked done.
   */
  applyPreemption(directive: PreemptionDirective): void {
    const id = directive.preemptTaskId;
    const task = this.lastKnown.get(id);
    if (!this.running.has(id) || !task) {
      throw new Error(`cannot preempt ${id}: not running`);
    }
    if (!this.safePoints.has(id)) {
      throw new Error(`cannot preempt ${id}: not at a safe point`);
    }
    if (task.protectedFromPreemption) {
      throw new Error(`cannot preempt ${id}: protected transaction in progress`);
    }
    this.running.delete(id);
    this.releaseRunning(id);
    const agentId = this.runningAgents.get(id);
    this.runningAgents.delete(id);
    if (agentId !== undefined) {
      const next = (this.workload.get(agentId) ?? 1) - 1;
      if (next <= 0) this.workload.delete(agentId);
      else this.workload.set(agentId, next);
    } else if (task.agentId) {
      const next = (this.workload.get(task.agentId) ?? 1) - 1;
      if (next <= 0) this.workload.delete(task.agentId);
      else this.workload.set(task.agentId, next);
    }
    const requeued: QueuedTask = {
      ...task,
      preempted: true,
      preemptProtectedUntil: this.clock.now() + this.preemptionProtectionMs,
    };
    this.queue.set(id, requeued);
    this.lastKnown.set(id, requeued);
    this.recordDecision({
      at: this.clock.now(),
      kind: 'preemption-applied',
      summary: directive.reason,
      directive,
    });
  }

  /**
   * Select the next batch of tasks to start — full evaluation form.
   *
   * A task is selected only when every §21.1 hard constraint passes
   * (evaluateConstraints) and a slot is available for its lane. Tasks the
   * gate rejects are returned in `blocked` with every failed constraint;
   * development tasks refused solely because only Monitor/Recovery
   * reserved slots remain carry a 'reservedCapacity' failure (§21.2).
   * Plain slot exhaustion (total capacity full, no constraint failure)
   * is not reported as blocked — those tasks simply wait.
   *
   * `running` is accepted for callers that track running state
   * themselves; the scheduler's own running set is used when omitted.
   * Ids in an externally supplied running list whose lane is unknown are
   * counted against the development pool (conservative).
   */
  evaluateBatch(running?: string[]): BatchEvaluation {
    const now = this.clock.now();
    const runningSet = running ? new Set(running) : this.running;
    let totalFree = this.concurrencyLimit - runningSet.size;

    let runningDev = 0;
    for (const id of runningSet) {
      const lane = this.runningMeta.get(id)?.lane ?? 'development';
      if (lane === 'development') runningDev++;
    }
    let devFree = Math.max(0, this.concurrencyLimit - this.reservedSlots - runningDev);

    const candidates = [...this.queue.values()]
      .filter((t) => !runningSet.has(t.id) && !this.done.has(t.id))
      .sort((a, b) => this.compareTasks(a, b, now));

    const selected: string[] = [];
    const blocked: BlockedTask[] = [];
    const basis: Record<string, OrderingFactors> = {};

    for (const task of candidates) {
      const failures = this.evaluateConstraints(task);
      if (failures.length > 0) {
        blocked.push({ taskId: task.id, failures });
        basis[task.id] = this.orderingFactors(task, now);
        continue;
      }
      const lane = task.lane ?? 'development';
      if (lane === 'development') {
        if (devFree > 0 && totalFree > 0) {
          selected.push(task.id);
          devFree--;
          totalFree--;
          basis[task.id] = this.orderingFactors(task, now);
        } else if (totalFree > 0) {
          // §21.2: safety margin gone — refuse new development runs and
          // say so, instead of silently starving them.
          blocked.push({
            taskId: task.id,
            failures: [
              {
                constraint: 'reservedCapacity',
                reason:
                  'only Monitor/Recovery reserved slots remain; ' +
                  'new development runs are refused while the safety margin is consumed',
              },
            ],
          });
          basis[task.id] = this.orderingFactors(task, now);
        }
      } else if (totalFree > 0) {
        selected.push(task.id);
        totalFree--;
        basis[task.id] = this.orderingFactors(task, now);
      }
    }

    const evaluation: BatchEvaluation = {
      selected,
      blocked,
      preemption: totalFree <= 0 ? this.findPreemption() : null,
      basis,
      at: now,
    };
    this.recordDecision({
      at: now,
      kind: 'batch',
      summary:
        `selected [${selected.join(', ')}]; blocked ${blocked.length}; ` +
        `preemption ${evaluation.preemption ? evaluation.preemption.preemptTaskId : 'none'}`,
      selected,
      blocked,
      basis,
    });
    return evaluation;
  }

  /**
   * Select the next batch of tasks to start (the §93 projection of
   * evaluateBatch — same selections, ids only).
   *
   * - Skips tasks already running or done.
   * - Skips tasks whose hard constraints fail (dependency included).
   * - Orders by effective priority (aging applied), then severity, SLA
   *   deadline, critical path, risk, agent load, fairness, FIFO.
   * - Respects the concurrency limit and the Monitor/Recovery reserve.
   */
  nextBatch(running?: string[]): string[] {
    return this.evaluateBatch(running).selected;
  }

  /**
   * The §21.1 gate for one task: every failed hard constraint with its
   * reason, in spec order. An empty array means dispatchable as far as
   * the gate is concerned (slots are a separate question).
   *
   * Per constraint, the verdict source is, in precedence order:
   *  1. a configured checker (live fact),
   *  2. the caller's attestation on the task (`constraints`),
   *  3. pass — unless requireAllConstraints, where "not evaluated"
   *     fails closed.
   * Dependency is always evaluated from the scheduler's own done-set.
   * Authority is additionally evaluated from the live authority rules
   * (the same check enqueue applies).
   */
  evaluateConstraints(task: SchedulableTask): ConstraintFailure[] {
    const failures: ConstraintFailure[] = [];
    for (const constraint of HARD_CONSTRAINTS) {
      if (constraint === 'dependency') {
        const unmet = task.dependsOn.filter((d) => !this.done.has(d));
        if (unmet.length > 0) {
          failures.push({
            constraint,
            reason: `dependencies not done: ${unmet.join(', ')}`,
          });
        }
        continue;
      }
      if (constraint === 'authority') {
        const problem = this.authorityProblem(task);
        if (problem !== null) {
          failures.push({ constraint, reason: problem });
          continue;
        }
      }
      const checker = this.constraintCheckers?.[constraint];
      if (checker) {
        const reason = checker(task);
        if (reason !== null) failures.push({ constraint, reason });
        continue;
      }
      const attested = task.constraints?.[constraint];
      if (attested === false) {
        failures.push({ constraint, reason: 'caller attested this constraint is not satisfied' });
      } else if (attested === undefined && this.requireAllConstraints) {
        failures.push({ constraint, reason: 'not evaluated (strict gate mode)' });
      }
    }
    return failures;
  }

  /** Per-agent workload: how many tasks the agent currently has active. */
  getWorkload(agentId: string): AgentWorkload {
    return { agentId, activeCount: this.workload.get(agentId) ?? 0 };
  }

  /** Snapshot of all tracked workloads. */
  allWorkloads(): AgentWorkload[] {
    return [...this.workload.entries()].map(([agentId, activeCount]) => ({
      agentId,
      activeCount,
    }));
  }

  /** The bounded decision log, oldest first (cloned). */
  decisionLog(): DecisionEntry[] {
    return this.decisions.map((d) => ({
      ...d,
      selected: d.selected ? [...d.selected] : undefined,
      blocked: d.blocked
        ? d.blocked.map((b) => ({ ...b, failures: b.failures.map((f) => ({ ...f })) }))
        : undefined,
      basis: d.basis ? { ...d.basis } : undefined,
      directive: d.directive ? { ...d.directive } : undefined,
    }));
  }

  /** Wall-clock hook (injectable clock) — reserved for time-based policies. */
  time(): number {
    return this.clock.now();
  }

  /* ------------------------------------------------------------ */

  /** Last-known full record of every task ever enqueued (for preemption
   *  bookkeeping after a task leaves the queue by starting). */
  private readonly lastKnown = new Map<string, QueuedTask>();

  private authorityProblem(task: SchedulableTask): string | null {
    if (task.authority !== undefined) {
      const principal = task.authority.principal;
      if (typeof principal !== 'string' || principal.trim() === '') {
        return 'authority principal must be a non-empty string';
      }
    } else if (this.requireAuthority) {
      return 'task carries no authority (requireAuthority is on)';
    }
    if (this.authorityValidator) {
      const reason = this.authorityValidator(task);
      if (reason !== null) return reason;
    }
    return null;
  }

  /** Priority rank after the §21.2 aging boost. */
  private effectiveRank(task: QueuedTask, now: number): number {
    const rank = PRIORITY_RANK[task.priority];
    if (!this.aging) return rank;
    const waited = Math.max(0, now - task.enqueuedAt);
    const boost = Math.min(
      this.aging.maxBoostLevels,
      Math.floor(waited / this.aging.intervalMs),
    );
    return Math.max(0, rank - boost);
  }

  private orderingFactors(task: QueuedTask, now: number): OrderingFactors {
    return {
      priority: task.priority,
      effectiveRank: this.effectiveRank(task, now),
      severity: task.severity ?? 0,
      slaDeadline: task.slaDeadline ?? null,
      criticalPathLength: task.criticalPathLength ?? 0,
      risk: task.risk ?? 0,
      agentLoad: task.agentId ? (this.workload.get(task.agentId) ?? 0) : 0,
      principalRunning: this.runningPrincipals.get(principalOf(task)) ?? 0,
      preempted: task.preempted,
    };
  }

  /**
   * Deterministic multi-factor ordering (§21.1 queueing factors; the
   * spec names the factors — the direction for risk is the documented
   * local policy on the field). Lexicographic:
   *   1. effective priority rank (aging applied), ascending
   *   2. preempted tasks first (migration protection: resume promptly)
   *   3. severity, descending
   *   4. SLA deadline, ascending (no deadline = last)
   *   5. critical path length, descending
   *   6. risk, descending
   *   7. pinned agent's current load, ascending (used capacity)
   *   8. fairness: principal's running count, ascending
   *   9. enqueue sequence, ascending (FIFO)
   */
  private compareTasks(a: QueuedTask, b: QueuedTask, now: number): number {
    const fa = this.orderingFactors(a, now);
    const fb = this.orderingFactors(b, now);
    return (
      fa.effectiveRank - fb.effectiveRank ||
      Number(fb.preempted) - Number(fa.preempted) ||
      fb.severity - fa.severity ||
      (fa.slaDeadline ?? Number.POSITIVE_INFINITY) -
        (fb.slaDeadline ?? Number.POSITIVE_INFINITY) ||
      fb.criticalPathLength - fa.criticalPathLength ||
      fb.risk - fa.risk ||
      fa.agentLoad - fb.agentLoad ||
      fa.principalRunning - fb.principalRunning ||
      a.seq - b.seq
    );
  }

  private releaseRunning(id: string): void {
    const meta = this.runningMeta.get(id);
    if (meta) {
      const next = (this.runningPrincipals.get(meta.principal) ?? 1) - 1;
      if (next <= 0) this.runningPrincipals.delete(meta.principal);
      else this.runningPrincipals.set(meta.principal, next);
      this.runningMeta.delete(id);
    }
    this.safePoints.delete(id);
  }

  private recordDecision(entry: DecisionEntry): void {
    this.decisions.push(entry);
    while (this.decisions.length > this.decisionLogLimit) this.decisions.shift();
  }
}

/** The principal a task counts under for fairness: its authority when
 *  present, else its pinned agent, else a shared unassigned bucket. */
function principalOf(task: SchedulableTask): string {
  return task.authority?.principal ?? task.agentId ?? '(unassigned)';
}

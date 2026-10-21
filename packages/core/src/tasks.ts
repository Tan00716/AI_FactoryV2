/**
 * Task system — spec §8 (Task object) + §60 (dependency graph).
 * Pure in-memory implementation; @ai-factory/db provides the SQLite backing.
 */

import { randomUUID } from 'crypto';
import {
  DependencyKind,
  Task,
  TaskAuthorizationStatus,
  TaskDependency,
  TaskEditScope,
  TaskStatus,
  nowIso,
} from './types';
import {
  ScopeViolationError,
  budgetOverflow,
  ceilingOverflow,
  resolveInheritedAuthorization,
  resolveInheritedEditScope,
  rootOfTask,
  type ScopeViolation,
} from './scope';

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task ${id} not found`);
    this.name = 'TaskNotFoundError';
  }
}

/**
 * §17.2 — an authorization transition was attempted from a state the
 * dispatch flow does not allow (e.g. dispatching a task that is not
 * WAITING_HUMAN_DISPATCH). Carries the observed state so callers can
 * surface it verbatim instead of re-reading the task.
 */
export class TaskAuthorizationError extends Error {
  readonly taskId: string;
  readonly from: TaskAuthorizationStatus;
  readonly action: string;
  constructor(taskId: string, from: TaskAuthorizationStatus, action: string, requires: string) {
    super(
      `Cannot ${action} task ${taskId}: authorization_status is ${from} (requires ${requires})`,
    );
    this.name = 'TaskAuthorizationError';
    this.taskId = taskId;
    this.from = from;
    this.action = action;
  }
}

/**
 * §17.2 — the task's effective authorization status. Tasks persisted
 * before the field existed carry no value; they are AUTHORIZED, which
 * is the behaviour they always had (nothing gated on authorization
 * before this axis existed, and a stored row must not silently become
 * un-executable because a column was added).
 */
export function effectiveAuthorizationStatus(t: Task): TaskAuthorizationStatus {
  return t.authorizationStatus ?? 'AUTHORIZED';
}

export class TaskDependencyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TaskDependencyError';
  }
}

export interface TaskStore {
  save(t: Task): void;
  get(id: string): Task | undefined;
  list(): Task[];
  listByProject(projectId: string): Task[];
}

export class InMemoryTaskStore implements TaskStore {
  private map = new Map<string, Task>();
  save(t: Task): void {
    this.map.set(t.id, structuredClone(t));
  }
  get(id: string): Task | undefined {
    const t = this.map.get(id);
    return t ? structuredClone(t) : undefined;
  }
  list(): Task[] {
    return [...this.map.values()].map((t) => structuredClone(t));
  }
  listByProject(projectId: string): Task[] {
    return this.list().filter((t) => t.projectId === projectId);
  }
}

/** §17.2 — the states a task may be created into (never REVOKED/EXPIRED). */
export type InitialTaskAuthorizationStatus = 'DRAFT' | 'WAITING_HUMAN_DISPATCH' | 'AUTHORIZED';

/**
 * §17.2 / INV-07 — input for filing an AI discovery as a ticket.
 * "普通发现可创建待派工票据": evidence is mandatory ("附证据"),
 * classification + priority travel with the ticket for triage.
 */
export interface ReportFindingInput {
  projectId: string;
  title: string;
  /** At least one evidence ref — §17.2 requires evidence on a discovery ticket. */
  evidenceRefs: string[];
  /** Triage classification, e.g. 'BUG' | 'RISK' | 'IMPROVEMENT'. */
  classification?: string;
  priority?: Task['priority'];
  severity?: Task['severity'];
  description?: string;
  /** The discovering agent; defaults to 'agent'. */
  reporter?: string;
  requirementRef?: string;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  goal?: string;
  description?: string;
  priority?: Task['priority'];
  severity?: Task['severity'];
  acceptanceCriteria?: string[];
  constraints?: string[];
  workspace?: string;
  creator?: string;
  parentTaskId?: string | null;
  risk?: Task['risk'];
  /**
   * §17.2 — initial authorization state. Defaults to 'AUTHORIZED':
   * §17.2 allows a human creating a task manually to dispatch it at
   * creation, and every pre-existing caller created tasks that were
   * immediately executable. Callers filing work that must wait for a
   * Human Dispatch (e.g. an AI-discovered problem, §17.2) pass
   * 'WAITING_HUMAN_DISPATCH' (a TODO awaiting dispatch) or 'DRAFT'
   * (not yet submitted).
   */
  authorizationStatus?: InitialTaskAuthorizationStatus;
  /**
   * §17.4 (Batch 18) — task-level requirement pin ('REQ-001@2'),
   * policy ceiling (scope tokens) and budget envelope. On create()
   * these are simply recorded; on createSubtask() they default to
   * the ROOT's values and may only narrow them (see scope.ts).
   */
  requirementRef?: string;
  policyCeiling?: string[];
  budgetEnvelope?: Record<string, number>;
  /** §17.4 (Batch 18) — how a subtask serves its parent's goal. */
  parentRelation?: string;
  /**
   * 第二轮加强（item 8）—— task-level edit scope. Recorded verbatim
   * (defensive copy) when supplied; on createSubtask() it defaults to
   * the ROOT's scope and a supplied value may only NARROW it at the
   * pattern-string level (include ⊆ root include, exclude ⊇ root
   * exclude — a conservative, pattern-set check, not semantic glob
   * inclusion; see scope.ts resolveInheritedEditScope).
   */
  scope?: TaskEditScope;
  /**
   * §17.2 — evidence refs backing the ticket ("附证据"). Recorded on
   * the task when supplied; absent stays absent.
   */
  evidenceRefs?: string[];
}

const DEFAULT_WORKSPACE = 'C:\\AIProjects\\MyApp';

export class TaskManager {
  constructor(private store: TaskStore = new InMemoryTaskStore()) {}

  /** §8 — create a task; it always starts in TODO (§11). */
  create(input: CreateTaskInput): Task {
    if (!input.title?.trim()) throw new TaskDependencyError('Task title is required');
    const t: Task = {
      id: randomUUID(),
      projectId: input.projectId,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title.trim(),
      goal: input.goal ?? '',
      description: input.description ?? '',
      priority: input.priority ?? 'P2',
      severity: input.severity ?? 'MAJOR',
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      constraints: input.constraints ?? [],
      workspace: input.workspace ?? DEFAULT_WORKSPACE,
      creator: input.creator ?? 'human',
      authorizationStatus: input.authorizationStatus ?? 'AUTHORIZED',
      // §17.4 (Batch 18) — recorded only when the caller supplied
      // them; absent stays absent (never an invented pin/ceiling/
      // envelope). Arrays/maps are copied so later caller mutation
      // cannot rewrite the stored task.
      ...(input.requirementRef !== undefined
        ? { requirementRef: input.requirementRef }
        : {}),
      ...(input.policyCeiling !== undefined
        ? { policyCeiling: [...input.policyCeiling] }
        : {}),
      ...(input.budgetEnvelope !== undefined
        ? { budgetEnvelope: { ...input.budgetEnvelope } }
        : {}),
      ...(input.parentRelation !== undefined
        ? { parentRelation: input.parentRelation }
        : {}),
      // 第二轮加强（item 8）—— edit scope, defensive-copied like the
      // ceiling/envelope; absent stays absent.
      ...(input.scope !== undefined
        ? {
            scope: {
              ...(input.scope.include !== undefined
                ? { include: [...input.scope.include] }
                : {}),
              ...(input.scope.exclude !== undefined
                ? { exclude: [...input.scope.exclude] }
                : {}),
            },
          }
        : {}),
      ...(input.evidenceRefs !== undefined ? { evidenceRefs: [...input.evidenceRefs] } : {}),
      status: 'TODO',
      currentAgentId: null,
      assignedAgentIds: [],
      subtaskIds: [],
      dependencies: [],
      risk: input.risk ?? 'MEDIUM',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null,
    };
    this.store.save(t);
    if (t.parentTaskId) {
      const parent = this.get(t.parentTaskId);
      parent.subtaskIds.push(t.id);
      this.store.save(parent);
    }
    return this.get(t.id);
  }

  /** The root task of a task (topmost ancestor; see rootOfTask). */
  rootOf(taskId: string): Task {
    return rootOfTask((id) => this.store.get(id), this.get(taskId));
  }

  /**
   * §8/#95 + §17.4 (Batch 18) — create a subtask linked to a parent,
   * inheriting from the ROOT task (the topmost ancestor — §17.4 says
   * root, so a grandchild inherits the root's facts, not whichever
   * intermediate parent happens to be nearest):
   *  - authorization: the root's status when unspecified (verbatim,
   *    including REVOKED/EXPIRED — filed dead, never resurrected);
   *    an explicit request broader than the root's is refused with
   *    ScopeViolationError (a subtask must not be wider than its
   *    root). The inherited state may be REVOKED/EXPIRED, which
   *    create()'s initial-state type does not admit — inheritance
   *    writes it directly after creation, below.
   *  - requirement version / 相关 AC / policy ceiling / budget
   *    envelope: the root's values when unspecified; a supplied
   *    ceiling must be a subset of the root's and a supplied
   *    envelope must narrow the root's dimension by dimension,
   *    else ScopeViolationError (§12.2's subset rule). A supplied
   *    requirement pin may diverge — that is a caller decision the
   *    Scope Checker flags (scope.ts), not a creation error.
   *  - the parent relation (§17.4) is recorded when supplied.
   * Constraints are NOT inherited — §17.4's list does not name them.
   */
  createSubtask(parentId: string, input: Omit<CreateTaskInput, 'parentTaskId' | 'projectId'>): Task {
    const parent = this.get(parentId);
    const root = this.rootOf(parentId);
    const violations: ScopeViolation[] = [];

    const auth = resolveInheritedAuthorization(
      effectiveAuthorizationStatus(root),
      input.authorizationStatus,
    );
    if ('violation' in auth) violations.push(auth.violation);

    let policyCeiling = input.policyCeiling;
    if (policyCeiling === undefined) {
      policyCeiling = root.policyCeiling;
    } else if (root.policyCeiling !== undefined) {
      for (const token of ceilingOverflow(policyCeiling, root.policyCeiling)) {
        violations.push({
          kind: 'POLICY_CEILING',
          detail:
            `proposed policy ceiling token '${token}' is wider than the root's ceiling`,
          item: token,
        });
      }
    }

    let budgetEnvelope = input.budgetEnvelope;
    if (budgetEnvelope === undefined) {
      budgetEnvelope = root.budgetEnvelope;
    } else if (root.budgetEnvelope !== undefined) {
      for (const o of budgetOverflow(budgetEnvelope, root.budgetEnvelope)) {
        violations.push({
          kind: 'BUDGET',
          detail:
            `budget dimension '${o.dimension}' asks ${o.requested} but the root's envelope caps it at ${o.cap}`,
          item: o.dimension,
        });
      }
    }

    // 第二轮加强（item 8）—— the edit scope inherits from the ROOT
    // like the ceiling/envelope: unspecified → the root's verbatim; a
    // supplied value may only narrow it (pattern-string level).
    const scopeResolution = resolveInheritedEditScope(root.scope, input.scope);
    if ('violation' in scopeResolution) violations.push(scopeResolution.violation);
    const editScope = 'violation' in scopeResolution ? undefined : scopeResolution.scope;

    if (violations.length > 0) throw new ScopeViolationError(root.id, violations);

    const inheritedStatus = (
      'status' in auth ? auth.status : 'AUTHORIZED'
    ) as TaskAuthorizationStatus;
    const sub = this.create({
      ...input,
      projectId: parent.projectId,
      parentTaskId: parentId,
      // Initial-state type admits only the live states; a dead
      // inherited state is applied verbatim right after creation.
      authorizationStatus: (
        inheritedStatus === 'REVOKED' || inheritedStatus === 'EXPIRED'
          ? 'AUTHORIZED'
          : inheritedStatus
      ) as InitialTaskAuthorizationStatus,
      requirementRef: input.requirementRef ?? root.requirementRef,
      acceptanceCriteria: input.acceptanceCriteria ?? [...root.acceptanceCriteria],
      policyCeiling,
      budgetEnvelope,
      scope: editScope,
    });
    if (inheritedStatus === 'REVOKED' || inheritedStatus === 'EXPIRED') {
      const t = this.get(sub.id);
      t.authorizationStatus = inheritedStatus;
      this.store.save(t);
      return t;
    }
    return sub;
  }

  /**
   * §60 — add a dependency edge. Rejects self-dependency and cycles
   * (a depends_on/blocked_by/child_of cycle would deadlock the scheduler).
   */
  addDependency(taskId: string, kind: DependencyKind, otherId: string): Task {
    if (taskId === otherId) {
      throw new TaskDependencyError('A task cannot depend on itself');
    }
    const task = this.get(taskId);
    this.get(otherId); // must exist
    const cycleKinds: DependencyKind[] = ['depends_on', 'blocked_by', 'child_of'];
    if (cycleKinds.includes(kind) && this.reaches(otherId, taskId, cycleKinds)) {
      throw new TaskDependencyError(
        `Adding ${kind} ${taskId} → ${otherId} would create a dependency cycle`,
      );
    }
    if (!task.dependencies.some((d) => d.kind === kind && d.taskId === otherId)) {
      task.dependencies.push({ kind, taskId: otherId } satisfies TaskDependency);
      task.updatedAt = nowIso();
      this.store.save(task);
    }
    return this.get(taskId);
  }

  /** Depth-first reachability over ordering dependency kinds. */
  private reaches(from: string, target: string, kinds: DependencyKind[]): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const t = this.store.get(cur);
      if (!t) continue;
      for (const d of t.dependencies) {
        if (kinds.includes(d.kind)) stack.push(d.taskId);
      }
    }
    return false;
  }

  assignAgent(taskId: string, agentId: string, makeCurrent = true): Task {
    const t = this.get(taskId);
    if (!t.assignedAgentIds.includes(agentId)) t.assignedAgentIds.push(agentId);
    if (makeCurrent) t.currentAgentId = agentId;
    t.updatedAt = nowIso();
    this.store.save(t);
    return this.get(taskId);
  }

  /**
   * §17.2 — authorization state machine. The flow is the spec's:
   * DRAFT → WAITING_HUMAN_DISPATCH → AUTHORIZED, plus dispatch
   * rejection back to DRAFT and the spec's two remaining values
   * REVOKED / EXPIRED. The spec defines no path out of REVOKED or
   * EXPIRED, so none is offered here. Every method validates the
   * current state and throws TaskAuthorizationError otherwise — an
   * authorization change is never a silent field write. Auditing is
   * the caller's layer (this manager has no audit dependency); the
   * HTTP routes record one event per action.
   */
  private transitionAuthorization(
    taskId: string,
    action: string,
    from: TaskAuthorizationStatus[],
    to: TaskAuthorizationStatus,
  ): Task {
    const t = this.get(taskId);
    const current = effectiveAuthorizationStatus(t);
    if (!from.includes(current)) {
      throw new TaskAuthorizationError(taskId, current, action, from.join(' | '));
    }
    t.authorizationStatus = to;
    t.updatedAt = nowIso();
    this.store.save(t);
    return t;
  }

  /** §17.2 — submit a DRAFT task for Human Dispatch. */
  requestDispatch(taskId: string): Task {
    this.transitionAuthorization(taskId, 'request dispatch for', ['DRAFT'], 'WAITING_HUMAN_DISPATCH');
    return this.get(taskId);
  }

  /**
   * §17.2 / INV-07 — the fixed entry point for an AI-filed discovery:
   * "AI 自己发现普通问题必须建立 TODO、附证据、分类与优先级，等待
   * Human Dispatch". A finding becomes a TODO ticket that is
   * WAITING_HUMAN_DISPATCH — it can never be created already
   * authorized, so a discovery can never silently start a run. At
   * least one evidence ref is required ("附证据"); the classification
   * is recorded as a constraint token for triage. The returned ticket
   * flows through the normal requestDispatch → dispatch chain.
   */
  reportFinding(input: ReportFindingInput): Task {
    if (!input.title?.trim()) throw new TaskDependencyError('Task title is required');
    if (!input.evidenceRefs || input.evidenceRefs.length === 0) {
      throw new TaskDependencyError(
        'reportFinding requires at least one evidence ref (§17.2 "附证据")',
      );
    }
    return this.create({
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      priority: input.priority,
      severity: input.severity,
      creator: input.reporter ?? 'agent',
      authorizationStatus: 'WAITING_HUMAN_DISPATCH',
      requirementRef: input.requirementRef,
      evidenceRefs: input.evidenceRefs,
      constraints:
        input.classification !== undefined
          ? [`finding-classification:${input.classification}`]
          : undefined,
    });
  }

  /**
   * §17.2 — Human Dispatch: authorize a waiting task for execution.
   * Optionally assigns the executor in the same action (the human
   * dispatching the work names who picks it up). Only a task that is
   * WAITING_HUMAN_DISPATCH can be dispatched — a DRAFT must be
   * submitted first, so the waiting state is never skipped silently.
   */
  dispatch(taskId: string, opts?: { assigneeAgentId?: string }): Task {
    this.transitionAuthorization(taskId, 'dispatch', ['WAITING_HUMAN_DISPATCH'], 'AUTHORIZED');
    if (opts?.assigneeAgentId) {
      return this.assignAgent(taskId, opts.assigneeAgentId);
    }
    return this.get(taskId);
  }

  /** §17.2 — dispatch refused: the task returns to DRAFT for revision. */
  rejectDispatch(taskId: string): Task {
    this.transitionAuthorization(taskId, 'reject dispatch for', ['WAITING_HUMAN_DISPATCH'], 'DRAFT');
    return this.get(taskId);
  }

  /** §17.2 — withdraw an authorization previously granted. */
  revokeAuthorization(taskId: string): Task {
    this.transitionAuthorization(taskId, 'revoke authorization of', ['AUTHORIZED'], 'REVOKED');
    return this.get(taskId);
  }

  /** §17.2 — mark an authorization lapsed (no automatic TTL exists in the spec; this is the explicit action). */
  expireAuthorization(taskId: string): Task {
    this.transitionAuthorization(
      taskId,
      'expire authorization of',
      ['AUTHORIZED', 'WAITING_HUMAN_DISPATCH'],
      'EXPIRED',
    );
    return this.get(taskId);
  }

  /** Engine-only status write; all validation happens in the workflow engine. */
  setStatus(taskId: string, status: TaskStatus): Task {
    const t = this.get(taskId);
    t.status = status;
    t.updatedAt = nowIso();
    if (status === 'DONE') t.completedAt = nowIso();
    this.store.save(t);
    return this.get(taskId);
  }

  /**
   * 第二轮加强（item 8）—— set or clear the task's edit scope.
   * `undefined` removes the field entirely (unrestricted, same as a
   * task that never had one); an object replaces the scope verbatim
   * (defensive copy). Validation of the glob patterns happens at the
   * API layer (scope-lock validation) — the manager records what the
   * route admitted.
   */
  setScope(taskId: string, scope: TaskEditScope | undefined): Task {
    const t = this.get(taskId);
    if (scope === undefined) {
      delete t.scope;
    } else {
      t.scope = {
        ...(scope.include !== undefined ? { include: [...scope.include] } : {}),
        ...(scope.exclude !== undefined ? { exclude: [...scope.exclude] } : {}),
      };
    }
    t.updatedAt = nowIso();
    this.store.save(t);
    return this.get(taskId);
  }

  get(id: string): Task {
    const t = this.store.get(id);
    if (!t) throw new TaskNotFoundError(id);
    return t;
  }

  listByProject(projectId: string): Task[] {
    return this.store.listByProject(projectId);
  }

  list(): Task[] {
    return this.store.list();
  }
}

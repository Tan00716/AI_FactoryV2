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
  TaskStatus,
  nowIso,
} from './types';

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

  /** §8/#95 — create a subtask linked to a parent. */
  createSubtask(parentId: string, input: Omit<CreateTaskInput, 'parentTaskId' | 'projectId'>): Task {
    const parent = this.get(parentId);
    return this.create({ ...input, projectId: parent.projectId, parentTaskId: parentId });
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

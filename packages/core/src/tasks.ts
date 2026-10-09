/**
 * Task system — spec §8 (Task object) + §60 (dependency graph).
 * Pure in-memory implementation; @ai-factory/db provides the SQLite backing.
 */

import { randomUUID } from 'crypto';
import {
  DependencyKind,
  Task,
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

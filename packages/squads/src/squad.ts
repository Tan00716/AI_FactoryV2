/**
 * Task squads — spec §20 (Persistent Organization vs Task Squad).
 *
 * Two different concepts:
 *  - Persistent organization: long-lived roles (PM, Tech Lead, DevOps, QA
 *    Lead). Lives in the OrganizationDesigner graph (org-designer.ts) and
 *    the core AgentRegistry.
 *  - Task squad: TEMPORARY. Assembled per task from the agent pool based on
 *    task complexity, archived when the task is done. Archiving returns
 *    members to the pool — pure bookkeeping here, the SquadManager never
 *    mutates the registry (no status flips, no deletion).
 */

import { randomUUID } from 'crypto';

/** Injectable clock for deterministic timestamps. */
export interface Clock {
  now: () => number;
}

export interface TaskSquad {
  id: string;
  taskId: string;
  memberIds: string[];
  createdAt: string;
  archivedAt: string | null;
  status: 'active' | 'archived';
}

export class SquadError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SquadError';
  }
}

export interface AssembleOptions {
  maxMembers?: number;
  clock?: Clock;
}

/**
 * Manages temporary task squads (§20). One active squad per task; archived
 * squads are kept for history. Members "return to the pool" on archive
 * simply by no longer being claimed by an active squad.
 */
export class SquadManager {
  private active = new Map<string, TaskSquad>(); // taskId -> squad
  private archived: TaskSquad[] = [];

  private stamp(clock?: Clock): string {
    return new Date((clock ?? { now: () => Date.now() }).now()).toISOString();
  }

  /** Assemble a temporary squad for a task. */
  assemble(taskId: string, candidateIds: string[], opts: AssembleOptions = {}): TaskSquad {
    if (!taskId?.trim()) throw new SquadError('taskId is required');
    if (this.active.has(taskId)) {
      throw new SquadError(`task ${taskId} already has an active squad`);
    }
    const members = [...new Set(candidateIds)];
    if (members.length === 0) throw new SquadError('squad needs at least one member');
    const capped =
      opts.maxMembers !== undefined ? members.slice(0, opts.maxMembers) : members;
    if (capped.length === 0) throw new SquadError('squad needs at least one member');

    const squad: TaskSquad = {
      id: randomUUID(),
      taskId,
      memberIds: capped,
      createdAt: this.stamp(opts.clock),
      archivedAt: null,
      status: 'active',
    };
    this.active.set(taskId, squad);
    return { ...squad, memberIds: [...squad.memberIds] };
  }

  /** Add a member to an active squad. */
  addMember(taskId: string, agentId: string): TaskSquad {
    const squad = this.active.get(taskId);
    if (!squad) throw new SquadError(`no active squad for task ${taskId}`);
    if (!squad.memberIds.includes(agentId)) squad.memberIds.push(agentId);
    return this.snapshot(squad);
  }

  /** Remove a member from an active squad (no-op if not a member). */
  removeMember(taskId: string, agentId: string): TaskSquad {
    const squad = this.active.get(taskId);
    if (!squad) throw new SquadError(`no active squad for task ${taskId}`);
    squad.memberIds = squad.memberIds.filter((m) => m !== agentId);
    return this.snapshot(squad);
  }

  /**
   * Archive the squad when the task is done. Members return to the pool:
   * they are simply no longer claimed by any active squad. This is pure
   * bookkeeping — the agent registry is NOT mutated.
   */
  archive(taskId: string, opts: { clock?: Clock } = {}): TaskSquad {
    const squad = this.active.get(taskId);
    if (!squad) throw new SquadError(`no active squad for task ${taskId}`);
    squad.status = 'archived';
    squad.archivedAt = this.stamp(opts.clock);
    this.active.delete(taskId);
    this.archived.push(squad);
    return this.snapshot(squad);
  }

  /** Currently active (non-archived) squads. */
  listActive(): TaskSquad[] {
    return [...this.active.values()].map((s) => this.snapshot(s));
  }

  /** History of archived squads. */
  listArchived(): TaskSquad[] {
    return this.archived.map((s) => this.snapshot(s));
  }

  /** Agent ids currently claimed by active squads. */
  claimedMembers(): string[] {
    return [...new Set([...this.active.values()].flatMap((s) => s.memberIds))];
  }

  private snapshot(s: TaskSquad): TaskSquad {
    return { ...s, memberIds: [...s.memberIds] };
  }
}

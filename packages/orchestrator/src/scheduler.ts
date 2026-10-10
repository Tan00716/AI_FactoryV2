/**
 * Scheduler — spec §93.
 *
 * Decides which tasks run when: priority ordering, dependency gating,
 * concurrency limits, and per-agent workload tracking.
 *
 * All scheduling policy is code (deterministic), per the §92 rule that
 * scheduling must never be owned by an LLM. The only AI-adjacent input is
 * the priority assigned upstream — once assigned, ordering is pure.
 */

export type SchedulerPriority = 'P0' | 'P1' | 'P2' | 'P3';

/** §93: P0 Production Incident → P1 Critical Bug → P2 Normal Task → P3 Enhancement. */
const PRIORITY_RANK: Record<SchedulerPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export interface SchedulableTask {
  id: string;
  priority: SchedulerPriority;
  /** Task ids that must be in `done` before this task is eligible. */
  dependsOn: string[];
  /** Agent this task is pinned to (optional). */
  agentId?: string;
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
}

interface QueuedTask extends SchedulableTask {
  /** Monotonic sequence so FIFO breaks priority ties deterministically. */
  seq: number;
}

export class Scheduler {
  private readonly concurrencyLimit: number;
  private readonly clock: Clock;
  private readonly queue = new Map<string, QueuedTask>();
  private readonly running = new Set<string>();
  private readonly done = new Set<string>();
  private readonly workload = new Map<string, number>();
  private seq = 0;

  constructor(options: SchedulerOptions = {}) {
    this.concurrencyLimit = options.concurrencyLimit ?? 4;
    this.clock = options.clock ?? defaultClock;
  }

  /** Add (or re-add) a task to the pending queue. */
  enqueue(task: SchedulableTask): void {
    this.queue.set(task.id, { ...task, seq: this.seq++ });
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
    if (task.agentId) {
      this.workload.set(task.agentId, (this.workload.get(task.agentId) ?? 0) + 1);
    }
  }

  /** Mark a task as finished. Decrements per-agent workload. */
  finish(id: string): void {
    if (!this.running.delete(id)) return;
    this.done.add(id);
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
   * Select the next batch of tasks to start.
   *
   * - Skips tasks already running or done.
   * - Skips tasks whose `dependsOn` ids are not all done (dependency-aware).
   * - Orders by priority (P0 → P3), then FIFO enqueue order.
   * - Respects the concurrency limit: returns at most
   *   `concurrencyLimit - running.length` ids.
   *
   * `running` is accepted for callers that track running state themselves;
   * the scheduler's own running set is used when omitted.
   */
  nextBatch(running?: string[]): string[] {
    const runningSet = running ? new Set(running) : this.running;
    const freeSlots = this.concurrencyLimit - runningSet.size;
    if (freeSlots <= 0) return [];

    const eligible = [...this.queue.values()]
      .filter((t) => !runningSet.has(t.id) && !this.done.has(t.id))
      .filter((t) => t.dependsOn.every((d) => this.done.has(d)))
      .sort((a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.seq - b.seq,
      );

    return eligible.slice(0, freeSlots).map((t) => t.id);
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

  /** Wall-clock hook (injectable clock) — reserved for time-based policies. */
  time(): number {
    return this.clock.now();
  }
}

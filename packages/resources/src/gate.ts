/**
 * ConcurrencyGate — limits simultaneously running agents (§79, §93).
 *
 * acquire() returns a promise that resolves with a release() function once
 * the agent holds a slot. When the gate is full, waiters queue FIFO; a
 * higher-priority task (§93: P0 production incident … P4 research) jumps
 * ahead in the queue — the gate itself only reorders the waiting line.
 *
 * §21.2 preemption note (G-33): SPEC_V2 §21.2 requires that a P0 may
 * preempt development resources AT A SAFE POINT. That decision lives in
 * the Scheduler (packages/orchestrator), which issues a preemption
 * directive; the runner stops the preempted agent at its safe point and
 * calls this gate's release(). The gate never forcibly evicts a holder —
 * it cannot know where safe points are — so the earlier blanket claim
 * that preemption "never" happens was wrong at the system level and has
 * been removed: preemption happens, one layer up, never mid-transaction.
 *
 * Pair with BudgetTracker.recordAgents() to also enforce the per-task
 * maxConcurrentAgents budget dimension.
 */

import { PRIORITY_RANK, TaskPriority } from './types';

export interface GateStats {
  limit: number;
  inUse: number;
  queued: number;
  waiting: Array<{ agentId: string; priority: TaskPriority }>;
}

interface Waiter {
  agentId: string;
  priority: TaskPriority;
  seq: number;
  resolve: (release: () => void) => void;
}

export class ConcurrencyGate {
  private readonly running = new Set<string>();
  private readonly queue: Waiter[] = [];
  private seq = 0;

  constructor(private readonly limit: number) {
    if (limit <= 0) throw new Error('concurrency limit must be positive');
  }

  get inUse(): number {
    return this.running.size;
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Queue depth and the waiting line, priority-ordered. */
  stats(): GateStats {
    this.sortQueue();
    return {
      limit: this.limit,
      inUse: this.running.size,
      queued: this.queue.length,
      waiting: this.queue.map((w) => ({ agentId: w.agentId, priority: w.priority })),
    };
  }

  /**
   * Take a slot. Resolves immediately when a slot is free and nobody is
   * waiting; otherwise the agent queues. Resolved value is the release()
   * function that must be called when the agent finishes.
   */
  acquire(agentId: string, priority: TaskPriority = 'P2'): Promise<() => void> {
    if (this.running.size < this.limit && this.queue.length === 0) {
      this.running.add(agentId);
      return Promise.resolve(() => this.release(agentId));
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push({ agentId, priority, seq: this.seq++, resolve });
      this.admit(); // in case a slot is free but others queued ahead
    });
  }

  /** Try to take a slot without queueing. Returns release() or null. */
  tryAcquire(agentId: string): (() => void) | null {
    if (this.running.size < this.limit && this.queue.length === 0) {
      this.running.add(agentId);
      return () => this.release(agentId);
    }
    return null;
  }

  private release(agentId: string): void {
    this.running.delete(agentId);
    this.admit();
  }

  private admit(): void {
    while (this.running.size < this.limit && this.queue.length > 0) {
      this.sortQueue();
      const next = this.queue.shift()!;
      this.running.add(next.agentId);
      next.resolve(() => this.release(next.agentId));
    }
  }

  /** Priority first (P0 before P4), FIFO within the same priority. */
  private sortQueue(): void {
    this.queue.sort(
      (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.seq - b.seq,
    );
  }
}

/**
 * Durable v2 workflow state — SPEC v2 §18/§19/§20.1 (Batch 13).
 *
 * The server's V2TransitionService drives ONE WorkflowEngineV2 and
 * keeps its per-task state (core's TaskV2State) in an in-process
 * mirror. Until now that mirror was the ONLY copy: a restart re-seeded
 * it approximately from the v1 task row — stage mapped from the v1
 * status, condition guessed from v1 exception statuses — and every
 * fact the row cannot express was lost: recorded §19 milestones, the
 * milestone/release/completion history arrays, the outcome-gate
 * validity flag, the optimistic-concurrency taskVersion, and the
 * §20.1 final seal (a finalized task came back DONE with finalSeal 0 —
 * the F1 residual Batch 12 documented).
 *
 * This module is the store seam behind that mirror, plus the SQLite
 * implementation on the task_v2_state table. The persisted shape IS
 * core's TaskV2State, field for field: it is a core domain type (not a
 * server projection like RuntimeRunRecord), produced by the engine and
 * consumed by the engine's hydration path, so the row mapping lives
 * here next to every other SQLite store and the type is imported from
 * @ai-factory/core rather than re-declared (a re-declaration would
 * silently drift from the engine's shape).
 *
 * Serializability: TaskV2State is plain data end to end — stage and
 * release-state strings, the §18.3 condition record, the §19 milestone
 * map, three history arrays, two flags, two counters, an optional
 * requirement pin. There are NO live handles to exclude. (The engine's
 * OTHER process state is not part of TaskV2State and is not persisted
 * here: the idempotency result cache and the G-21 failure-event log
 * stay process-local, their facts already written to the durable audit
 * log; the G-17 outbox queue has its OWN durable store since Batch 17
 * — see outbox.ts — wired into the engine as a sink, not via this
 * store.) Composite fields are JSON text,
 * lossless for these shapes, and JSON round-trips make every read a
 * fresh deep copy — so both implementations honour the copy contract
 * (callers can never mutate stored state through a fetched state, and
 * a put() snapshots its input) structurally.
 */

import { DatabaseSync } from 'node:sqlite';
import type { TaskV2State } from '@ai-factory/core';

/**
 * The v2 mirror's storage contract — deliberately the minimal set the
 * service's lifecycle uses: read one task's state, upsert (insert or
 * full replace), list all. No delete: nothing in the v2 lifecycle
 * un-registers a task's state.
 */
export interface TaskV2StateStore {
  /** The persisted state for one task, or undefined when none exists. */
  get(taskId: string): TaskV2State | undefined;
  /**
   * Insert a state, or replace the stored state for the same task.
   * Replacement keeps the task's original list position (first-put
   * order), matching Map.set semantics on an existing key.
   */
  put(state: TaskV2State): void;
  /** Every stored state, in first-put order. */
  list(): TaskV2State[];
  /** How many task states are stored — the health/observability count. */
  count(): number;
}

/**
 * Default TaskV2StateStore: an in-process Map with copy-in / copy-out
 * semantics. Nothing here survives a restart — it exists so embedders
 * and tests without a database keep a working store, and as the
 * behavior reference the SQLite implementation is pinned against.
 * Durable deployments install SqliteTaskV2StateStore (the server does,
 * via FactoryDatabase.taskV2States).
 */
export class InMemoryTaskV2StateStore implements TaskV2StateStore {
  private readonly states = new Map<string, TaskV2State>();

  get(taskId: string): TaskV2State | undefined {
    const s = this.states.get(taskId);
    return s ? structuredClone(s) : undefined;
  }

  put(state: TaskV2State): void {
    this.states.set(state.taskId, structuredClone(state));
  }

  list(): TaskV2State[] {
    return [...this.states.values()].map((s) => structuredClone(s));
  }

  count(): number {
    return this.states.size;
  }
}

function rowToState(r: Record<string, unknown>): TaskV2State {
  return {
    taskId: r['task_id'] as string,
    stage: r['stage'] as TaskV2State['stage'],
    condition: JSON.parse(r['condition'] as string) as TaskV2State['condition'],
    milestones: JSON.parse(r['milestones'] as string) as TaskV2State['milestones'],
    milestoneHistory: JSON.parse(
      r['milestone_history'] as string,
    ) as TaskV2State['milestoneHistory'],
    releaseState: r['release_state'] as TaskV2State['releaseState'],
    releaseHistory: JSON.parse(
      r['release_history'] as string,
    ) as TaskV2State['releaseHistory'],
    outcomeGateValid: Number(r['outcome_gate_valid']) === 1,
    finalSeal: (Number(r['final_seal']) === 1 ? 1 : 0) as TaskV2State['finalSeal'],
    taskVersion: Number(r['task_version']),
    requirementRef: (r['requirement_ref'] as string | null) ?? null,
    completionTarget: r['completion_target'] as TaskV2State['completionTarget'],
    completionHistory: JSON.parse(
      r['completion_history'] as string,
    ) as TaskV2State['completionHistory'],
    updatedAt: r['updated_at'] as string,
  };
}

/**
 * SQLite-backed TaskV2StateStore — same state shape, same identity
 * (the task id) and replace semantics as the in-memory default; only
 * the backing changes. One row per task on the task_v2_state table.
 */
export class SqliteTaskV2StateStore implements TaskV2StateStore {
  constructor(private readonly db: DatabaseSync) {}

  get(taskId: string): TaskV2State | undefined {
    const r = this.db
      .prepare('SELECT * FROM task_v2_state WHERE task_id = ?')
      .get(taskId) as Record<string, unknown> | undefined;
    return r ? rowToState(r) : undefined;
  }

  put(state: TaskV2State): void {
    this.db
      .prepare(
        `INSERT INTO task_v2_state
           (task_id, stage, condition, milestones, milestone_history,
            release_state, release_history, outcome_gate_valid, final_seal,
            task_version, requirement_ref, completion_target,
            completion_history, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET
           stage=excluded.stage, condition=excluded.condition,
           milestones=excluded.milestones,
           milestone_history=excluded.milestone_history,
           release_state=excluded.release_state,
           release_history=excluded.release_history,
           outcome_gate_valid=excluded.outcome_gate_valid,
           final_seal=excluded.final_seal,
           task_version=excluded.task_version,
           requirement_ref=excluded.requirement_ref,
           completion_target=excluded.completion_target,
           completion_history=excluded.completion_history,
           updated_at=excluded.updated_at`,
      )
      .run(
        state.taskId, state.stage,
        JSON.stringify(state.condition), JSON.stringify(state.milestones),
        JSON.stringify(state.milestoneHistory),
        state.releaseState, JSON.stringify(state.releaseHistory),
        state.outcomeGateValid ? 1 : 0, state.finalSeal,
        state.taskVersion, state.requirementRef, state.completionTarget,
        JSON.stringify(state.completionHistory), state.updatedAt,
      );
  }

  list(): TaskV2State[] {
    // rowid order = first-put order: ON CONFLICT DO UPDATE keeps the
    // original rowid, so a replaced state keeps its position —
    // matching the in-memory store's Map semantics.
    const rows = this.db
      .prepare('SELECT * FROM task_v2_state ORDER BY rowid')
      .all() as unknown as Record<string, unknown>[];
    return rows.map(rowToState);
  }

  count(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM task_v2_state').get() as {
        n: number;
      }
    ).n;
  }
}

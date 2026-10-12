/**
 * Durable HTTP run records — apps/server §24–§27 routes (walkthrough F4).
 *
 * The record POST /api/runtime/runs creates and GET
 * /api/runtime/runs/:id returns used to live in a module-level Map in
 * the route file: a restart lost the record (404) even though the run's
 * step intents and evidence side effects were already durable in
 * SQLite. This module is the store seam behind that registry, plus the
 * SQLite implementation on the runtime_runs table.
 *
 * Why the seam lives in THIS package (and the reasoning is load-bearing
 * — do not "tidy" it into @ai-factory/runtime): the record shape is the
 * server route's HTTP projection, not a runtime domain type.
 * @ai-factory/runtime owns its own, different RunRecord (the §25
 * twelve-state machine record in run-states.ts); nothing in runtime
 * produces or consumes this shape. The dependency direction also only
 * works from here: the server depends on @ai-factory/db, db cannot
 * import the server app, and db is already the package that owns the
 * persisted record shapes (projects/tasks/evidence rows) and every
 * SQLite store. Seam + in-memory default + SQLite implementation
 * therefore sit together here, mirroring the CheckpointStore /
 * OperationStore pattern of interface-plus-two-implementations — the
 * server's coordinator installs the SQLite store at startup
 * (setRuntimeRunStore in apps/server/src/index.ts), and anything
 * without a database keeps the in-memory default, exactly like an
 * embedder that injects no store for the runtime ledgers.
 *
 * Lifecycle (as the route drives it — there is no delete anywhere):
 * created RUNNING → evidence appended step by step while the run
 * executes → one terminal write (COMPLETED / ESCALATED / FAILED, or
 * FAILED + error). The route persists at EVERY step, not just the
 * terminal one: a process that dies mid-run leaves its last persisted
 * state in the table (possibly still RUNNING — the honest record of an
 * interrupted run, not a claim it finished; nothing here reaps or
 * rewrites such rows, same report-only philosophy as the startup
 * intent scan).
 *
 * Serializability: every field of the record is plain data (the
 * evidence / trace entries are the harness's and loop's own plain
 * records); there are no live handles to exclude. Composite fields are
 * JSON text, which is lossless for them, and JSON round-trips make
 * every read a fresh deep copy — so both implementations honour the
 * copy contract (callers can never mutate stored state through a
 * fetched record, and a put() snapshots its input) structurally.
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * One HTTP agent run, exactly as the runtime routes expose it. Kept
 * field-for-field identical to the shape the route module defined when
 * the registry was a bare Map — moving the type here changes no wire
 * format.
 */
export interface RuntimeRunRecord {
  id: string;
  agentId: string;
  taskId: string;
  status: 'RUNNING' | 'COMPLETED' | 'ESCALATED' | 'FAILED';
  outcome: string | null;
  steps: number;
  evidence: unknown[];
  handoffs: string[];
  trace: unknown[];
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}

/**
 * The run registry's storage contract — deliberately the minimal set
 * the route's lifecycle uses: read one, upsert (create or full
 * replace), list all. No delete: nothing in the run lifecycle removes
 * a record.
 */
export interface RuntimeRunStore {
  /** The record for one run id, or undefined when no such run exists. */
  get(id: string): RuntimeRunRecord | undefined;
  /**
   * Insert a record, or replace the stored record with the same id.
   * Replacement keeps the record's original list position (first-put
   * order), matching Map.set semantics on an existing key.
   */
  put(record: RuntimeRunRecord): void;
  /** Every stored record, in first-put (creation) order. */
  list(): RuntimeRunRecord[];
}

/**
 * Default RuntimeRunStore: the original in-process Map, with copy-in /
 * copy-out semantics. Nothing here survives a restart — it exists so
 * embedders and tests without a database keep working, and so the
 * route's default path needs no database. Durable deployments install
 * a persistent implementation (see SqliteRuntimeRunStore below).
 */
export class InMemoryRuntimeRunStore implements RuntimeRunStore {
  private readonly runs = new Map<string, RuntimeRunRecord>();

  get(id: string): RuntimeRunRecord | undefined {
    const r = this.runs.get(id);
    return r ? structuredClone(r) : undefined;
  }

  put(record: RuntimeRunRecord): void {
    this.runs.set(record.id, structuredClone(record));
  }

  list(): RuntimeRunRecord[] {
    return [...this.runs.values()].map((r) => structuredClone(r));
  }
}

function rowToRun(r: Record<string, unknown>): RuntimeRunRecord {
  return {
    id: r['id'] as string,
    agentId: r['agent_id'] as string,
    taskId: r['task_id'] as string,
    status: r['status'] as RuntimeRunRecord['status'],
    outcome: (r['outcome'] as string | null) ?? null,
    steps: Number(r['steps']),
    evidence: JSON.parse(r['evidence'] as string) as unknown[],
    handoffs: JSON.parse(r['handoffs'] as string) as string[],
    trace: JSON.parse(r['trace'] as string) as unknown[],
    createdAt: r['created_at'] as string,
    finishedAt: (r['finished_at'] as string | null) ?? null,
    error: (r['error'] as string | null) ?? null,
  };
}

/**
 * SQLite-backed RuntimeRunStore — same record shape, same identity
 * (the run id) and replace semantics as the in-memory default; only the
 * backing changes. One row per run on the runtime_runs table.
 */
export class SqliteRuntimeRunStore implements RuntimeRunStore {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): RuntimeRunRecord | undefined {
    const r = this.db
      .prepare('SELECT * FROM runtime_runs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return r ? rowToRun(r) : undefined;
  }

  put(record: RuntimeRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runtime_runs
           (id, agent_id, task_id, status, outcome, steps, evidence,
            handoffs, trace, created_at, finished_at, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           agent_id=excluded.agent_id, task_id=excluded.task_id,
           status=excluded.status, outcome=excluded.outcome,
           steps=excluded.steps, evidence=excluded.evidence,
           handoffs=excluded.handoffs, trace=excluded.trace,
           created_at=excluded.created_at,
           finished_at=excluded.finished_at, error=excluded.error`,
      )
      .run(
        record.id, record.agentId, record.taskId, record.status,
        record.outcome, record.steps,
        JSON.stringify(record.evidence), JSON.stringify(record.handoffs),
        JSON.stringify(record.trace),
        record.createdAt, record.finishedAt, record.error,
      );
  }

  list(): RuntimeRunRecord[] {
    // rowid order = first-put order: ON CONFLICT DO UPDATE keeps the
    // original rowid, so a replaced record keeps its position —
    // matching the in-memory store's Map semantics.
    const rows = this.db
      .prepare('SELECT * FROM runtime_runs ORDER BY rowid')
      .all() as unknown as Record<string, unknown>[];
    return rows.map(rowToRun);
  }
}

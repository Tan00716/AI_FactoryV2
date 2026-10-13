/**
 * Durable workflow outbox — SPEC v2 §18.2 (G-17) / §48.4 (Batch 17).
 *
 * The v2 engine's outbox (packages/core WorkflowEngineV2) records one
 * event per COMMITTED stage change so downstream consumers (webhooks,
 * sync, reporting) can pull what changed and acknowledge it by
 * draining. Until now that queue was a process-local array: a restart
 * lost every committed-but-undrained event, even though the state
 * changes themselves were durable. The §48.4 outbox_events table has
 * existed in the schema since the db package was written, but nothing
 * ever wrote to it — this module is the writer.
 *
 * The store implements core's OutboxSink seam (the seam's types are
 * core's, imported rather than re-declared, so the stored shape cannot
 * drift from the engine's event shape). The server wires
 * FactoryDatabase.outbox into the engine via V2TransitionService;
 * without a sink the engine keeps its original process-local queue.
 *
 * Row mapping (the §48.4 table): event_id is the sink-assigned id
 * (random UUID), aggregate_id is the event's taskId, occurred_at is
 * the event's own `at`, event_type is the engine's audit vocabulary
 * for the same fact (WORKFLOW_TRANSITIONED, or WORKFLOW_FINALIZED for
 * the REQUEST_COMPLETE finalize event), and payload is the complete
 * engine event as JSON — the columns are the indexable projection,
 * the payload is the lossless record read back.
 *
 * DRAIN SEMANTICS (the deliberate choice, pinned by tests): drain
 * CONFIRMS, it does not delete. markDispatched stamps dispatched_at on
 * the stored rows and the rows stay — "this event existed and was
 * consumed" is itself a fact worth keeping, and a DELETE would make a
 * drained event vanish without a trace. Pending therefore means
 * exactly `dispatched_at IS NULL` (the schema's idx_outbox_undispatched
 * index exists for this query), and an undispatched event survives any
 * number of restarts until somebody drains it. The dispatched_at stamp
 * uses the store's own clock (injectable for deterministic tests).
 *
 * Copy contract: payloads round-trip through JSON text, so every read
 * is a fresh deep copy — callers can never mutate stored state through
 * a fetched event, and append() snapshots its input. The in-memory
 * implementation honours the same contract via structuredClone and is
 * the behavior reference the SQLite implementation is pinned against.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { OutboxEvent, OutboxSink, StoredOutboxEvent } from '@ai-factory/core';

/** The store-side extension of the seam: pending count for health. */
export interface OutboxStore extends OutboxSink {
  /** How many events are stored and not yet dispatched (drained). */
  countPending(): number;
}

/**
 * The engine's audit vocabulary for an outbox fact — the value written
 * to the outbox_events.event_type column (WORKFLOW_FINALIZED for the
 * REQUEST_COMPLETE finalize event, WORKFLOW_TRANSITIONED otherwise).
 *
 * Exported (Batch 22) because the column was write-only: the store's
 * read path returns core's StoredOutboxEvent (no event_type field) and
 * the server's HTTP outbox view served the same engine shape, so no
 * consumer could ever see the vocabulary. The server derives
 * `eventType` on the HTTP response from this same function — it is a
 * deterministic projection of `intent`, not a second stored fact, so
 * the HTTP value and the DB column cannot drift apart.
 */
export function eventTypeOf(event: OutboxEvent): string {
  return event.intent === 'REQUEST_COMPLETE'
    ? 'WORKFLOW_FINALIZED'
    : 'WORKFLOW_TRANSITIONED';
}

/**
 * Default OutboxStore: an in-process Map with copy-in / copy-out
 * semantics. Nothing here survives a restart — it exists so embedders
 * and tests without a database keep a working sink, and as the
 * behavior reference the SQLite implementation is pinned against.
 * Durable deployments install SqliteOutboxStore (the server does, via
 * FactoryDatabase.outbox).
 */
export class InMemoryOutboxStore implements OutboxStore {
  private readonly rows = new Map<
    string,
    { event: OutboxEvent; dispatchedAt: string | null }
  >();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  append(event: OutboxEvent): StoredOutboxEvent {
    const id = randomUUID();
    this.rows.set(id, { event: structuredClone(event), dispatchedAt: null });
    return { ...structuredClone(event), id };
  }

  listPending(taskId?: string): StoredOutboxEvent[] {
    const out: StoredOutboxEvent[] = [];
    for (const [id, row] of this.rows) {
      if (row.dispatchedAt !== null) continue;
      if (taskId !== undefined && row.event.taskId !== taskId) continue;
      out.push({ ...structuredClone(row.event), id });
    }
    return out;
  }

  markDispatched(ids: string[]): StoredOutboxEvent[] {
    const stamp = new Date(this.now()).toISOString();
    const acked: StoredOutboxEvent[] = [];
    for (const id of ids) {
      const row = this.rows.get(id);
      if (!row || row.dispatchedAt !== null) continue;
      row.dispatchedAt = stamp;
      acked.push({ ...structuredClone(row.event), id });
    }
    return acked;
  }

  countPending(): number {
    let n = 0;
    for (const row of this.rows.values()) {
      if (row.dispatchedAt === null) n++;
    }
    return n;
  }
}

function rowToStored(r: Record<string, unknown>): StoredOutboxEvent {
  // The payload is the lossless record (written by append below from
  // the engine event itself); the id comes from the row's primary key.
  const event = JSON.parse(r['payload'] as string) as OutboxEvent;
  return { ...event, id: r['event_id'] as string };
}

/**
 * SQLite-backed OutboxStore on the §48.4 outbox_events table (created
 * by the schema on open — CREATE TABLE IF NOT EXISTS covers old
 * databases). One row per committed event, appended at commit time,
 * confirmed in place by drain.
 */
export class SqliteOutboxStore implements OutboxStore {
  private readonly now: () => number;

  constructor(
    private readonly db: DatabaseSync,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  append(event: OutboxEvent): StoredOutboxEvent {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO outbox_events
           (event_id, event_type, aggregate_id, occurred_at, payload, dispatched_at)
         VALUES (?,?,?,?,?,NULL)`,
      )
      .run(id, eventTypeOf(event), event.taskId, event.at, JSON.stringify(event));
    return { ...structuredClone(event), id };
  }

  listPending(taskId?: string): StoredOutboxEvent[] {
    const rows = (
      taskId === undefined
        ? this.db
            .prepare(
              'SELECT * FROM outbox_events WHERE dispatched_at IS NULL ORDER BY rowid',
            )
            .all()
        : this.db
            .prepare(
              `SELECT * FROM outbox_events
                WHERE dispatched_at IS NULL AND aggregate_id = ? ORDER BY rowid`,
            )
            .all(taskId)
    ) as unknown as Record<string, unknown>[];
    return rows.map(rowToStored);
  }

  markDispatched(ids: string[]): StoredOutboxEvent[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    // Read the still-pending rows first: the return value is exactly
    // the set this call acknowledges (already-dispatched ids are not
    // re-acknowledged and not returned twice).
    const pending = this.db
      .prepare(
        `SELECT * FROM outbox_events
          WHERE event_id IN (${placeholders}) AND dispatched_at IS NULL
          ORDER BY rowid`,
      )
      .all(...ids) as unknown as Record<string, unknown>[];
    if (pending.length === 0) return [];
    const stamp = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `UPDATE outbox_events SET dispatched_at = ?
          WHERE event_id IN (${placeholders}) AND dispatched_at IS NULL`,
      )
      .run(stamp, ...ids);
    return pending.map(rowToStored);
  }

  countPending(): number {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM outbox_events WHERE dispatched_at IS NULL',
      )
      .get() as unknown as Record<string, unknown>;
    return Number(r['n']);
  }
}

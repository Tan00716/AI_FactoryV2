/**
 * Durable workflow outbox — SPEC v2 §18.2 (G-17) / §48.4 (Batch 17).
 *
 * The outbox_events table has been in the schema since the db package
 * was written, but nothing ever wrote to it; SqliteOutboxStore is the
 * writer behind the engine's OutboxSink seam. This file pins:
 *
 *  - behavior parity: the same scripted sequence driven through the
 *    in-memory store and through SQLite produces identical results at
 *    every step — append order, per-task filtering, pending counts;
 *  - the drain semantics (the deliberate choice): markDispatched
 *    CONFIRMS, it never deletes — the row stays with dispatched_at
 *    stamped, pending means exactly "not yet dispatched", and
 *    re-acknowledging an id is a no-op that returns nothing twice;
 *  - stepwise fidelity across instances: events appended under one
 *    FactoryDatabase are pending under the next (a restart loses no
 *    committed-but-undrained event), and a dispatch stamped by one
 *    instance stays dispatched under the next;
 *  - row fidelity: the columns are the event's projection
 *    (aggregate_id = taskId, occurred_at = the event's `at`,
 *    event_type in the engine's audit vocabulary) and the payload is
 *    the complete engine event, read back field-for-field;
 *  - copy contract: mutating an appended input or a fetched event
 *    cannot corrupt stored state, in either implementation;
 *  - old databases: a file predating any outbox writer gains the
 *    (already-schematized) table on open and accepts appends.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FactoryDatabase,
  InMemoryOutboxStore,
  SqliteOutboxStore,
  eventTypeOf,
  type OutboxStore,
} from '../src/index';
import type { OutboxEvent } from '@ai-factory/core';

const STAMP_MS = 1750000000000;
const STAMP_ISO = new Date(STAMP_MS).toISOString();

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-outbox-'));
  return { dir, file: join(dir, 'factory.db') };
}

function ev(taskId: string, to: string, at: string, intent = 'START_TASK'): OutboxEvent {
  return { taskId, from: 'TODO', to: to as OutboxEvent['to'], by: 'agent-1', at, intent };
}

/**
 * One scripted sequence, run identically against both stores. Ids are
 * store-assigned (random UUIDs), so steps compare the EVENTS and the
 * per-step outcomes, and thread each store's own ids through its acks.
 */
function script(store: OutboxStore): void {
  assert.equal(store.countPending(), 0);
  assert.deepEqual(store.listPending(), []);

  const a = store.append(ev('t-1', 'PLANNING', '2026-10-12T00:00:01.000Z'));
  const b = store.append(ev('t-1', 'IN_PROGRESS', '2026-10-12T00:00:02.000Z'));
  const c = store.append(ev('t-2', 'PLANNING', '2026-10-12T00:00:03.000Z'));
  assert.ok(a.id && b.id && c.id);
  assert.notEqual(a.id, b.id);

  assert.equal(store.countPending(), 3);
  assert.deepEqual(store.listPending().map((e) => e.id), [a.id, b.id, c.id]);
  assert.deepEqual(store.listPending('t-1').map((e) => e.id), [a.id, b.id]);
  assert.deepEqual(store.listPending('t-2').map((e) => e.id), [c.id]);
  assert.deepEqual(store.listPending('nobody'), []);

  // Acknowledge one: it leaves pending, the others stay, order kept.
  const acked = store.markDispatched([b.id]);
  assert.deepEqual(acked.map((e) => e.id), [b.id]);
  assert.deepEqual(acked[0], { ...ev('t-1', 'IN_PROGRESS', '2026-10-12T00:00:02.000Z'), id: b.id });
  assert.equal(store.countPending(), 2);
  assert.deepEqual(store.listPending().map((e) => e.id), [a.id, c.id]);

  // Re-acknowledging is a no-op; unknown ids acknowledge nothing.
  assert.deepEqual(store.markDispatched([b.id]), []);
  assert.deepEqual(store.markDispatched(['no-such-id']), []);
  assert.deepEqual(store.markDispatched([]), []);
  assert.equal(store.countPending(), 2);

  // Drain the rest.
  const rest = store.markDispatched([a.id, c.id]);
  assert.deepEqual(rest.map((e) => e.id), [a.id, c.id]);
  assert.equal(store.countPending(), 0);
  assert.deepEqual(store.listPending(), []);
}

describe('outbox store (§18.2/§48.4, Batch 17)', () => {
  it('in-memory and SQLite implementations behave identically', () => {
    const { dir, file } = tmpDbFile();
    try {
      script(new InMemoryOutboxStore({ now: () => STAMP_MS }));
      const fdb = new FactoryDatabase(file);
      try {
        script(fdb.outbox);
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pending events and dispatch stamps survive a reopen, field-for-field', () => {
    const { dir, file } = tmpDbFile();
    try {
      const a = new FactoryDatabase(file);
      const e1 = a.outbox.append(ev('t-1', 'PLANNING', '2026-10-12T00:00:01.000Z'));
      const e2 = a.outbox.append(
        ev('t-1', 'DONE', '2026-10-12T00:00:09.000Z', 'REQUEST_COMPLETE'),
      );
      a.outbox.markDispatched([e1.id]);
      a.close();

      const b = new FactoryDatabase(file);
      try {
        // Only the undispatched event is pending, exactly as committed.
        assert.deepEqual(b.outbox.listPending(), [e2]);
        assert.equal(b.outbox.countPending(), 1);
        // Raw rows: both events still exist; e1 carries the stamp, e2 doesn't.
        const rows = b.db
          .prepare(
            'SELECT event_id, event_type, aggregate_id, occurred_at, payload, dispatched_at ' +
              'FROM outbox_events ORDER BY rowid',
          )
          .all() as unknown as Array<Record<string, unknown>>;
        assert.equal(rows.length, 2);
        assert.equal(rows[0]['event_id'], e1.id);
        assert.equal(rows[0]['event_type'], 'WORKFLOW_TRANSITIONED');
        assert.equal(rows[0]['aggregate_id'], 't-1');
        assert.equal(rows[0]['occurred_at'], '2026-10-12T00:00:01.000Z');
        assert.deepEqual(JSON.parse(rows[0]['payload'] as string), {
          ...ev('t-1', 'PLANNING', '2026-10-12T00:00:01.000Z'),
        });
        assert.ok(typeof rows[0]['dispatched_at'] === 'string');
        assert.equal(rows[1]['event_id'], e2.id);
        assert.equal(rows[1]['event_type'], 'WORKFLOW_FINALIZED');
        assert.equal(rows[1]['dispatched_at'], null);
      } finally {
        b.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the SQLite store stamps dispatched_at from its injected clock', () => {
    const { dir, file } = tmpDbFile();
    try {
      const raw = new DatabaseSync(file);
      raw.exec(
        `CREATE TABLE IF NOT EXISTS outbox_events (
           event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL,
           aggregate_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
           payload TEXT DEFAULT '{}', dispatched_at TEXT)`,
      );
      const store = new SqliteOutboxStore(raw, { now: () => STAMP_MS });
      const e = store.append(ev('t-9', 'PLANNING', '2026-10-12T00:00:01.000Z'));
      store.markDispatched([e.id]);
      const row = raw
        .prepare('SELECT dispatched_at FROM outbox_events WHERE event_id = ?')
        .get(e.id) as unknown as Record<string, unknown>;
      assert.equal(row['dispatched_at'], STAMP_ISO);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('eventTypeOf matches the event_type column written for each row (F7, Batch 22)', () => {
    // The event_type column used to be write-only: nothing ever read it
    // back, so HTTP consumers could not see the DB vocabulary. The
    // exported eventTypeOf is the rule the column is written with; the
    // server's HTTP outbox view derives eventType from it. Pin that the
    // rule and the column agree for both vocabularies.
    const { dir, file } = tmpDbFile();
    const raw = new DatabaseSync(file);
    try {
      raw.exec(
        `CREATE TABLE IF NOT EXISTS outbox_events (
           event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL,
           aggregate_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
           payload TEXT DEFAULT '{}', dispatched_at TEXT)`,
      );
      const store = new SqliteOutboxStore(raw);
      const transitioned = ev('t-1', 'PLANNING', '2026-10-12T00:00:01.000Z');
      const finalized = ev('t-1', 'DONE', '2026-10-12T00:00:02.000Z', 'REQUEST_COMPLETE');
      const s1 = store.append(transitioned);
      const s2 = store.append(finalized);
      const rows = raw
        .prepare('SELECT event_id, event_type, payload FROM outbox_events ORDER BY rowid')
        .all() as unknown as Array<Record<string, string>>;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]['event_id'], s1.id);
      assert.equal(rows[1]['event_id'], s2.id);
      assert.equal(eventTypeOf(transitioned), 'WORKFLOW_TRANSITIONED');
      assert.equal(eventTypeOf(finalized), 'WORKFLOW_FINALIZED');
      for (const row of rows) {
        const payload = JSON.parse(row['payload']) as OutboxEvent;
        assert.equal(
          row['event_type'],
          eventTypeOf(payload),
          'stored column and the exported rule must agree',
        );
      }
    } finally {
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copy contract: neither inputs nor fetched events can corrupt the store', () => {
    const stores: OutboxStore[] = [new InMemoryOutboxStore()];
    const { dir, file } = tmpDbFile();
    const fdb = new FactoryDatabase(file);
    stores.push(fdb.outbox);
    try {
      for (const store of stores) {
        const input = ev('t-1', 'PLANNING', '2026-10-12T00:00:01.000Z');
        const stored = store.append(input);
        input.to = 'DONE';
        stored.to = 'DONE';
        const fetched = store.listPending();
        assert.equal(fetched[0].to, 'PLANNING');
        fetched[0].to = 'DONE';
        assert.equal(store.listPending()[0].to, 'PLANNING');
      }
    } finally {
      fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

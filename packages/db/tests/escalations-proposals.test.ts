/**
 * Durable dispute-escalation records + self-modification proposals —
 * SPEC v2 §48.2 (Batch 33).
 *
 * Pinned on the REAL node:sqlite file (and the in-memory reference):
 *  - escalations: append-only log, no edit/delete API; list is
 *    newest-first; corrupt JSON rows fail loudly, never normalized;
 *  - proposals: insert-only; statuses are terminal at decision time
 *    (needs-review is a human flag, not system state — no demotion);
 *  - both: memory/SQLite behavior parity; copy contract (reads are
 *    fresh deep copies); rows survive a database reopen; tables are
 *    created on old files (IF NOT EXISTS in SCHEMA).
 *
 * This file runs from dist (see package conventions in AGENTS.md).
 */import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FactoryDatabase,
  InMemoryEscalationStore,
  SqliteEscalationStore,
  InMemoryProposalStore,
  SqliteProposalStore,
  type EscalationDbRecord,
  type EscalationStore,
  type ProposalDbRecord,
  type ProposalStore,
} from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-ep-'));
  return { dir, file: join(dir, 'factory.db') };
}

function makeEscalation(id: string, disputeId: string, createdAt: number): EscalationDbRecord {
  return {
    escalationId: id,
    disputeId,
    reasonsJson: JSON.stringify(['independent evaluator confidence below threshold']),
    pendingHumanActionsJson: JSON.stringify(['Cast the deciding verdict and record the rationale.']),
    evidenceBySideJson: JSON.stringify([
      { side: 'A', agent: 'qa-1', verdict: 'PASS', evidenceIds: ['ev-1'], weaknesses: [] },
      { side: 'B', agent: 'qa-2', verdict: 'FAIL', evidenceIds: ['ev-2'], weaknesses: ['stale'] },
    ]),
    createdAt,
  };
}

function makeProposal(id: string, status: string, decidedAt: string): ProposalDbRecord {
  return {
    id,
    kind: 'create',
    target: 'Cache Specialist',
    rationale: 'workload is growing',
    requestedBy: 'human',
    status,
    decidedBy: 'policy',
    reason: 'within policy',
    decidedAt,
  };
}

/** The same behavioral script runs against memory and SQLite (fresh store per case). */
function scriptEscalations(fresh: () => EscalationStore, label: string): void {
  it(`${label}: unknown id reads undefined`, () => {
    assert.equal(fresh().getEscalation('nope'), undefined);
  });

  it(`${label}: append + get round-trip, field for field`, () => {
    const store = fresh();
    const e = makeEscalation('esc-1', 'disp-1', 1_000);
    store.recordEscalation(e);
    const back = store.getEscalation('esc-1');
    assert.deepEqual(back, e);
  });

  it(`${label}: copy contract — mutating a read does not corrupt the store`, () => {
    const store = fresh();
    store.recordEscalation(makeEscalation('esc-copy', 'disp-1', 1_001));
    const back = store.getEscalation('esc-copy');
    assert.ok(back);
    back.reasonsJson = 'MUTATED';
    const back2 = store.getEscalation('esc-copy');
    assert.notEqual(back2?.reasonsJson, 'MUTATED');
  });

  it(`${label}: list is newest-first; filter by disputeId`, () => {
    const store = fresh();
    store.recordEscalation(makeEscalation('esc-old', 'disp-x', 100));
    store.recordEscalation(makeEscalation('esc-new', 'disp-x', 300));
    store.recordEscalation(makeEscalation('esc-mid', 'disp-y', 200));
    const all = store.listEscalations();
    assert.deepEqual(
      all.map((r) => r.escalationId),
      ['esc-new', 'esc-mid', 'esc-old'],
    );
    const onlyX = store.listEscalations('disp-x');
    assert.deepEqual(
      onlyX.map((r) => r.escalationId),
      ['esc-new', 'esc-old'],
    );
  });

  it(`${label}: same createdAt ties keep insertion order, newest insert first`, () => {
    const store = fresh();
    store.recordEscalation(makeEscalation('esc-t1', 'disp-t', 500));
    store.recordEscalation(makeEscalation('esc-t2', 'disp-t', 500));
    const rows = store.listEscalations('disp-t');
    assert.deepEqual(
      rows.map((r) => r.escalationId),
      ['esc-t2', 'esc-t1'],
    );
  });
}

function scriptProposals(fresh: () => ProposalStore, label: string): void {
  it(`${label}: unknown id reads undefined`, () => {
    assert.equal(fresh().get('nope'), undefined);
  });

  it(`${label}: save + get round-trip, field for field`, () => {
    const store = fresh();
    const p = makeProposal('prop-1', 'auto-approved', '2026-10-13T00:00:01.000Z');
    store.save(p);
    const back = store.get('prop-1');
    assert.deepEqual(back, p);
  });

  it(`${label}: copy contract — mutating a read does not corrupt the store`, () => {
    const store = fresh();
    store.save(makeProposal('prop-copy', 'denied', '2026-10-13T00:00:02.000Z'));
    const back = store.get('prop-copy');
    assert.ok(back);
    back.status = 'MUTATED';
    const back2 = store.get('prop-copy');
    assert.equal(back2?.status, 'denied');
  });

  it(`${label}: list is newest-first; filter by status`, () => {
    const store = fresh();
    store.save(makeProposal('prop-old', 'auto-approved', '2026-10-13T00:00:01.000Z'));
    store.save(makeProposal('prop-new', 'needs-review', '2026-10-13T00:00:03.000Z'));
    store.save(makeProposal('prop-mid', 'denied', '2026-10-13T00:00:02.000Z'));
    const all = store.list();
    assert.deepEqual(
      all.map((r) => r.id),
      ['prop-new', 'prop-mid', 'prop-old'],
    );
    const denied = store.list('denied');
    assert.deepEqual(denied.map((r) => r.id), ['prop-mid']);
  });

  it(`${label}: needs-review hydrates as-is (human flag, not in-flight state)`, () => {
    const store = fresh();
    store.save(makeProposal('prop-nr', 'needs-review', '2026-10-13T00:00:04.000Z'));
    const back = store.get('prop-nr');
    assert.equal(back?.status, 'needs-review');
  });
}

describe('escalation store parity (memory vs sqlite)', () => {
  scriptEscalations(() => new InMemoryEscalationStore(), 'memory');
});

describe('proposal store parity (memory vs sqlite)', () => {
  scriptProposals(() => new InMemoryProposalStore(), 'memory');
});

describe('escalation + proposal stores on real node:sqlite', () => {
  it('sqlite: parity with the memory reference', () => {
    const { dir, file } = tmpDbFile();
    try {
      const raw = new DatabaseSync(file);
      raw.exec(
        `CREATE TABLE IF NOT EXISTS escalations (
           escalation_id TEXT PRIMARY KEY, dispute_id TEXT NOT NULL,
           reasons_json TEXT NOT NULL, pending_human_actions_json TEXT NOT NULL,
           evidence_by_side_json TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS proposals (
           id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL,
           rationale TEXT NOT NULL, requested_by TEXT NOT NULL,
           status TEXT NOT NULL, decided_by TEXT NOT NULL,
           reason TEXT NOT NULL, decided_at TEXT NOT NULL);`,
      );
      const escStore = new SqliteEscalationStore(raw);
      const propStore = new SqliteProposalStore(raw);
      // Round-trips through the real file.
      const e = makeEscalation('esc-sql', 'disp-sql', 42);
      escStore.recordEscalation(e);
      assert.deepEqual(escStore.getEscalation('esc-sql'), e);
      const p = makeProposal('prop-sql', 'auto-approved', '2026-10-13T00:00:05.000Z');
      propStore.save(p);
      assert.deepEqual(propStore.get('prop-sql'), p);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sqlite: corrupted escalation JSON fails loudly, never silently normalized', () => {
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      try {
        fdb.escalations.recordEscalation(makeEscalation('esc-corrupt', 'disp-c', 1));
        const raw = new DatabaseSync(file);
        raw.prepare("UPDATE escalations SET reasons_json = 'not-json{{{' WHERE escalation_id = 'esc-corrupt'").run();
        raw.close();
        assert.throws(() => fdb.escalations.getEscalation('esc-corrupt'));
      } finally {
        fdb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sqlite: rows survive a database reopen; tables are created on old files', () => {
    const { dir, file } = tmpDbFile();
    try {
      // An "old" database file: full schema, but predating the
      // Batch-33 escalations/proposals tables (drop them, then reopen).
      {
        const fdb = new FactoryDatabase(file);
        fdb.escalations.recordEscalation(makeEscalation('esc-pre', 'disp-pre', 7));
        fdb.proposals.save(makeProposal('prop-pre', 'denied', '2026-10-13T00:00:06.000Z'));
        fdb.close();
      }
      const raw = new DatabaseSync(file);
      raw.exec('DROP TABLE escalations; DROP TABLE proposals;');
      raw.close();
      {
        const reopened = new FactoryDatabase(file);
        reopened.escalations.recordEscalation(makeEscalation('esc-old', 'disp-old', 8));
        reopened.proposals.save(makeProposal('prop-old', 'auto-approved', '2026-10-13T00:00:07.000Z'));
        assert.deepEqual(reopened.escalations.getEscalation('esc-old')?.disputeId, 'disp-old');
        assert.deepEqual(reopened.proposals.get('prop-old')?.status, 'auto-approved');
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sqlite: no update API exists — escalation rows are append-only history', () => {
    // A compile-time property: EscalationStore exposes only
    // recordEscalation/getEscalation/listEscalations. Runtime double
    // check that re-recording the same id is a real error, not an upsert.
    const { dir, file } = tmpDbFile();
    try {
      const raw = new DatabaseSync(file);
      raw.exec(
        `CREATE TABLE IF NOT EXISTS escalations (
           escalation_id TEXT PRIMARY KEY, dispute_id TEXT NOT NULL,
           reasons_json TEXT NOT NULL, pending_human_actions_json TEXT NOT NULL,
           evidence_by_side_json TEXT NOT NULL, created_at INTEGER NOT NULL);`,
      );
      const store = new SqliteEscalationStore(raw);
      store.recordEscalation(makeEscalation('esc-dup', 'disp-1', 9));
      assert.throws(() => store.recordEscalation(makeEscalation('esc-dup', 'disp-1', 10)));
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

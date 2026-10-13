/**
 * Gate definitions + evaluations, delegation records — SPEC v2 §39.3,
 * §12.2, §48.2 (Batch 32). Dual memory/SQLite behavior parity.
 *
 * Pinned:
 *  - definitions upsert by gate_id without touching the evaluation
 *    log; evaluations append newest-first and are never rewritten;
 *  - delegations upsert by delegation_id; markInterrupted demotes
 *    ONLY ACTIVE rows (no-op otherwise, version untouched);
 *  - every read returns a deep copy (mutating the result does not
 *    corrupt the store);
 *  - old databases gain the three tables on open (CREATE TABLE IF
 *    NOT EXISTS in SCHEMA) — opening a pre-Batch-32 DB file works.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryGateStore,
  SqliteGateStore,
  InMemoryDelegationStore,
  SqliteDelegationStore,
  FactoryDatabase,
  type GateStore,
  type DelegationStore,
  type GateDefinitionDbRecord,
  type GateEvaluationDbRecord,
  type DelegationDbRecord,
} from '../src/index';
import { DatabaseSync } from 'node:sqlite';

const NOW = '2026-10-13T10:00:00.000Z';

function defRecord(gateId = 'gate-1'): GateDefinitionDbRecord {
  return {
    gateId,
    definitionJson: JSON.stringify({
      gate_id: gateId,
      mandatory_ac_ids: ['AC-1'],
      max_failed: 0,
      max_skipped: 0,
      require_independent_review: false,
      max_finding_severity: 'HIGH',
      freshness_ms: null,
    }),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function evalRecord(gateId = 'gate-1', verdict = 'PASSED', at = NOW): GateEvaluationDbRecord {
  return {
    evaluationId: `eval-${gateId}-${verdict}-${at}`,
    gateId,
    verdict,
    reasonCode: null,
    missingJson: '[]',
    evidenceRefsJson: '["ev-1"]',
    evidenceSource: 'caller-supplied',
    evaluatorId: 'SYSTEM:gate-evaluator',
    evaluatedAt: at,
  };
}

function delRecord(id = 'del-1', status: DelegationDbRecord['status'] = 'DRAFT'): DelegationDbRecord {
  const delegation = {
    delegation_id: id,
    parent_delegation_id: null,
    delegator: 'mgr',
    delegatee: 'worker',
    root_authorization_id: 'auth-1',
    task_id: 'task-1',
    requirement_version: 'REQ-1@1',
    scope: ['tool:shell'],
    AC_refs: [],
    allowed_outputs: [],
    evidence_requirements: [],
    capability_ceiling: ['tool:shell'],
    budget_reservation: 10,
    due_at: null,
    reporting_targets: [],
    review_policy: 'manager-review',
    status,
    version: 1,
    oversight_by: 'mgr',
    owner: 'mgr',
    handoff_at: null,
    created_at: NOW,
  };
  return {
    delegationId: id,
    parentDelegationId: null,
    delegator: 'mgr',
    delegatee: 'worker',
    taskId: 'task-1',
    status,
    version: 1,
    recordJson: JSON.stringify(delegation),
    createdAt: NOW,
    updatedAt: NOW,
    rehydratedAt: null,
  };
}

function gateStores(db: DatabaseSync): GateStore[] {
  return [new InMemoryGateStore(), new SqliteGateStore(db)];
}

function delegationStores(db: DatabaseSync): DelegationStore[] {
  return [new InMemoryDelegationStore(), new SqliteDelegationStore(db)];
}

describe('gates: definitions + evaluations (Batch 32)', () => {
  it('definition upsert round-trips; update keeps createdAt and does not touch evaluations', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      // minimal schema for this test (full SCHEMA is exercised via FactoryDatabase below)
      `CREATE TABLE gate_definitions (gate_id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
       CREATE TABLE gate_evaluations (evaluation_id TEXT PRIMARY KEY, gate_id TEXT NOT NULL, verdict TEXT NOT NULL, reason_code TEXT, missing_json TEXT NOT NULL DEFAULT '[]', evidence_refs_json TEXT NOT NULL DEFAULT '[]', evidence_source TEXT NOT NULL, evaluator_id TEXT NOT NULL, evaluated_at TEXT NOT NULL);`,
    );
    for (const store of gateStores(db)) {
      store.saveDefinition(defRecord('g1'));
      assert.equal(JSON.parse(store.getDefinition('g1')!.definitionJson).max_failed, 0);
      store.recordEvaluation(evalRecord('g1', 'PASSED', '2026-10-13T10:00:00.000Z'));
      // update definition
      const updated = defRecord('g1');
      updated.definitionJson = JSON.stringify({ ...JSON.parse(updated.definitionJson), max_failed: 2 });
      updated.updatedAt = '2026-10-13T11:00:00.000Z';
      store.saveDefinition(updated);
      const got = store.getDefinition('g1')!;
      assert.equal(got.createdAt, NOW, 'upsert keeps the original createdAt');
      assert.equal(JSON.parse(got.definitionJson).max_failed, 2);
      // evaluation log untouched, still one row
      assert.equal(store.listEvaluations('g1').length, 1);
      assert.equal(store.getDefinition('missing'), undefined);
    }
  });

  it('evaluations append newest-first; getEvaluation round-trips', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      `CREATE TABLE gate_definitions (gate_id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
       CREATE TABLE gate_evaluations (evaluation_id TEXT PRIMARY KEY, gate_id TEXT NOT NULL, verdict TEXT NOT NULL, reason_code TEXT, missing_json TEXT NOT NULL DEFAULT '[]', evidence_refs_json TEXT NOT NULL DEFAULT '[]', evidence_source TEXT NOT NULL, evaluator_id TEXT NOT NULL, evaluated_at TEXT NOT NULL);`,
    );
    for (const store of gateStores(db)) {
      store.recordEvaluation(evalRecord('g1', 'BLOCKED', '2026-10-13T10:00:00.000Z'));
      store.recordEvaluation(evalRecord('g1', 'PASSED', '2026-10-13T12:00:00.000Z'));
      store.recordEvaluation(evalRecord('g2', 'FAILED', '2026-10-13T11:00:00.000Z'));
      const all = store.listEvaluations();
      assert.deepEqual(
        all.map((e) => e.verdict),
        ['PASSED', 'FAILED', 'BLOCKED'],
        'newest-first across gates',
      );
      const g1 = store.listEvaluations('g1');
      assert.deepEqual(g1.map((e) => e.verdict), ['PASSED', 'BLOCKED']);
      const one = store.getEvaluation('eval-g1-PASSED-2026-10-13T12:00:00.000Z')!;
      assert.equal(one.evidenceSource, 'caller-supplied');
      assert.equal(store.getEvaluation('nope'), undefined);
    }
  });

  it('reads are deep copies — mutating a result does not corrupt the store', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      `CREATE TABLE gate_definitions (gate_id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
       CREATE TABLE gate_evaluations (evaluation_id TEXT PRIMARY KEY, gate_id TEXT NOT NULL, verdict TEXT NOT NULL, reason_code TEXT, missing_json TEXT NOT NULL DEFAULT '[]', evidence_refs_json TEXT NOT NULL DEFAULT '[]', evidence_source TEXT NOT NULL, evaluator_id TEXT NOT NULL, evaluated_at TEXT NOT NULL);`,
    );
    for (const store of gateStores(db)) {
      store.saveDefinition(defRecord('g1'));
      const d = store.getDefinition('g1')!;
      d.definitionJson = 'corrupted';
      assert.notEqual(store.getDefinition('g1')!.definitionJson, 'corrupted');
      store.recordEvaluation(evalRecord('g1'));
      const e = store.listEvaluations()[0];
      e.verdict = 'HACKED';
      assert.notEqual(store.listEvaluations()[0].verdict, 'HACKED');
    }
  });
});

describe('delegations: records + INTERRUPTED demotion (Batch 32)', () => {
  it('save/get/list/listByStatus round-trip on both implementations', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      `CREATE TABLE delegations (delegation_id TEXT PRIMARY KEY, parent_delegation_id TEXT, delegator TEXT NOT NULL, delegatee TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, rehydrated_at TEXT);
       CREATE INDEX idx_delegations_status ON delegations(status);`,
    );
    for (const store of delegationStores(db)) {
      store.save(delRecord('d1', 'DRAFT'));
      store.save(delRecord('d2', 'ACTIVE'));
      store.save(delRecord('d3', 'COMPLETED'));
      const got = store.get('d1')!;
      assert.equal(got.delegator, 'mgr');
      assert.equal(JSON.parse(got.recordJson).delegation_id, 'd1');
      assert.deepEqual(store.list().map((r) => r.delegationId), ['d1', 'd2', 'd3']);
      assert.deepEqual(store.listByStatus('ACTIVE').map((r) => r.delegationId), ['d2']);
      assert.equal(store.get('missing'), undefined);
      // upsert: status + version move together
      const v2 = delRecord('d1', 'ACTIVE');
      v2.version = 2;
      store.save(v2);
      assert.equal(store.get('d1')!.version, 2);
      assert.equal(store.get('d1')!.status, 'ACTIVE');
    }
  });

  it('markInterrupted demotes ONLY ACTIVE rows; no-op otherwise; version untouched', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      `CREATE TABLE delegations (delegation_id TEXT PRIMARY KEY, parent_delegation_id TEXT, delegator TEXT NOT NULL, delegatee TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, rehydrated_at TEXT);`,
    );
    for (const store of delegationStores(db)) {
      store.save(delRecord('a', 'ACTIVE'));
      const draft = delRecord('b', 'DRAFT');
      draft.version = 3;
      store.save(draft);
      store.save(delRecord('c', 'COMPLETED'));

      assert.equal(store.markInterrupted('a', '2026-10-13T12:00:00.000Z'), true);
      const a = store.get('a')!;
      assert.equal(a.status, 'INTERRUPTED');
      assert.equal(a.rehydratedAt, '2026-10-13T12:00:00.000Z');
      assert.equal(a.version, 1, 'demotion is a honesty stamp, not a delegation decision');

      assert.equal(store.markInterrupted('a', '2026-10-13T13:00:00.000Z'), false, 'already INTERRUPTED: no-op');
      assert.equal(store.markInterrupted('b', '2026-10-13T13:00:00.000Z'), false, 'DRAFT: no-op');
      assert.equal(store.get('b')!.version, 3);
      assert.equal(store.markInterrupted('c', '2026-10-13T13:00:00.000Z'), false, 'COMPLETED: no-op');
      assert.equal(store.markInterrupted('missing', '2026-10-13T13:00:00.000Z'), false, 'unknown: no-op');
    }
  });

  it('reads are deep copies', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      `CREATE TABLE delegations (delegation_id TEXT PRIMARY KEY, parent_delegation_id TEXT, delegator TEXT NOT NULL, delegatee TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, rehydrated_at TEXT);`,
    );
    for (const store of delegationStores(db)) {
      store.save(delRecord('d1', 'ACTIVE'));
      const r = store.get('d1')!;
      r.recordJson = 'corrupted';
      r.status = 'COMPLETED';
      const fresh = store.get('d1')!;
      assert.notEqual(fresh.recordJson, 'corrupted');
      assert.equal(fresh.status, 'ACTIVE');
    }
  });

  it('FactoryDatabase opens with the three tables and preserves rows across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-governance-'));
    try {
      const file = join(dir, 'factory.db');
      {
        const fdb = new FactoryDatabase(file);
        fdb.gates.saveDefinition(defRecord('g1'));
        fdb.gates.recordEvaluation(evalRecord('g1'));
        fdb.delegations.save(delRecord('d1', 'ACTIVE'));
      }
      {
        const fdb = new FactoryDatabase(file);
        assert.equal(fdb.gates.listDefinitions().length, 1);
        assert.equal(fdb.gates.listEvaluations().length, 1);
        assert.equal(fdb.delegations.listByStatus('ACTIVE').length, 1);
        assert.equal(fdb.delegations.markInterrupted('d1', NOW), true);
      }
      {
        const fdb = new FactoryDatabase(file);
        assert.equal(fdb.delegations.get('d1')!.status, 'INTERRUPTED');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

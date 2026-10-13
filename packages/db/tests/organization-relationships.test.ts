/**
 * Durable organization graph — SPEC v2 §48.2 + §9 (Batch 34).
 *
 * Pinned on the REAL node:sqlite file (and the in-memory reference):
 *  - nodes: saveNode upserts by node_id; corrupt identity_json fails
 *    loudly, never normalized;
 *  - edges: saveEdge upserts by edge_id (this is how valid_to closure
 *    works); removeEdge hard-deletes and reports whether a row existed;
 *  - edges with valid_to = NULL hydrate as-is (ongoing relationship,
 *    not in-flight process state — nothing to demote);
 *  - memory/SQLite behavior parity; copy contract (reads are fresh
 *    deep copies); rows survive a database reopen; tables are created
 *    on old files (IF NOT EXISTS in SCHEMA).
 *
 * This file runs from dist (see package conventions in AGENTS.md).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FactoryDatabase,
  InMemoryOrgGraphStore,
  SqliteOrgGraphStore,
  type OrgEdgeDbRecord,
  type OrgGraphStore,
  type OrgNodeDbRecord,
} from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-org-'));
  return { dir, file: join(dir, 'factory.db') };
}

function makeNode(id: string, orgId = 'org-1'): OrgNodeDbRecord {
  return {
    nodeId: id,
    orgId,
    type: 'AI_EMPLOYEE',
    displayName: `node ${id}`,
    identityJson: JSON.stringify({ name: 'worker-1' }),
    version: 1,
    status: 'ACTIVE',
    tombstone: false,
  };
}

function makeEdge(id: string, source = 'a', target = 'b'): OrgEdgeDbRecord {
  return {
    edgeId: id,
    sourceNodeId: source,
    targetNodeId: target,
    relationshipType: 'PRIMARY_REPORTS_TO',
    projectScope: null,
    authorityScope: 'org',
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: null,
    version: 1,
    createdBy: 'human',
    policyRef: 'pol-1',
  };
}

function eachStore(name: string, fn: (store: OrgGraphStore, cleanup: () => void) => void): void {
  describe(name, () => {
    it('in-memory reference', () => {
      fn(new InMemoryOrgGraphStore(), () => {});
    });
    it('sqlite', () => {
      const { dir, file } = tmpDbFile();
      const fdb = new FactoryDatabase(file);
      fn(fdb.orgGraph, () => {
        fdb.close();
        rmSync(dir, { recursive: true, force: true });
      });
    });
  });
}

eachStore('nodes', (store, cleanup) => {
  try {
    store.saveNode(makeNode('a'));
    const got = store.getNode('a');
    assert.equal(got?.displayName, 'node a');
    assert.equal(got?.tombstone, false);
    // upsert by node_id: re-save edits
    const updated = { ...makeNode('a'), displayName: 'renamed', version: 2, tombstone: true };
    store.saveNode(updated);
    const got2 = store.getNode('a');
    assert.equal(got2?.displayName, 'renamed');
    assert.equal(got2?.version, 2);
    assert.equal(got2?.tombstone, true);
    // unknown node
    assert.equal(store.getNode('missing'), undefined);
    // list + org filter
    store.saveNode(makeNode('b', 'org-2'));
    assert.equal(store.listNodes().length, 2);
    assert.deepEqual(store.listNodes('org-1').map((n: OrgNodeDbRecord) => n.nodeId), ['a']);
    // copy contract: mutate the returned copy, store is unaffected
    const copy = store.getNode('a');
    assert.ok(copy);
    copy.displayName = 'mutated';
    assert.equal(store.getNode('a')?.displayName, 'renamed');
    // id-only listing never parses identity_json
    assert.deepEqual(store.listNodeIds(), ['a', 'b']);
  } finally {
    cleanup();
  }
});

eachStore('edges', (store, cleanup) => {
  try {
    store.saveEdge(makeEdge('e1'));
    assert.equal(store.getEdge('e1')?.relationshipType, 'PRIMARY_REPORTS_TO');
    assert.equal(store.getEdge('e1')?.validTo, null);
    // upsert by edge_id: valid_to closure (retire semantics)
    const closed = { ...makeEdge('e1'), validTo: '2026-02-01T00:00:00.000Z', version: 2 };
    store.saveEdge(closed);
    assert.equal(store.getEdge('e1')?.validTo, '2026-02-01T00:00:00.000Z');
    assert.equal(store.getEdge('e1')?.version, 2);
    // removeEdge hard-deletes and reports
    assert.equal(store.removeEdge('e1'), true);
    assert.equal(store.removeEdge('e1'), false);
    assert.equal(store.getEdge('e1'), undefined);
    assert.deepEqual(store.listEdges(), []);
    // copy contract
    store.saveEdge(makeEdge('e2'));
    const c = store.getEdge('e2');
    assert.ok(c);
    c.relationshipType = 'MUTATED';
    assert.equal(store.getEdge('e2')?.relationshipType, 'PRIMARY_REPORTS_TO');
  } finally {
    cleanup();
  }
});

describe('org graph corruption and persistence', () => {
  it('corrupt identity_json fails loudly (sqlite)', () => {
    const { dir, file } = tmpDbFile();
    const fdb = new FactoryDatabase(file);
    try {
      fdb.orgGraph.saveNode(makeNode('bad'));
      const raw = new DatabaseSync(file);
      raw.prepare("UPDATE organization_nodes SET identity_json = 'not-json{{{' WHERE node_id = 'bad'").run();
      raw.close();
      assert.throws(() => fdb.orgGraph.getNode('bad'));
    } finally {
      fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rows survive a database reopen (sqlite)', () => {
    const { dir, file } = tmpDbFile();
    {
      const fdb = new FactoryDatabase(file);
      fdb.orgGraph.saveNode(makeNode('a'));
      fdb.orgGraph.saveEdge(makeEdge('e1'));
      fdb.close();
    }
    const fdb2 = new FactoryDatabase(file);
    try {
      assert.equal(fdb2.orgGraph.getNode('a')?.displayName, 'node a');
      assert.equal(fdb2.orgGraph.getEdge('e1')?.targetNodeId, 'b');
    } finally {
      fdb2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tables are created on an old DB file (IF NOT EXISTS)', () => {
    const { dir, file } = tmpDbFile();
    // An "old" DB: a file with only some other table, no org tables.
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE some_old_table (id TEXT PRIMARY KEY)');
    raw.close();
    const fdb = new FactoryDatabase(file);
    try {
      fdb.orgGraph.saveNode(makeNode('a'));
      assert.equal(fdb.orgGraph.getNode('a')?.nodeId, 'a');
      fdb.orgGraph.saveEdge(makeEdge('e1'));
      assert.equal(fdb.orgGraph.getEdge('e1')?.edgeId, 'e1');
    } finally {
      fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

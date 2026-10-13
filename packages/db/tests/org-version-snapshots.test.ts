/**
 * Versioned org-graph snapshot history — SPEC v2 §9.4 (Batch 35).
 *
 * Pinned on the REAL node:sqlite file (and the in-memory reference):
 *  - append-only: no update/delete API; graph_version is a per-database
 *    monotonic counter (first row = 1); list is newest-first;
 *  - GENESIS rows snapshot real state, they never invent it;
 *  - copy contract (reads are fresh deep copies); rows survive a
 *    database reopen; tables are created on old files (IF NOT EXISTS
 *    in SCHEMA); corrupt graph_json fails loudly, never guessed.
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
  InMemoryOrgVersionSnapshotStore,
  SqliteOrgVersionSnapshotStore,
  type OrgGraphChange,
  type OrgVersionSnapshotStore,
} from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-orgsnap-'));
  return { dir, file: join(dir, 'factory.db') };
}

function graphJson(nodes: string[], edges: string[]): string {
  return JSON.stringify({
    nodes: nodes.map((id) => ({ id, type: 'AI_EMPLOYEE' })),
    edges: edges.map((id) => ({ id })),
  });
}

/** Fresh dual implementations per test — version counters never leak between tests. */
function makeStores(): { name: string; store: OrgVersionSnapshotStore; close: () => void }[] {
  // Separate dirs per implementation: closing one store must never
  // disturb the other's live connection.
  const tm = tmpDbFile();
  const ts = tmpDbFile();
  const raw = new DatabaseSync(ts.file);
  raw.exec(
    'CREATE TABLE IF NOT EXISTS org_version_snapshots (' +
      'snapshot_id TEXT PRIMARY KEY, graph_version INTEGER NOT NULL, change TEXT NOT NULL, ' +
      'node_id TEXT, edge_id TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL, graph_json TEXT NOT NULL)',
  );
  raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_org_version_snapshots_version ON org_version_snapshots(graph_version)');
  return [
    { name: 'memory', store: new InMemoryOrgVersionSnapshotStore(), close: () => rmSync(tm.dir, { recursive: true, force: true }) },
    {
      name: 'sqlite',
      store: new SqliteOrgVersionSnapshotStore(raw),
      close: () => {
        raw.close();
        rmSync(ts.dir, { recursive: true, force: true });
      },
    },
  ];
}

describe('org version snapshots (§9.4 durable history)', () => {
  it('append assigns monotonic graph_version starting at 1', () => {
    for (const { name, store, close } of makeStores()) {
      try {
        const a = store.append({ change: 'NODE_ADDED', actor: 'HUMAN', graphJson: graphJson(['a'], []) });
        const b = store.append({ change: 'EDGE_ADDED', actor: 'AI', graphJson: graphJson(['a', 'b'], ['e1']) });
        assert.equal(a.graphVersion, 1, name);
        assert.equal(b.graphVersion, 2, name);
        assert.equal(store.maxVersion(), 2, name);
        assert.equal(a.change, 'NODE_ADDED');
        assert.equal(b.change, 'EDGE_ADDED');
        assert.ok(a.snapshotId.length > 0 && b.snapshotId.length > 0);
        assert.notEqual(a.snapshotId, b.snapshotId);
        assert.equal(a.nodeId, null);
        assert.equal(a.edgeId, null);
      } finally {
        close();
      }
    }
  });

  it('list is newest-first, get returns the row', () => {
    for (const { name, store, close } of makeStores()) {
      try {
        const a = store.append({ change: 'NODE_ADDED', nodeId: 'a', actor: 'SERVICE', graphJson: graphJson(['a'], []) });
        const b = store.append({ change: 'EDGE_REMOVED', edgeId: 'e1', actor: 'SERVICE', graphJson: graphJson(['a'], []) });
        const list = store.list();
        assert.equal(list.length, 2, name);
        assert.equal(list[0]!.snapshotId, b.snapshotId, name);
        assert.equal(list[1]!.snapshotId, a.snapshotId, name);
        assert.deepEqual(store.listSnapshotIds(), [b.snapshotId, a.snapshotId], name);
      const got = store.get(a.snapshotId);
        assert.equal(got?.graphVersion, 1, name);
        assert.equal(got?.nodeId, 'a', name);
        assert.equal(got?.edgeId, null, name);
        assert.equal(store.get('nope'), undefined, name);
      } finally {
        close();
      }
    }
  });

  it('GENESIS snapshots record real state, not invented rows', () => {
    for (const { name, store, close } of makeStores()) {
      try {
        const g = store.append({
          change: 'GENESIS',
          actor: 'system',
          graphJson: graphJson(['mgr-1', 'wrk-1'], ['edge-1']),
        });
        const parsed = JSON.parse(g.graphJson) as { nodes: unknown[]; edges: unknown[] };
        assert.equal(parsed.nodes.length, 2, name);
        assert.equal(parsed.edges.length, 1, name);
        assert.equal(g.change, 'GENESIS', name);
        assert.equal(g.graphVersion, 1, name);
      } finally {
        close();
      }
    }
  });

  it('reads are deep copies', () => {
    for (const { name, store, close } of makeStores()) {
      try {
        const a = store.append({ change: 'NODE_ADDED', actor: 'SERVICE', graphJson: graphJson(['a'], []) });
        const got = store.get(a.snapshotId)!;
        (got as { graphJson: string }).graphJson = 'mutated';
        assert.notEqual(store.get(a.snapshotId)!.graphJson, 'mutated', name);
        const listed = store.list();
        listed[0]!.graphJson = 'mutated';
        assert.notEqual(store.get(a.snapshotId)!.graphJson, 'mutated', name);
      } finally {
        close();
      }
    }
  });

  it('corrupt graph_json fails loudly on read, never guessed', () => {
    for (const { name, store, close } of makeStores()) {
      try {
        const a = store.append({ change: 'NODE_ADDED', actor: 'SERVICE', graphJson: 'not-json{{{' });
        assert.throws(() => store.get(a.snapshotId), /graph_json|JSON/i, name);
        assert.throws(() => store.list(), /graph_json|JSON/i, name);
      } finally {
        close();
      }
    }
  });

  it('unknown change and bad input are rejected loudly', () => {
    for (const { name, store, close } of makeStores()) {
      try {
        assert.throws(() => store.append({ change: 'BOGUS' as OrgGraphChange, actor: 'x', graphJson: '{}' }), name);
        assert.throws(() => store.append({ change: 'NODE_ADDED', actor: '', graphJson: '{}' }), name);
        assert.throws(() => store.append({ change: 'NODE_ADDED', actor: 'x', graphJson: 42 as unknown as string }), name);
      } finally {
        close();
      }
    }
  });

  it('duplicate snapshot ids are rejected', () => {
    for (const { name, store, close } of makeStores()) {
      try {
        const a = store.append({ change: 'NODE_ADDED', actor: 'x', graphJson: '{}' }, { snapshotId: 'dup-id' });
        assert.equal(a.snapshotId, 'dup-id', name);
        assert.throws(() => store.append({ change: 'NODE_ADDED', actor: 'x', graphJson: '{}' }, { snapshotId: 'dup-id' }), name);
      } finally {
        close();
      }
    }
  });

  it('rows survive a database reopen, versions continue (FactoryDatabase)', () => {
    const t = tmpDbFile();
    const fdb = new FactoryDatabase(t.file);
    const a = fdb.orgSnapshots.append({ change: 'GENESIS', actor: 'system', graphJson: graphJson(['n1'], ['e1']) });
    assert.equal(a.graphVersion, 1);
    fdb.close();
    const fdb2 = new FactoryDatabase(t.file);
    assert.equal(fdb2.orgSnapshots.maxVersion(), 1);
    assert.equal(fdb2.orgSnapshots.list().length, 1);
    const b = fdb2.orgSnapshots.append({ change: 'NODE_ADDED', nodeId: 'n2', actor: 'HUMAN', graphJson: graphJson(['n1', 'n2'], ['e1']) });
    assert.equal(b.graphVersion, 2); // version continues across reopen, no reset
    const parsed = JSON.parse(fdb2.orgSnapshots.get(b.snapshotId)!.graphJson) as { nodes: unknown[] };
    assert.equal(parsed.nodes.length, 2);
    fdb2.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  it('table is created on old files (IF NOT EXISTS in SCHEMA)', () => {
    const t = tmpDbFile();
    const raw = new DatabaseSync(t.file);
    raw.exec('CREATE TABLE t(x TEXT)');
    raw.close();
    const fdb = new FactoryDatabase(t.file);
    const a = fdb.orgSnapshots.append({ change: 'NODE_ADDED', actor: 'x', graphJson: graphJson(['a'], []) });
    assert.equal(a.graphVersion, 1);
    fdb.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  it('concurrent appends do not collide on graph_version (sqlite, two connections)', () => {
    const t = tmpDbFile();
    const fdb1 = new FactoryDatabase(t.file);
    const fdb2 = new FactoryDatabase(t.file);
    const versions: number[] = [];
    for (let i = 0; i < 6; i++) {
      const s = (i % 2 === 0 ? fdb1 : fdb2).orgSnapshots.append({
        change: 'NODE_ADDED',
        actor: 'x',
        graphJson: graphJson([`n${i}`], []),
      });
      versions.push(s.graphVersion);
    }
    assert.deepEqual(versions, [1, 2, 3, 4, 5, 6]); // no gaps, no collisions
    assert.equal(new Set(fdb1.orgSnapshots.list().map((r) => r.graphVersion)).size, 6);
    fdb1.close();
    fdb2.close();
    rmSync(t.dir, { recursive: true, force: true });
  });
});

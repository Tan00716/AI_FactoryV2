/**
 * MCP cross-process write mutual exclusion — Batch 25.
 *
 * McpServerStore.applyServerOp runs read-modify-write inside one
 * BEGIN IMMEDIATE transaction: concurrent processes serialize, and
 * the loser's callback sees the winner's committed row instead of
 * blindly overwriting it with stale state. This pins the contract
 * identically against the in-memory reference and SQLite:
 *  - the callback always sees the fresh row (no stale base);
 *  - a null return is a no-op (version untouched);
 *  - a throwing callback rolls back loudly (row untouched);
 *  - row_version bumps once per applied write;
 *  - old databases without the row_version column are migrated.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FactoryDatabase,
  MemoryMcpServerStore,
  SqliteMcpServerStore,
  type McpServerDbRecord,
  type McpServerStore,
} from '../src/index';

function baseRow(name: string, version: string): McpServerDbRecord {
  return {
    name,
    version,
    trustLevel: 'UNKNOWN',
    approvalPolicy: 'BLOCKED',
    healthStale: false,
    recordJson: JSON.stringify({ name, version, history: [] }),
    assessmentJson: null,
    updatedAt: '2026-10-13T00:00:00.000Z',
    rowVersion: 0,
  };
}

function script(store: McpServerStore): void {
  // 1. apply on a missing row creates it at version 1.
  const r1 = store.applyServerOp('a', '1', (cur) => {
    assert.equal(cur, undefined, 'callback sees absence, not a phantom row');
    return baseRow('a', '1');
  });
  assert.deepEqual(r1, { applied: true, rowVersion: 1 });

  // 2. the next apply sees the first write (fresh read, never stale).
  const r2 = store.applyServerOp('a', '1', (cur) => {
    assert.ok(cur, 'second apply sees the committed row');
    assert.equal(cur?.rowVersion, 1);
    assert.equal(cur?.trustLevel, 'UNKNOWN');
    return { ...cur!, trustLevel: 'HIGH' };
  });
  assert.deepEqual(r2, { applied: true, rowVersion: 2 });
  assert.equal(store.getServer('a', '1')?.trustLevel, 'HIGH');

  // 3. null is a no-op: version and row untouched.
  const r3 = store.applyServerOp('a', '1', () => null);
  assert.deepEqual(r3, { applied: false, rowVersion: 2 });
  assert.equal(store.getServer('a', '1')?.rowVersion, 2);

  // 4. a throwing callback rolls back loudly; the row is untouched.
  assert.throws(
    () =>
      store.applyServerOp('a', '1', () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  const afterThrow = store.getServer('a', '1');
  assert.equal(afterThrow?.trustLevel, 'HIGH');
  assert.equal(afterThrow?.rowVersion, 2);

  // 5. saveServer keeps bumping the generation (blind upsert stays
  //    versioned so readers can observe contention).
  store.saveServer({ ...baseRow('a', '1'), trustLevel: 'LOW' });
  assert.equal(store.getServer('a', '1')?.rowVersion, 3);
}

describe('mcp applyServerOp (Batch 25)', () => {
  it('memory implementation', () => {
    script(new MemoryMcpServerStore());
  });

  it('sqlite implementation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-db-mcpops-'));
    const dbFile = join(dir, 'factory.db');
    try {
      const fdb = new FactoryDatabase(dbFile);
      script(fdb.mcpServers);
      fdb.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('old databases without row_version are migrated in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-db-mcpops-old-'));
    const dbFile = join(dir, 'factory.db');
    try {
      // Hand-build the pre-Batch-25 shape (no row_version column).
      const raw = new DatabaseSync(dbFile);
      raw.exec(`CREATE TABLE mcp_servers (
        name TEXT NOT NULL, version TEXT NOT NULL,
        trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
        approval_policy TEXT NOT NULL DEFAULT 'BLOCKED',
        health_stale INTEGER NOT NULL DEFAULT 0,
        record_json TEXT NOT NULL, assessment_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (name, version))`);
      raw.prepare(
        `INSERT INTO mcp_servers (name, version, record_json, updated_at)
         VALUES ('old', '9', '{"history":[]}', '2026-01-01T00:00:00.000Z')`,
      ).run();
      raw.close();

      const fdb = new FactoryDatabase(dbFile);
      const cols = (
        fdb.db.prepare('PRAGMA table_info(mcp_servers)').all() as { name: string }[]
      ).map((c) => c.name);
      assert.ok(cols.includes('row_version'), 'migration adds the column');
      // The pre-existing row is writable through the new path.
      const r = fdb.mcpServers.applyServerOp('old', '9', (cur) => {
        assert.ok(cur, 'old row is readable');
        assert.equal(cur?.rowVersion, 1, 'migrated rows start at generation 1');
        return { ...cur!, trustLevel: 'HIGH' };
      });
      assert.deepEqual(r, { applied: true, rowVersion: 2 });
      fdb.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

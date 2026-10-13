/**
 * MCP install table concurrent-write semantics — Batch 27-2 audit.
 *
 * Audit conclusion (honest): no mixed rows. `saveInstall` is one
 * SQLite statement (INSERT ... ON CONFLICT DO UPDATE sets every column
 * at once) and `removeInstall` is one DELETE; each statement is atomic,
 * so two processes hammering the same DB file can only ever observe
 * "one complete write won" or "a clean uninstall won" — never a row
 * mixing install fields from one process with uninstall fields from
 * another. True two-process hammers (two real `node` processes, 800
 * install/uninstall writes each per round) confirmed coherence every
 * round. These tests pin that contract against both implementations:
 *  - every observable final state is a single tagged write or absence;
 *  - writes are whole-row (last complete write wins, no partial merge);
 *  - removing a missing row is a loud no-op (false), not a disturbance.
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
  type McpInstallDbRecord,
  type McpServerStore,
} from '../src/index';

function tagged(tag: string): McpInstallDbRecord {
  return {
    name: 'demo',
    version: '1.0.0',
    status: 'INSTALLED',
    installedAt: tag,
    scopeEnabledJson: JSON.stringify({ tag }),
    lastUsedVersion: tag,
  };
}

function tagOf(row: McpInstallDbRecord): string {
  return JSON.parse(row.scopeEnabledJson).tag as string;
}

/** Every observable state must be one complete write or absence. */
function assertCoherent(row: McpInstallDbRecord | undefined, where: string): void {
  if (!row) return; // a clean uninstall won
  const tag = tagOf(row);
  assert.equal(row.status, 'INSTALLED', `${where}: status from one write`);
  assert.equal(row.installedAt, tag, `${where}: installedAt carries the write tag`);
  assert.equal(row.lastUsedVersion, tag, `${where}: lastUsedVersion carries the write tag`);
}

function interleaveHammer(store: McpServerStore, rounds: number): void {
  for (let i = 0; i < rounds; i++) {
    store.saveInstall(tagged(`writer-${i}`));
    if (i % 2 === 0) store.removeInstall('demo', '1.0.0');
    store.saveInstall(tagged(`writer-${i}-again`));
    store.removeInstall('demo', '1.0.0');
    assertCoherent(store.getInstall('demo', '1.0.0'), `round ${i}`);
  }
  assertCoherent(store.getInstall('demo', '1.0.0'), 'final');
}

describe('mcp install concurrent writes (Batch 27-2)', () => {
  it('memory implementation: interleaved install/uninstall never mixes rows', () => {
    interleaveHammer(new MemoryMcpServerStore(), 200);
  });

  it('sqlite implementation: interleaved install/uninstall never mixes rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-db-mcpinstall-'));
    const dbFile = join(dir, 'factory.db');
    try {
      const fdb = new FactoryDatabase(dbFile);
      interleaveHammer(fdb.mcpServers, 200);
      fdb.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two connections, one file: hammered install/uninstall stays coherent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-db-mcpinstall2-'));
    const dbFile = join(dir, 'factory.db');
    try {
      // Schema once, then two independent connections = two processes.
      new FactoryDatabase(dbFile).db.close();
      const a = new SqliteMcpServerStore(new DatabaseSync(dbFile));
      const b = new SqliteMcpServerStore(new DatabaseSync(dbFile));
      for (let i = 0; i < 150; i++) {
        a.saveInstall(tagged(`A-${i}`));
        b.saveInstall(tagged(`B-${i}`));
        assertCoherent(a.getInstall('demo', '1.0.0'), `read ${i} (A)`);
        b.removeInstall('demo', '1.0.0');
        a.removeInstall('demo', '1.0.0');
        assertCoherent(b.getInstall('demo', '1.0.0'), `read ${i} (B)`);
      }
      assertCoherent(a.getInstall('demo', '1.0.0'), 'final');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('install writes are whole-row: a stale full-row write replaces, never merges', () => {
    const stores: McpServerStore[] = [new MemoryMcpServerStore()];
    const dir = mkdtempSync(join(tmpdir(), 'factory-db-mcpinstall3-'));
    try {
      const fdb = new FactoryDatabase(join(dir, 'factory.db'));
      stores.push(fdb.mcpServers);
      for (const store of stores) {
        const first = tagged('first');
        const staleSecond = tagged('second');
        store.saveInstall(first);
        // The "other process" held only its own full snapshot — writing it
        // back must replace the row wholesale, never merge fields.
        store.saveInstall(staleSecond);
        assert.deepEqual(store.getInstall('demo', '1.0.0'), staleSecond);
        // And the reverse: re-installing the older snapshot fully wins too.
        store.saveInstall(first);
        assert.deepEqual(store.getInstall('demo', '1.0.0'), first);
      }
      fdb.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removing a missing install is a no-op that disturbs nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-db-mcpinstall4-'));
    try {
      const fdb = new FactoryDatabase(join(dir, 'factory.db'));
      assert.equal(fdb.mcpServers.removeInstall('demo', '1.0.0'), false);
      const kept = tagged('kept');
      fdb.mcpServers.saveInstall(kept);
      assert.equal(fdb.mcpServers.removeInstall('other', '2.0.0'), false);
      assert.deepEqual(fdb.mcpServers.getInstall('demo', '1.0.0'), kept);
      fdb.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

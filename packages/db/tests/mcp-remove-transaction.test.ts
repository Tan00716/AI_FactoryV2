/**
 * removeServer atomicity + orphan-install defensive scan — Batch 28.
 *
 * Batch 27-2 audited the real seam: `removeServer` was two bare
 * DELETEs, so a concurrent process's saveInstall landing between
 * them was silently wiped, and a crash between them left the
 * registration gone with its install row still behind. Batch 28
 * wraps the two deletes in one BEGIN IMMEDIATE … COMMIT unit.
 *
 * What this pins (honest semantics — read before believing more):
 *  - a fault between the deletes rolls the whole unit back
 *    (nothing half-deleted);
 *  - a racing saveInstall inside the unit is deleted together with
 *    the registration (no orphan committed);
 *  - a saveInstall landing *after* the unit commits is an observable
 *    orphan, not a silently lost write — `removeOrphanInstalls`
 *    finds it and removes it loudly (the caller audits);
 *  - legit (registered) installs are never touched by the scan.
 *
 * The optional fault hook only exists on the sqlite implementation's
 * delete path (memory is single-threaded and synchronous, so its two
 * deletes are already one indivisible step — no between to inject
 * into). The hook runs *between* the deletes on sqlite and *after*
 * them on memory; tests below assert the documented behavior per
 * implementation, not a false parity.
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
  type McpServerDbRecord,
  type McpServerStore,
} from '../src/index';

function serverRow(name: string, version: string): McpServerDbRecord {
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

function installRow(name: string, version: string, tag: string): McpInstallDbRecord {
  return {
    name,
    version,
    status: 'INSTALLED',
    installedAt: tag,
    scopeEnabledJson: JSON.stringify({ tag }),
    lastUsedVersion: tag,
  };
}

function seed(store: McpServerStore, name: string, version: string, tag: string): void {
  store.saveServer(serverRow(name, version));
  store.saveInstall(installRow(name, version, tag));
}

function withSqlite(fn: (store: SqliteMcpServerStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-rmtxn-'));
  const dbFile = join(dir, 'factory.db');
  try {
    new FactoryDatabase(dbFile).db.close(); // schema only
    const store = new SqliteMcpServerStore(new DatabaseSync(dbFile));
    fn(store);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('removeServer atomic unit (Batch 28)', () => {
  it('sqlite: normal remove deletes server and install together', () => {
    withSqlite((store) => {
      seed(store, 'demo', '1.0.0', 't1');
      assert.equal(store.removeServer('demo', '1.0.0'), true);
      assert.equal(store.getServer('demo', '1.0.0'), undefined);
      assert.equal(store.getInstall('demo', '1.0.0'), undefined);
      assert.equal(store.removeServer('demo', '1.0.0'), false);
    });
  });

  it('sqlite: fault between the deletes rolls the whole unit back', () => {
    withSqlite((store) => {
      seed(store, 'demo', '1.0.0', 't1');
      assert.throws(
        () =>
          store.removeServer('demo', '1.0.0', {
            afterServerDelete: () => {
              throw new Error('crash-simulation');
            },
          }),
        /crash-simulation/,
      );
      // Nothing half-deleted: both rows still fully present.
      assert.ok(store.getServer('demo', '1.0.0'), 'server row rolled back');
      assert.equal(
        store.getInstall('demo', '1.0.0')?.installedAt,
        't1',
        'install row rolled back, tag intact',
      );
    });
  });

  it('sqlite: racing write injected between the deletes is not half-committed', () => {
    withSqlite((store) => {
      seed(store, 'demo', '1.0.0', 't1');
      // Simulate the old lost-write seam: a concurrent saveInstall
      // landing between the two deletes. Inside the atomic unit it
      // must either roll back with the unit or be deleted with it —
      // never survive as a half-committed orphan.
      assert.throws(
        () =>
          store.removeServer('demo', '1.0.0', {
            afterServerDelete: () => {
              store.saveInstall(installRow('demo', '1.0.0', 'racer'));
              throw new Error('crash-simulation');
            },
          }),
        /crash-simulation/,
      );
      assert.ok(store.getServer('demo', '1.0.0'), 'server row intact');
      assert.equal(
        store.getInstall('demo', '1.0.0')?.installedAt,
        't1',
        'racing write rolled back with the unit; original tag wins',
      );
      // Same race without the crash: the racing write lands inside
      // the unit and is deleted together with the registration —
      // observable as absent, not as a silent orphan.
      assert.equal(
        store.removeServer('demo', '1.0.0', {
          afterServerDelete: () => {
            store.saveInstall(installRow('demo', '1.0.0', 'racer'));
          },
        }),
        true,
      );
      assert.equal(store.getServer('demo', '1.0.0'), undefined);
      assert.equal(store.getInstall('demo', '1.0.0'), undefined);
      assert.deepEqual(store.removeOrphanInstalls(), []);
    });
  });

  it('sqlite: write landing after the commit is an observable orphan, not a lost write', () => {
    withSqlite((store) => {
      seed(store, 'demo', '1.0.0', 't1');
      // A second process's saveInstall that used to be silently
      // wiped now lands after the commit: observable, and the
      // defensive scan removes it loudly.
      assert.equal(store.removeServer('demo', '1.0.0'), true);
      store.saveInstall(installRow('demo', '1.0.0', 'late-writer'));
      assert.equal(
        store.getInstall('demo', '1.0.0')?.installedAt,
        'late-writer',
        'the late write is NOT silently lost anymore — it is observable',
      );
      assert.deepEqual(store.removeOrphanInstalls(), ['demo@1.0.0']);
      assert.equal(store.getInstall('demo', '1.0.0'), undefined);
    });
  });

  it('memory: remove is synchronously atomic, scan finds orphans', () => {
    const store = new MemoryMcpServerStore();
    seed(store, 'demo', '1.0.0', 't1');
    assert.equal(store.removeServer('demo', '1.0.0'), true);
    assert.equal(store.getServer('demo', '1.0.0'), undefined);
    assert.equal(store.getInstall('demo', '1.0.0'), undefined);
    assert.equal(store.removeServer('demo', '1.0.0'), false);
    // Orphan: install with no registration.
    store.saveInstall(installRow('ghost', '2.0.0', 'g1'));
    assert.deepEqual(store.removeOrphanInstalls(), ['ghost@2.0.0']);
    assert.equal(store.getInstall('ghost', '2.0.0'), undefined);
  });

  it('orphan scan leaves legit installs alone (both implementations)', () => {
    const memory = new MemoryMcpServerStore();
    seed(memory, 'keep', '1.0.0', 'k1');
    memory.saveInstall(installRow('ghost', '9.9.9', 'g1'));
    assert.deepEqual(memory.removeOrphanInstalls(), ['ghost@9.9.9']);
    assert.equal(memory.getInstall('keep', '1.0.0')?.installedAt, 'k1');
    withSqlite((store) => {
      seed(store, 'keep', '1.0.0', 'k1');
      store.saveInstall(installRow('ghost', '9.9.9', 'g1'));
      assert.deepEqual(store.removeOrphanInstalls(), ['ghost@9.9.9']);
      assert.equal(store.getInstall('keep', '1.0.0')?.installedAt, 'k1');
      assert.deepEqual(store.removeOrphanInstalls(), [], 'scan is idempotent');
    });
  });
});

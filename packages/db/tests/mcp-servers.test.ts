/**
 * Durable MCP registrations — SPEC v2 §46 / §34.1 (Batch 21).
 *
 * One scripted sequence, run identically against the in-memory
 * reference and the SQLite implementation:
 *  - save/get round-trips the row field-for-field (recordJson is the
 *    lossless carrier);
 *  - saveServer is an upsert on (name, version);
 *  - listServers returns first-registration order;
 *  - removeServer cascades to the install row;
 *  - markHealthStale flips the flag and leaves everything else;
 *  - install rows round-trip independently of server rows;
 *  - copy contract: mutating a fetched row cannot corrupt stored state;
 *  - rows written by one FactoryDatabase are visible under the next,
 *    on an old database file that predates the tables entirely.
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
  type McpServerDbRecord,
  type McpInstallDbRecord,
  type McpServerStore,
} from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-mcp-'));
  return { dir, file: join(dir, 'factory.db') };
}

function serverRow(name: string, version: string, trust = 'UNKNOWN', policy = 'BLOCKED'): McpServerDbRecord {
  return {
    name,
    version,
    trustLevel: trust,
    approvalPolicy: policy,
    healthStale: false,
    recordJson: JSON.stringify({
      name,
      version,
      provider: 'test',
      transport: 'stdio',
      tools: [{ name: 'probe' }],
      resources: [],
      scopes: [],
      permissions: [],
      trustLevel: trust,
      approvalPolicy: policy,
      credentialRefs: ['REF_A'],
      registeredAt: 1700000000000,
      history: [{ at: 1700000000000, kind: 'REGISTERED' }],
    }),
    assessmentJson: null,
    updatedAt: '2026-10-13T03:00:00.000Z',
    rowVersion: 0,
  };
}

function installRow(name: string, version: string, status = 'INSTALLED'): McpInstallDbRecord {
  return {
    name,
    version,
    status,
    installedAt: '2026-10-13T03:01:00.000Z',
    scopeEnabledJson: '{}',
    lastUsedVersion: null,
  };
}

function script(store: McpServerStore): void {
  assert.deepEqual(store.listServers(), []);
  assert.deepEqual(store.listInstalls(), []);

  const a = serverRow('alpha', '1.0.0');
  store.saveServer(a);
  const got = store.getServer('alpha', '1.0.0');
  assert.ok(got);
  assert.equal(got.rowVersion, 1, 'first write starts the generation at 1');
  assert.deepEqual({ ...got, rowVersion: 0 }, a);

  // Copy contract.
  (got as { trustLevel: string }).trustLevel = 'MUTATED';
  assert.equal(store.getServer('alpha', '1.0.0')?.trustLevel, 'UNKNOWN');

  // Upsert on the same key.
  store.saveServer({ ...a, trustLevel: 'HIGH', approvalPolicy: 'AUTO' });
  const up = store.getServer('alpha', '1.0.0');
  assert.equal(up?.trustLevel, 'HIGH');
  assert.equal(up?.approvalPolicy, 'AUTO');
  // recordJson is the lossless carrier — the upsert above kept the old JSON.
  assert.ok(up?.recordJson.includes('REGISTERED'));

  // Registration order is first-save order.
  store.saveServer(serverRow('beta', '2.0.0'));
  assert.deepEqual(
    store.listServers().map((r) => `${r.name}@${r.version}`),
    ['alpha@1.0.0', 'beta@2.0.0'],
  );

  // Assessment travels on the row.
  const assessed: McpServerDbRecord = {
    ...a,
    trustLevel: 'VERIFIED',
    approvalPolicy: 'HUMAN_APPROVAL',
    assessmentJson: JSON.stringify({
      trustLevel: 'VERIFIED',
      approvalPolicy: 'HUMAN_APPROVAL',
      assessedAt: 1700000001000,
      assessedBy: 'human',
      notes: 'reviewed',
    }),
  };
  store.saveServer(assessed);
  assert.equal(
    JSON.parse(store.getServer('alpha', '1.0.0')?.assessmentJson ?? '{}').assessedBy,
    'human',
  );

  // Health staleness is a flag flip, nothing else moves.
  store.markHealthStale('alpha', '1.0.0');
  const stale = store.getServer('alpha', '1.0.0');
  assert.equal(stale?.healthStale, true);
  assert.equal(stale?.trustLevel, 'VERIFIED');

  // Install rows are independent but cascade on server removal.
  store.saveInstall(installRow('alpha', '1.0.0'));
  store.saveInstall(installRow('beta', '2.0.0', 'PENDING_REVIEW'));
  assert.equal(store.getInstall('alpha', '1.0.0')?.status, 'INSTALLED');
  assert.equal(store.listInstalls().length, 2);
  assert.equal(store.removeServer('beta', '2.0.0'), true);
  assert.equal(store.getServer('beta', '2.0.0'), undefined);
  assert.equal(store.getInstall('beta', '2.0.0'), undefined);
  assert.equal(store.getInstall('alpha', '1.0.0')?.status, 'INSTALLED');
  assert.equal(store.removeServer('beta', '2.0.0'), false);
  assert.equal(store.getServer('nope', '0.0.0'), undefined);
}

describe('durable MCP registrations (§46, Batch 21)', () => {
  it('memory and SQLite agree on every step', () => {
    script(new MemoryMcpServerStore());
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      script(fdb.mcpServers);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rows survive a database reopen (restart fidelity)', () => {
    const { dir, file } = tmpDbFile();
    try {
      {
        const a = new FactoryDatabase(file);
        a.mcpServers.saveServer(serverRow('gamma', '3.0.0', 'HIGH', 'AUTO'));
        a.mcpServers.saveInstall(installRow('gamma', '3.0.0'));
      }
      {
        const b = new FactoryDatabase(file);
        const back = b.mcpServers.getServer('gamma', '3.0.0');
        assert.ok(back, 'registration survives the restart');
        assert.equal(back?.trustLevel, 'HIGH');
        assert.equal(back?.approvalPolicy, 'AUTO');
        assert.equal(b.mcpServers.getInstall('gamma', '3.0.0')?.status, 'INSTALLED');
        b.mcpServers.markHealthStale('gamma', '3.0.0');
      }
      {
        const c = new FactoryDatabase(file);
        assert.equal(c.mcpServers.getServer('gamma', '3.0.0')?.healthStale, true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an old database gains the tables on open', () => {
    const { dir, file } = tmpDbFile();
    try {
      {
        // A database file from before Batch 21: only legacy tables.
        const legacy = new DatabaseSync(file);
        legacy.exec('CREATE TABLE legacy_probe (id TEXT PRIMARY KEY)');
        legacy.close();
      }
      const fdb = new FactoryDatabase(file);
      fdb.mcpServers.saveServer(serverRow('old', '0.1.0'));
      assert.ok(fdb.mcpServers.getServer('old', '0.1.0'));
      fdb.mcpServers.saveInstall(installRow('old', '0.1.0'));
      assert.equal(fdb.mcpServers.getInstall('old', '0.1.0')?.status, 'INSTALLED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

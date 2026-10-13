/**
 * MCP registry cross-process write mutual exclusion — Batch 25.
 *
 * Audit finding: two server processes sharing one DB file each hold
 * their own in-memory registry. Every mutation was a blind full-row
 * upsert computed from possibly-stale memory, so a health write from
 * a stale process SILENTLY REVERTED another process's trust approval
 * (policy AUTO→BLOCKED, trust HIGH→UNKNOWN, TRUST_ASSESSED history
 * and the assessment JSON all dropped).
 *
 * Since Batch 25 the registry emits mutation OPS and the durability
 * layer applies each op atomically against the FRESH row inside a
 * write transaction. These tests pin the fixed semantics with two
 * independent stacks (separate memory, one SQLite file — the faithful
 * model of two processes, since all shared state goes through the
 * file):
 *  1. a stale process's health write no longer reverts a trust approval;
 *  2. concurrent history appends from both processes both survive;
 *  3. a stale re-registration preserves the fresh trust decision;
 *  4. two genuine conflicting trust decisions resolve last-writer-wins
 *     with BOTH audited in history (ordering, not silent revert).
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactoryDatabase } from '@ai-factory/db';
import { McpRegistry, McpManager } from '@ai-factory/mcp';
import {
  hydrateMcpRegistry,
  attachMcpPersistence,
} from '../src/mcp-persistence.ts';

const DEF = {
  name: 'xproc',
  version: '1.0.0',
  provider: 'test',
  transport: 'stdio' as const,
  tools: [],
  resources: [],
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function bootStack(dbFile: string): {
  fdb: FactoryDatabase;
  registry: McpRegistry;
  manager: McpManager;
} {
  const fdb = new FactoryDatabase(dbFile);
  const registry = new McpRegistry();
  const manager = new McpManager(registry);
  hydrateMcpRegistry({ registry, manager, store: fdb.mcpServers });
  attachMcpPersistence({ registry, manager, store: fdb.mcpServers });
  return { fdb, registry, manager };
}

function newDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-mcp-xproc-'));
  dirs.push(dir);
  return join(dir, 'factory.db');
}

function healthReport() {
  return {
    server: 'xproc',
    version: '1.0.0',
    checkedAt: Date.now(),
    overall: 'healthy' as const,
    levels: [],
  };
}

describe('mcp cross-process write mutual exclusion (Batch 25)', () => {
  it('a stale health write does not revert a trust approval', () => {
    const dbFile = newDb();
    const A = bootStack(dbFile);
    A.registry.register(DEF);
    const B = bootStack(dbFile); // B hydrates while still BLOCKED
    A.manager.assessTrust('xproc', '1.0.0', {
      trustLevel: 'HIGH',
      approvalPolicy: 'AUTO',
      assessedBy: 'op-a',
    });
    // B's memory is stale (BLOCKED/UNKNOWN). Its health write must
    // only touch the health field — never the trust decision.
    B.registry.recordHealth('xproc', '1.0.0', healthReport());

    const row = A.fdb.mcpServers.getServer('xproc', '1.0.0')!;
    assert.equal(row.approvalPolicy, 'AUTO', 'approval survives the stale write');
    assert.equal(row.trustLevel, 'HIGH', 'trust level survives the stale write');
    assert.ok(row.assessmentJson, 'assessment JSON survives the stale write');
    const kinds = (JSON.parse(row.recordJson).history as Array<{ kind: string }>).map(
      (h) => h.kind,
    );
    assert.ok(kinds.includes('TRUST_ASSESSED'), 'approval history survives the stale write');
    assert.equal(
      JSON.parse(row.recordJson).health?.overall,
      'healthy',
      "B's health write still lands",
    );
    A.fdb.db.close();
    B.fdb.db.close();
  });

  it('concurrent history appends from both processes both survive', () => {
    const dbFile = newDb();
    const A = bootStack(dbFile);
    A.registry.register(DEF);
    const B = bootStack(dbFile);
    A.registry.appendHistory('xproc', '1.0.0', { kind: 'ENABLED', actor: 'op-a' });
    B.registry.appendHistory('xproc', '1.0.0', { kind: 'DISABLED', actor: 'op-b' });

    const kinds = (
      JSON.parse(A.fdb.mcpServers.getServer('xproc', '1.0.0')!.recordJson).history as Array<{
        kind: string;
        actor?: string;
      }>
    ).map((h) => `${h.kind}:${h.actor ?? ''}`);
    assert.ok(kinds.includes('ENABLED:op-a'), "A's event survives");
    assert.ok(kinds.includes('DISABLED:op-b'), "B's event survives");
    A.fdb.db.close();
    B.fdb.db.close();
  });

  it('a stale re-registration preserves the fresh trust decision', () => {
    const dbFile = newDb();
    const A = bootStack(dbFile);
    A.registry.register(DEF);
    const B = bootStack(dbFile);
    A.manager.assessTrust('xproc', '1.0.0', {
      trustLevel: 'HIGH',
      approvalPolicy: 'AUTO',
      assessedBy: 'op-a',
    });
    // B re-registers the same definition from stale memory: the merge
    // must run against the FRESH row, keeping A's approval.
    B.registry.register({ ...DEF, tools: [{ name: 'new-tool' }] });

    const row = A.fdb.mcpServers.getServer('xproc', '1.0.0')!;
    assert.equal(row.approvalPolicy, 'AUTO');
    assert.equal(row.trustLevel, 'HIGH');
    assert.ok(
      (JSON.parse(row.recordJson).tools as Array<{ name: string }>).some(
        (t) => t.name === 'new-tool',
      ),
      "B's metadata update still lands",
    );
    A.fdb.db.close();
    B.fdb.db.close();
  });

  it('genuine conflicting trust decisions resolve last-writer-wins, both audited', () => {
    const dbFile = newDb();
    const A = bootStack(dbFile);
    A.registry.register(DEF);
    const B = bootStack(dbFile);
    A.manager.assessTrust('xproc', '1.0.0', {
      trustLevel: 'HIGH',
      approvalPolicy: 'AUTO',
      assessedBy: 'op-a',
    });
    // B's operator makes a real, conflicting decision AFTER A's.
    B.manager.assessTrust('xproc', '1.0.0', {
      trustLevel: 'LOW',
      approvalPolicy: 'BLOCKED',
      assessedBy: 'op-b',
    });

    const row = A.fdb.mcpServers.getServer('xproc', '1.0.0')!;
    assert.equal(row.approvalPolicy, 'BLOCKED', 'last genuine decision wins');
    assert.equal(row.trustLevel, 'LOW');
    const assessed = (
      JSON.parse(row.recordJson).history as Array<{ kind: string; actor?: string }>
    ).filter((h) => h.kind === 'TRUST_ASSESSED');
    assert.equal(assessed.length, 2, 'both decisions are audited in history');
    assert.deepEqual(
      assessed.map((h) => h.actor),
      ['op-a', 'op-b'],
    );
    A.fdb.db.close();
    B.fdb.db.close();
  });
});

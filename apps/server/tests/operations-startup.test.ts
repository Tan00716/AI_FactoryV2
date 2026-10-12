/**
 * Operation-ledger startup wiring — SPEC v2 §28.2 (G-59, Batch 10).
 *
 * Boots the real built server (dist/index.js) over a database pre-seeded
 * with external operations a "previous process" left behind, and pins:
 *  1. /api/health reports the startup reconcile summary (SQLite store,
 *     unresolved count, per-disposition counts);
 *  2. the audit trail carries STARTUP_OPERATION_RECONCILE with the
 *     classification (counts + the manual-recovery operation id) and
 *     the MANUAL_RECOVERY_REQUIRED result;
 *  3. booting did not mutate the seeded operations — with no target
 *     ledger answerable at boot, reconcile classifies only; the
 *     irreversible UNKNOWN operation is still UNKNOWN afterwards.
 *
 * Requires the workspace build (root `npm run build`): the server under
 * test is the compiled coordinator, and the seed uses the compiled
 * @ai-factory/db / @ai-factory/runtime packages — same precondition as
 * the other dist-importing server tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactoryDatabase } from '@ai-factory/db';
import { OperationLedger } from '@ai-factory/runtime';

interface HealthBody {
  operations?: {
    store: string;
    unresolvedAtStartup: number;
    safeToRetryAtStartup: number;
    needsManualRecoveryAtStartup: number;
  };
}

interface AuditRow {
  action: string;
  result?: string;
  details: Record<string, unknown>;
}

async function waitForHealth(port: number, child: ChildProcess, timeoutMs = 20_000): Promise<HealthBody> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return (await res.json()) as HealthBody;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`server did not become healthy in ${timeoutMs}ms: ${String(lastError)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('operation ledger startup reconcile (§28.2)', () => {
  it('boots over pre-seeded non-terminal ops: health + audit carry the classification, states untouched', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-ops-'));
    const file = join(dir, 'factory.db');
    let migrateId = '';
    let child: ChildProcess | undefined;
    try {
      // Seed the "previous process": one irreversible UNKNOWN (manual
      // recovery), one reversible DISPATCHED (safe to retry), one
      // CONFIRMED (terminal — must not be counted at all).
      const fdb = new FactoryDatabase(file);
      const seed = new OperationLedger({ store: fdb.operations });
      const migrate = seed.prepare({ logicalAction: 'db:migrate', candidateDigest: 'c1', environment: 'prod', reversible: false });
      migrateId = migrate.id;
      seed.dispatch(migrate.id);
      seed.markUnknown(migrate.id, 'process killed');
      const hook = seed.prepare({ logicalAction: 'webhook:send', candidateDigest: 'c2', environment: 'prod', reversible: true });
      seed.dispatch(hook.id);
      const done = seed.prepare({ logicalAction: 'deploy', candidateDigest: 'c3', environment: 'prod', reversible: false });
      seed.dispatch(done.id);
      seed.confirm(done.id, true, 'deploy-1');
      fdb.close();

      const port = 24_000 + Math.floor(Math.random() * 20_000);
      const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), DB_PATH: file };
      delete env['FACTORY_API_TOKEN'];
      const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
      child = spawn(process.execPath, [serverMain], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env,
        stdio: 'ignore',
      });

      const health = await waitForHealth(port, child);
      assert.equal(health.operations?.store, 'sqlite');
      assert.equal(health.operations?.unresolvedAtStartup, 2);
      assert.equal(health.operations?.safeToRetryAtStartup, 1);
      assert.equal(health.operations?.needsManualRecoveryAtStartup, 1);

      const auditRes = await fetch(`http://127.0.0.1:${port}/api/audit?limit=500`);
      assert.ok(auditRes.ok);
      const rows = (await auditRes.json()) as AuditRow[];
      const rec = rows.find((r) => r.action === 'STARTUP_OPERATION_RECONCILE');
      assert.ok(rec, 'startup reconcile audit record exists');
      assert.equal(rec.result, 'MANUAL_RECOVERY_REQUIRED');
      assert.equal(rec.details['total'], 2);
      assert.equal(rec.details['safeToRetry'], 1);
      assert.equal(rec.details['needsManualRecovery'], 1);
      assert.deepEqual(rec.details['needsManualRecoveryIds'], [migrateId]);

      child.kill('SIGTERM');
      await new Promise((r) => child!.once('exit', r));
      child = undefined;

      // The boot pass classified only: nothing was adopted or replayed.
      const fdb2 = new FactoryDatabase(file);
      try {
        const states = new Map(
          new OperationLedger({ store: fdb2.operations })
            .listOperations()
            .map((o) => [o.logicalAction, o.state]),
        );
        assert.equal(states.get('db:migrate'), 'UNKNOWN');
        assert.equal(states.get('webhook:send'), 'DISPATCHED');
        assert.equal(states.get('deploy'), 'CONFIRMED_SUCCEEDED');
      } finally {
        fdb2.close();
      }
    } finally {
      if (child) {
        child.kill('SIGKILL');
        await new Promise((r) => child!.once('exit', r));
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

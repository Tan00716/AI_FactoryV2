/**
 * Demo: deploy rollback — spec §77–§78.
 *
 *  1. Snapshot the service workspace "before production deployment".
 *  2. A deploy corrupts app.js; the RecoveryLoop runs the deploy step.
 *  3. The deploy fails twice (BUILD_ERROR → retry, then revert-change).
 *  4. The revert-change hook restores the pre-deploy snapshot; the loop
 *     retries and the deploy verification passes.
 *
 * Run: node dist/demo/deploy-rollback.demo.js
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  RecoveryLoop,
  SnapshotStore,
  type RecoveryAuditEvent,
} from '../src/index';

function logAudit(e: RecoveryAuditEvent): void {
  const extra = [
    e.failureType ?? '',
    e.strategy ?? '',
    e.message ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  console.log(`[audit] ${e.event} (attempt ${e.attempt}) ${extra}`);
}

async function main(): Promise<void> {
  const ws = mkdtempSync(join(tmpdir(), 'svc-'));
  const storeRoot = mkdtempSync(join(tmpdir(), 'recovery-store-'));
  const store = new SnapshotStore(storeRoot);

  try {
    // 1. Service is healthy; snapshot before production deployment (§77).
    writeFileSync(join(ws, 'app.js'), 'v1 stable\n');
    const snap = store.take(ws, { tag: 'before production deployment' });
    console.log(`snapshot ${snap.id.slice(0, 8)} taken (${snap.files.length} file(s)) — sealed: ${snap.sealed}`);

    // 2. The deploy ships a broken bundle.
    writeFileSync(join(ws, 'app.js'), 'v2 BROKEN {{{ syntax error');
    console.log('deploy shipped a broken bundle');

    // 3. Recovery loop around the deploy step (§78).
    let calls = 0;
    const loop = new RecoveryLoop({
      maxAttempts: 4,
      audit: logAudit,
      hooks: {
        'revert-change': async () => {
          console.log('>> revert-change: restoring pre-deploy snapshot');
          const backup = store.restore(snap.id, ws);
          console.log(`>> current (broken) state backed up as ${backup.id.slice(0, 8)} (tag: ${backup.tag})`);
          return { type: 'retry' };
        },
      },
    });

    const res = await loop.run(async () => {
      calls++;
      if (calls <= 2) throw new Error('build failed: failed to compile app.js');
      const content = readFileSync(join(ws, 'app.js'), 'utf8');
      if (!content.startsWith('v1 stable')) throw new Error('deploy verification failed');
      return 'deployed';
    });

    console.log(`\nresult: ${res.status} after ${res.attempts} attempt(s)`);
    console.log(`strategy history: ${res.history.map((h) => h.strategy).join(' → ')}`);
    console.log(`app.js now: ${JSON.stringify(readFileSync(join(ws, 'app.js'), 'utf8'))}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(storeRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

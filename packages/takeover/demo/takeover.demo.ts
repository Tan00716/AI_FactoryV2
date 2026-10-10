/**
 * Human takeover demo — SPEC v2 §31.
 *
 *  run-ai-1 holds the workspace lease and is mid-implementation.
 *  A human requests takeover: the worker is quiesced, fenced out via the
 *  lease manager (generation bump), quiet is verified, a snapshot is taken,
 *  the human edits with full attribution, then returns control — overlapping
 *  files get a real three-way merge (never a hard reset), affected evidence
 *  is revalidated, and the AI resumes on a FRESH lease. The old worker's
 *  late write is refused: no silent overwrite.
 *
 * Run after building the package:
 *   npx tsc -p packages/takeover/tsconfig.json
 *   node packages/takeover/dist/demo/takeover.demo.js
 */
import { LeaseManager } from '@ai-factory/leases';
import { SilentOverwriteRefused, TakeoverManager } from '../src/index';

async function main(): Promise<void> {
  const leases = new LeaseManager();
  const mgr = new TakeoverManager(leases, {
    quiesceWorker: async (runId) => console.log(`[quiesce] ${runId} acked stop-at-safe-point`),
    noUncontrolledWrites: async () => true,
    snapshot: async (runId) => {
      console.log(`[snapshot] captured for ${runId}`);
      return 'snap:run-ai-1@t42';
    },
    threeWayMerge: async (files, base) => {
      console.log(`[merge] 3-way merge of ${files.join(', ')} on base ${base} (human side kept)`);
      return files.map((f) => `${f}:merged`);
    },
    revalidateEvidence: async (ids) => {
      console.log(`[revalidate] ${ids.join(', ')} re-checked against human edits`);
      return ids.map((id) => `${id}:revalidated`);
    },
  });

  const aiLease = leases.acquire('ws:checkout', 'run-ai-1', 600_000);
  console.log(`run-ai-1 holds ws:checkout (generation=${aiLease.generation})`);

  const t = mgr.requestTakeover('run-ai-1', 'ws:checkout', 'human:tan');
  console.log(`takeover requested → UI shows: ${mgr.display(t.id)}`);

  const owned = await mgr.acquireControl(t.id);
  console.log(`control acquired (fenced at generation=${owned.fencedGeneration}) → UI: ${mgr.display(t.id)}`);

  mgr.applyHumanEdit(t.id, {
    authorId: 'human:tan',
    baseRevision: owned.snapshotRef as string,
    fileHashes: { 'src/checkout.ts': 'sha:human-fix' },
    diff: '- charge(); charge();\n+ chargeOnce();',
  });
  console.log('human edit recorded with author_type=HUMAN');

  console.log('--- old worker wakes up late and tries to write ---');
  try {
    mgr.assertAiWriteAllowed('ws:checkout', aiLease.fencing_token, 'src/checkout.ts');
    console.log('ERROR: stale write allowed!');
  } catch (err) {
    if (err instanceof SilentOverwriteRefused) console.log(`refused: ${err.code} — no silent overwrite`);
    else throw err;
  }

  const done = await mgr.returnControl(t.id, {
    overlappingFiles: ['src/checkout.ts'],
    affectedEvidenceIds: ['ev-checkout-tests'],
  });
  console.log(`returned → state=${done.state}, merged=${done.mergedFiles}, evidence=${done.revalidatedEvidence}`);
  console.log(`UI: ${mgr.display(t.id)}; AI resumes on a fresh lease, old token stays dead`);
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

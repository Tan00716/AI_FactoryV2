/**
 * Durable execution demo — SPEC v2 §28.
 *
 *  1. A deploy is PREPARED + DISPATCHED, then the process "crashes".
 *  2. On restart, reconcile() queries the target ledger FIRST:
 *     - the target did it → adopt, no replay;
 *     - the target is silent + irreversible → controlled recovery, NEVER blind replay.
 *  3. Step intents are persisted before execution; disk-full stops new
 *     dangerous writes while the emergency log survives.
 *
 * Run after building the package:
 *   npx tsc -p packages/runtime/tsconfig.json
 *   node packages/runtime/dist/demo/durable.demo.js
 */
import {
  AgentLoop,
  BlindReplayRefused,
  LoopStagnation,
  OperationLedger,
  RunStateMachine,
  StepIntentStore,
  StorageGuard,
} from '../src/index';

async function main(): Promise<void> {

  console.log('--- 1. crash during a production deploy ---');
  const ledger = new OperationLedger();
  const deploy = ledger.prepare({
    logicalAction: 'deploy:prod:web',
    candidateDigest: 'sha:candidate-9f2',
    environment: 'prod',
    reversible: false, // production deploy: treat as irreversible here
  });
  ledger.dispatch(deploy.id);
  ledger.markUnknown(deploy.id, 'worker process killed mid-deploy');
  console.log(`state after crash: ${ledger.get(deploy.id)?.state}`);

  console.log('--- 2a. restart: target ledger shows it actually deployed ---');
  const r1 = ledger.reconcile(deploy.id, {
    findByIdempotencyKey: () => ({ outcome: 'succeeded', ledgerRef: 'prod-deploy-7781' }),
  });
  console.log(`verdict=${r1.action} — ${r1.detail}`);

  console.log('--- 2b. restart: target silent + irreversible → no blind replay ---');
  const ledger2 = new OperationLedger();
  const migrate = ledger2.prepare({
    logicalAction: 'db:migrate:drop-legacy-column',
    candidateDigest: 'sha:candidate-9f2',
    environment: 'prod',
    reversible: false,
  });
  ledger2.dispatch(migrate.id);
  ledger2.markUnknown(migrate.id, 'network partition, no acknowledgement');
  const r2 = ledger2.reconcile(migrate.id, { findByIdempotencyKey: () => undefined });
  console.log(`verdict=${r2.action}`);
  try {
    ledger2.assertReplayable(migrate.id, { findByIdempotencyKey: () => undefined });
    console.log('ERROR: replay was allowed!');
  } catch (err) {
    if (err instanceof BlindReplayRefused) {
      console.log(`guard held: ${err.code} — escalate to controlled recovery`);
    } else {
      throw err;
    }
  }

  console.log('--- 3. intent persisted before execution; disk-full safe mode ---');
  const intents = new StepIntentStore();
  const intent = intents.persistIntent('run-7', 'shell', { cmd: 'pytest -x' });
  console.log(`intent ${intent.id.slice(0, 8)}… persisted as ${intent.status} before the tool ran`);
  const guard = new StorageGuard();
  guard.reportWritable(false); // disk full mid-run
  try {
    guard.assertCanWrite(true, 'deploy prod');
  } catch {
    console.log('dangerous write refused while disk is full');
  }
  guard.emergencyLogLine('run-7 suspended: disk full, 1 intent pending reconcile');
  console.log('emergency log kept:', guard.drainEmergencyLog());

  console.log('--- 4. run states: SUCCEEDED names its contract, never "task done" ---');
  const run = new RunStateMachine('run-7', 'task-42');
  run.transition('STARTING');
  run.transition('RUNNING');
  run.succeed('smoke tests 8/8 green on candidate sha:candidate-9f2');
  console.log(`final=${run.state} contract="${run.snapshot.outputContract}"`);
  console.log('--- 5. loop stagnation: same fingerprint 3x with no new evidence ---');
  const loop = new AgentLoop({
    budgets: { maxSteps: 60, timeMs: 60_000, maxRetries: 20 },
    stagnationLimit: 3,
  });
  try {
    await loop.run(async () => ({
      ok: false,
      error: 'pytest: 3 failed (same output)',
      errorSignature: 'pytest:3-failed',
    }));
    console.log('ERROR: loop did not stagnate');
  } catch (err) {
    if (err instanceof LoopStagnation) {
      console.log(`stagnation detected: ${err.message.slice(0, 80)}… → auto-escalate`);
    } else {
      throw err;
    }
  }
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

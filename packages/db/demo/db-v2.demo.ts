/**
 * db v2 demo — SPEC v2 §48.3 / §48.4.
 *
 *  1. A cross-project authorization mis-link is rejected (no IDOR).
 *  2. Budget: oversell rejected; settlement idempotent (no double charge).
 *  3. deploy script: same idempotency key + different payload refuses the
 *     second action; UNKNOWN external results are reconciled, not replayed.
 *
 * Run: node packages/db/dist/demo/db-v2.demo.js
 */
import {
  assertNoCrossProjectLink,
  BudgetLedger,
  deployScript,
  newTxContext,
  runTxScript,
  type DeployDeps,
} from '../src/index';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}

console.log('== 1. cross-project authorization link ==');
check('mis-linked chain rejected', () => {
  let threw = false;
  try {
    assertNoCrossProjectLink([
      { kind: 'root-authorization', id: 'ra1', orgId: 'o1', projectId: 'proj-A' },
      { kind: 'delegation', id: 'd1', orgId: 'o1', projectId: 'proj-B' },
    ]);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('cross-project link was NOT rejected');
});

console.log('== 2. budget ledger ==');
check('oversell rejected, settle idempotent', () => {
  const ledger = new BudgetLedger({ env1: 100_00 });
  ledger.reserve('env1', 'res-1', 60_00);
  let oversell = false;
  try {
    ledger.reserve('env1', 'res-2', 50_00);
  } catch {
    oversell = true;
  }
  if (!oversell) throw new Error('oversell was NOT rejected');
  ledger.settle('res-1');
  const afterFirst = ledger.balanceOf('env1');
  ledger.settle('res-1'); // idempotent: no double charge
  if (ledger.balanceOf('env1') !== afterFirst) throw new Error('double charge!');
  console.log(`       balance after settle: ${ledger.balanceOf('env1')} (minor units)`);
});

console.log('== 3. deploy idempotency + UNKNOWN reconciliation ==');
check('replayed key with different payload refused; UNKNOWN reconciled', () => {
  const seen = new Map<string, string>();
  const deps: DeployDeps = {
    registerIdempotencyKey: (k, op) => {
      const prev = seen.get(k);
      if (!prev) { seen.set(k, op); return 'NEW'; }
      return prev === op ? 'SEEN_SAME' : 'SEEN_DIFFERENT';
    },
    acquireDeployLease: () => 1,
    checkApprovedDigest: (a, b) => { if (a !== b) throw new Error('digest mismatch'); },
    brokerExecute: () => 'UNKNOWN',
    recordOperationResult: () => {},
    reconcile: (op, result) => {
      console.log(`       reconciled ${op} with result=${result} (no blind replay)`);
    },
    newEventId: () => `evt-${Math.random().toString(36).slice(2, 8)}`,
    nowIso: () => new Date().toISOString(),
  };
  const base = {
    operationId: 'op-1', idempotencyKey: 'deploy-key-1', taskId: 't1',
    artifactDigest: 'sha:aaa', approvedDigest: 'sha:aaa', environment: 'prod',
    resourceId: 'prod', runId: 'run-1', ttlMs: 60_000,
  };
  const outbox = runTxScript('deploy', deployScript(deps, base), newTxContext());
  if (!outbox.some((e) => e.event_type === 'EXTERNAL_OP_UNKNOWN')) {
    throw new Error('UNKNOWN result not recorded');
  }
  let refused = false;
  try {
    runTxScript(
      'deploy',
      deployScript(deps, { ...base, operationId: 'op-2', artifactDigest: 'sha:evil', approvedDigest: 'sha:evil' }),
      newTxContext(),
    );
  } catch {
    refused = true;
  }
  if (!refused) throw new Error('second action with same key was NOT refused');
});

if (failures > 0) {
  console.log(`\n${failures} demo check(s) FAILED`);
  process.exit(1);
}
console.log('\ndb v2 demo: all checks passed');

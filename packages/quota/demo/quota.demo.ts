/**
 * Quota policies demo — SPEC v2 §27.
 *
 *  1. A quota hit fires under each of the three policies:
 *     STRICT_PROVIDER parks the runs (unknown reset is stated, not invented);
 *     ALLOW_COMPATIBLE_FALLBACK migrates only after compatibility checks;
 *     GLOBAL_PAUSE_ON_PRIMARY_LIMIT pauses dev but keeps safety running.
 *  2. A cross-model handoff package is sealed, hash-verified, and activated
 *     only after the old run is settled — no dual writes.
 *
 * Run after building the package:
 *   npx tsc -p packages/quota/tsconfig.json
 *   node packages/quota/dist/demo/quota.demo.js
 */
import {
  checkFallbackCompatibility,
  createHandoffPackage,
  decideQuotaPolicy,
  describeUsage,
  HandoffActivationGuard,
  IncompatibleFallback,
  QuotaMonitor,
  verifyHandoffPackage,
} from '../src/index';

const bucket = {
  providerAccountId: 'acme-acct',
  workspaceId: 'ws-webapp',
  limitBucket: 'codex:standard',
  // The provider reported no numbers and no reset — everything is unknown.
  authState: 'ok' as const,
  collectedAt: new Date(1_000).toISOString(),
  freshness: 'stale' as const,
};

console.log('quota display:', describeUsage(bucket));

const monitor = new QuotaMonitor({ now: () => 2_000 });
const event = monitor.recordLimitSignal('insufficient credits', bucket);
console.log(`limit event: ${event.kind}`);

for (const policy of ['STRICT_PROVIDER', 'ALLOW_COMPATIBLE_FALLBACK', 'GLOBAL_PAUSE_ON_PRIMARY_LIMIT'] as const) {
  monitor.setPolicy(policy);
  const d = monitor.decide(event, ['run-101', 'run-102']);
  console.log(`[${policy}] → ${d.action}: ${d.note}`);
}

console.log('--- fallback compatibility gate ---');
const check = checkFallbackCompatibility(
  { capabilities: ['tools', 'vision'], dataClasses: ['internal'], budgetNeeded: 200, permissionCeiling: ['shell.execute'] },
  { providerAccountId: 'backup-acct', limitBucket: 'alt:std', capabilities: ['tools'], allowedDataClasses: ['public'], budgetRemaining: 50 },
);
try {
  if (check.reasons.length > 0) throw new IncompatibleFallback(check);
  console.log('fallback approved');
} catch (err) {
  console.log(`fallback refused: ${(err as Error).message}`);
}

console.log('--- cross-model handoff: seal, verify, settle old run first ---');
const pkg = createHandoffPackage({
  taskId: 'task-9',
  runId: 'run-101',
  rootAuthorizationId: 'auth-root-1',
  requirementVersion: 'REQ-9@2',
  acceptanceCriteriaVersions: ['AC-1@2'],
  goal: 'fix checkout race',
  scope: 'checkout service',
  plan: ['repro', 'fix', 'verify'],
  completed: ['repro'],
  notCompleted: ['fix', 'verify'],
  decisions: [],
  diffRefs: [],
  fileRefs: ['src/checkout.ts'],
  commands: ['pytest tests/checkout'],
  tests: [{ name: 'checkout-race', outcome: 'fail' }],
  failures: ['race under load'],
  artifactRefs: [],
  evidenceRefs: ['ev-77'],
  risks: [{ severity: 'HIGH', description: 'double charge risk' }],
  workerHost: 'host-a',
  environment: 'dev',
  pendingSideEffects: ['none'],
  checkpointRef: 'ckpt-101',
  policyVersion: 'pol@7',
  capabilityCeilingRef: 'cap-9',
  budgetUsed: 300,
  budgetRemaining: 700,
  contextSourceManifest: [{ source: 'repo', version: 'v2', hash: 'abc' }],
});
verifyHandoffPackage(pkg);
console.log(`handoff ${pkg.handoffId.slice(0, 8)}… sealed (hash ${pkg.packageHash.slice(0, 12)}…) and verified`);

const guard = new HandoffActivationGuard();
guard.registerOldRun('run-101');
try {
  guard.assertOldRunSettled('run-101');
  console.log('ERROR: new run activated while old still live');
} catch {
  console.log('activation blocked: old run still ACTIVE — no dual writes');
}
guard.markOldRunSettled('run-101', 'PAUSED');
guard.assertOldRunSettled('run-101');
console.log('old run paused → replacement run may activate on host-b');
console.log('done.');

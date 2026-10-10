/**
 * Release hardening demo — SPEC v2 §40/§41.
 *
 *  1. External CI: unverified PASS claim refused; verified + current accepted.
 *  2. Risk: auth change → HIGH (LLM-proposed LOW cannot lower the floor).
 *  3. Pre-deploy gates: missing UAT named; all valid → ok.
 *  4. Canary: telemetry lost → HOLD (never promote on zero errors).
 *  5. Outcome: human-judgment AC → WAITING_HUMAN; emergency on irreversible
 *     change without runbook → REQUIRE_HUMAN.
 *  6. Fake rollback of an irreversible migration → forbidden.
 *
 * Run: npm run build -w @ai-factory/cicd && node packages/cicd/dist/demo/release-hardening.demo.js
 */
import {
  ExternalCiResultVerifier,
  UnverifiedCiResultError,
  assessRisk,
  checkPreDeployGates,
  PRE_DEPLOY_GATES,
  defineCanaryPlan,
  evaluateStage,
  evaluateOutcome,
  openObservationWindow,
  decideEmergencyRecovery,
  assertSafeAutoRecovery,
  FakeRollbackForbiddenError,
  StageObservation,
} from '../src/index';

console.log('1. external CI verification');
const verifier = new ExternalCiResultVerifier((r) => r.authProof === 'sig-valid');
const claim = {
  platform: 'github', repository: 'org/app', ref: 'refs/heads/main',
  headSha: 'abc123', jobId: 'job-1', verdict: 'PASS' as const,
  authProof: 'forged', receivedAt: new Date().toISOString(),
};
try {
  verifier.accept(claim, 'abc123');
  console.log('   ERROR: unverified PASS accepted');
} catch (err) {
  console.log('   unverified PASS refused:', err instanceof UnverifiedCiResultError);
}
console.log('   verified result accepted:', verifier.accept({ ...claim, authProof: 'sig-valid', jobId: 'job-2' }, 'abc123').length > 0);

console.log('2. risk floor vs LLM proposal');
const risk = assessRisk({
  changeType: 'auth-change', blastRadius: 'single-service',
  securityDataImpact: true, hasMigration: false, externalSideEffects: false,
  recoveryReady: true, observabilityReady: true, testIndependence: true,
  environmentDrift: false, businessCritical: false,
  llmProposedLevel: 'LOW', llmRationale: 'small diff',
});
console.log(`   floor=${risk.floor} level=${risk.level} auth=${risk.authorization.kind} (expected HIGH/HUMAN_PLUS_SPECIALIST)`);

console.log('3. pre-deploy gates');
const gates = Object.fromEntries(PRE_DEPLOY_GATES.map((g) => [g, 'VALID']));
delete (gates as Record<string, string>).uat;
const missing = checkPreDeployGates({ gates: gates as never });
console.log('   missing:', JSON.stringify(missing.missing), '| ok:', missing.ok);

console.log('4. canary telemetry lost → HOLD');
const stage = {
  name: 'canary-5pct', cohort: '5%', trafficDenominator: 'prod-traffic',
  minObservationMs: 600_000, minSample: 1000,
  metrics: ['error_rate'], baselineRef: 'baseline-7d',
  thresholds: { error_rate: { max: 0.01 } },
  promotionRule: (o: StageObservation) => o.metricValues.error_rate < 0.01,
  abortRule: (o: StageObservation) => o.metricValues.error_rate > 0.05,
  maxWaitMs: 3_600_000,
};
defineCanaryPlan({ artifactDigest: 'digest-1', targetEnv: 'PROD', stages: [stage] });
const decision = evaluateStage(stage, {
  stageName: 'canary-5pct', sampleSize: 0, telemetryPresent: false,
  observedMs: 900_000, metricValues: {}, at: new Date().toISOString(),
});
console.log('   decision:', decision, '(expected HOLD)');

console.log('5. outcome + emergency');
const w = openObservationWindow({
  deploymentId: 'dep-1', durationMs: 3_600_000, minSample: 100,
  acOutcomeMethods: { 'AC-UX': 'human' },
});
const outcome = evaluateOutcome(w, { 'AC-1': 'pass' }, 500);
console.log('   outcome:', outcome.status, '(expected WAITING_HUMAN)');
const emergency = decideEmergencyRecovery({
  thresholdBreached: true, reversibility: 'IRREVERSIBLE_UNKNOWN', recoveryPathSafe: true,
});
console.log('   irreversible emergency →', emergency, '(expected REQUIRE_HUMAN)');

console.log('6. fake rollback forbidden');
try {
  assertSafeAutoRecovery({ reversibility: 'IRREVERSIBLE_UNKNOWN', recoveryPathSafe: true });
  console.log('   ERROR: fake rollback allowed');
} catch (err) {
  console.log('   fake rollback refused:', err instanceof FakeRollbackForbiddenError);
}

console.log('demo complete');

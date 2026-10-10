/**
 * Tests for v2 §40/§41 release hardening:
 * external CI verification, reproducible builds, risk floors,
 * reversibility, pre-deploy gates, canary, outcome/emergency.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExternalCiResultVerifier,
  UnverifiedCiResultError,
  StaleCiResultError,
  CiRevisionMismatchError,
  lockBuild,
  promoteArtifact,
  ReverificationRequiredError,
  assessRisk,
  classifyReversibility,
  FakeRollbackForbiddenError,
  assertSafeAutoRecovery,
  checkPreDeployGates,
  PRE_DEPLOY_GATES,
  defineCanaryPlan,
  evaluateStage,
  openObservationWindow,
  evaluateOutcome,
  decideEmergencyRecovery,
  StageObservation,
} from '../src/index';

const ciResult = (over: Record<string, unknown> = {}) => ({
  platform: 'github',
  repository: 'org/app',
  ref: 'refs/heads/main',
  headSha: 'abc123',
  jobId: 'job-1',
  verdict: 'PASS' as const,
  authProof: 'sig-valid',
  receivedAt: new Date().toISOString(),
  ...over,
});

describe('external CI result verification (§40)', () => {
  const verifier = () =>
    new ExternalCiResultVerifier((r) => r.authProof === 'sig-valid');

  it('accepts an authenticated, current result', () => {
    const key = verifier().accept(ciResult(), 'abc123');
    assert.ok(key.length > 0);
  });

  it('refuses unverified PASS claims', () => {
    assert.throws(() => verifier().accept(ciResult({ authProof: 'bogus' }), 'abc123'), UnverifiedCiResultError);
    assert.throws(() => verifier().accept(ciResult({ authProof: '' }), 'abc123'), UnverifiedCiResultError);
  });

  it('refuses revision mismatches', () => {
    assert.throws(() => verifier().accept(ciResult(), 'different-sha'), CiRevisionMismatchError);
  });

  it('dedups repeated triggers (same job twice)', () => {
    const v = verifier();
    v.accept(ciResult(), 'abc123');
    assert.throws(() => v.accept(ciResult(), 'abc123'), StaleCiResultError);
  });
});

describe('reproducible builds (§40)', () => {
  const def = {
    revision: 'abc123',
    lockfileHash: 'lh1',
    toolchain: 'node:22',
    buildDefinitionHash: 'bd1',
    configHash: 'cfg1',
    dependencySources: ['npm-registry'],
  };

  it('locks to a stable digest; identical inputs → identical digest', () => {
    const a = lockBuild(def, 'ci');
    const b = lockBuild({ ...def, dependencySources: ['npm-registry'] }, 'ci');
    assert.equal(a.digest, b.digest);
    assert.equal(a.digest.length, 64);
  });

  it('different inputs → different digest', () => {
    const a = lockBuild(def, 'ci');
    const b = lockBuild({ ...def, revision: 'def456' }, 'ci');
    assert.notEqual(a.digest, b.digest);
  });

  it('refuses to lock with missing fields', () => {
    assert.throws(() => lockBuild({ ...def, toolchain: '' }, 'ci'), /toolchain/);
  });

  it('promotes same-digest artifacts; rebuilt digest requires re-verification', () => {
    const ok = promoteArtifact({ uatVerifiedDigest: 'd1', candidateDigest: 'd1', targetEnv: 'PROD' });
    assert.equal(ok.promoted, true);
    assert.throws(
      () => promoteArtifact({ uatVerifiedDigest: 'd1', candidateDigest: 'd2', targetEnv: 'PROD' }),
      ReverificationRequiredError,
    );
  });
});

describe('risk assessment (§41.1)', () => {
  const base = {
    changeType: 'bugfix',
    blastRadius: 'single-service',
    securityDataImpact: false,
    hasMigration: false,
    externalSideEffects: false,
    recoveryReady: true,
    observabilityReady: true,
    testIndependence: true,
    environmentDrift: false,
    businessCritical: false,
  };

  it('small verified reversible fix → LOW → AUTO', () => {
    const r = assessRisk(base);
    assert.equal(r.level, 'LOW');
    assert.deepEqual(r.authorization, { kind: 'AUTO' });
  });

  it('data deletion → CRITICAL → DENY_UNATTENDED', () => {
    const r = assessRisk({ ...base, changeType: 'data-deletion' });
    assert.equal(r.level, 'CRITICAL');
    assert.deepEqual(r.authorization, { kind: 'DENY_UNATTENDED' });
  });

  it('auth change → HIGH → HUMAN_PLUS_SPECIALIST', () => {
    const r = assessRisk({ ...base, changeType: 'auth-change' });
    assert.equal(r.level, 'HIGH');
    assert.deepEqual(r.authorization, { kind: 'HUMAN_PLUS_SPECIALIST' });
  });

  it('dependency upgrade → MEDIUM → PROJECT_PREAUTH_OR_HUMAN', () => {
    const r = assessRisk({ ...base, changeType: 'dependency-upgrade' });
    assert.equal(r.level, 'MEDIUM');
    assert.deepEqual(r.authorization, { kind: 'PROJECT_PREAUTH_OR_HUMAN' });
  });

  it('LLM-proposed LOW cannot lower the system floor', () => {
    const r = assessRisk({ ...base, changeType: 'auth-change', llmProposedLevel: 'LOW', llmRationale: 'looks small' });
    assert.equal(r.floor, 'HIGH');
    assert.equal(r.level, 'HIGH');
    assert.ok(r.reasons.some((x) => x.includes('LLM-proposed')));
  });

  it('unknown readiness is treated strictly (no recovery path → HIGH)', () => {
    const r = assessRisk({ ...base, recoveryReady: false });
    assert.ok(['HIGH', 'CRITICAL'].includes(r.level));
  });
});

describe('reversibility (§41.2)', () => {
  it('classifies change kinds', () => {
    assert.equal(classifyReversibility({ kind: 'code' }), 'REVERSIBLE');
    assert.equal(classifyReversibility({ kind: 'db-migration', hasDownMigration: true }), 'CONDITIONALLY_REVERSIBLE');
    assert.equal(classifyReversibility({ kind: 'db-migration', backwardCompatible: false }), 'IRREVERSIBLE_UNKNOWN');
    assert.equal(classifyReversibility({ kind: 'data-write' }), 'IRREVERSIBLE_UNKNOWN');
    assert.equal(
      classifyReversibility({ kind: 'data-write', compensationRunbook: 'rb-1' }),
      'COMPENSATABLE',
    );
    assert.equal(classifyReversibility({ kind: 'external-notify' }), 'IRREVERSIBLE_UNKNOWN');
  });

  it('forbids fake rollback of irreversible changes', () => {
    assert.throws(
      () => assertSafeAutoRecovery({ reversibility: 'IRREVERSIBLE_UNKNOWN', recoveryPathSafe: true }),
      FakeRollbackForbiddenError,
    );
    assert.doesNotThrow(() =>
      assertSafeAutoRecovery({ reversibility: 'REVERSIBLE', recoveryPathSafe: true }),
    );
    assert.doesNotThrow(() =>
      assertSafeAutoRecovery({
        reversibility: 'COMPENSATABLE',
        recoveryPathSafe: false,
        preapprovedCompensationRunbook: 'rb-9',
      }),
    );
  });
});

describe('pre-deploy gates (§41.3)', () => {
  it('checklist has all 17 gates', () => {
    assert.equal(PRE_DEPLOY_GATES.length, 17);
  });

  it('all VALID → ok', () => {
    const gates = Object.fromEntries(PRE_DEPLOY_GATES.map((g) => [g, 'VALID'])) as Record<string, 'VALID'>;
    const r = checkPreDeployGates({ gates });
    assert.equal(r.ok, true);
  });

  it('missing/invalid/unjustified-N/A gates are named', () => {
    const gates = Object.fromEntries(
      PRE_DEPLOY_GATES.map((g) => [g, 'VALID']),
    ) as Record<string, string>;
    delete gates.uat;
    gates.risk = 'INVALID';
    gates.budget = 'NOT_APPLICABLE';
    const r = checkPreDeployGates({ gates: gates as never });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['uat']);
    assert.deepEqual(r.invalid, ['risk']);
    assert.deepEqual(r.unjustifiedNa, ['budget']);
  });

  it('N/A with justification passes', () => {
    const gates = Object.fromEntries(PRE_DEPLOY_GATES.map((g) => [g, 'VALID'])) as Record<string, 'VALID'>;
    (gates as Record<string, unknown>).budget = 'NOT_APPLICABLE';
    const r = checkPreDeployGates({
      gates: gates as never,
      naJustifications: { budget: 'internal tool, no cost tracking' } as never,
    });
    assert.equal(r.ok, true);
  });

  it('final re-check catches digest change / revocation / drift / lease', () => {
    const gates = Object.fromEntries(PRE_DEPLOY_GATES.map((g) => [g, 'VALID'])) as never;
    const r = checkPreDeployGates({
      gates,
      finalRecheck: {
        approvalDigest: 'new',
        expectedApprovalDigest: 'old',
        permissionRevoked: true,
        targetDrift: false,
        leaseValid: false,
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.finalRecheckFailed?.length, 3);
  });
});

describe('progressive rollout (§41.4)', () => {
  const stage = {
    name: 'canary-5pct',
    cohort: '5%',
    trafficDenominator: 'prod-traffic',
    minObservationMs: 600_000,
    minSample: 1000,
    metrics: ['error_rate', 'p99_latency'],
    baselineRef: 'baseline-7d',
    thresholds: { error_rate: { max: 0.01 } },
    promotionRule: (o: StageObservation) => o.metricValues.error_rate < 0.01,
    abortRule: (o: StageObservation) => o.metricValues.error_rate > 0.05,
    maxWaitMs: 3_600_000,
  };
  const obs = (over: Partial<StageObservation> = {}): StageObservation => ({
    stageName: 'canary-5pct',
    sampleSize: 5000,
    telemetryPresent: true,
    observedMs: 900_000,
    metricValues: { error_rate: 0.002 },
    at: new Date().toISOString(),
    ...over,
  });

  it('healthy observation → PROMOTE', () => {
    assert.equal(evaluateStage(stage, obs()), 'PROMOTE');
  });

  it('telemetry lost → HOLD, never promote on zero errors', () => {
    assert.equal(evaluateStage(stage, obs({ telemetryPresent: false, metricValues: {} })), 'HOLD');
  });

  it('sample below minimum → HOLD', () => {
    assert.equal(evaluateStage(stage, obs({ sampleSize: 10 })), 'HOLD');
  });

  it('abort rule fires → ABORT', () => {
    assert.equal(evaluateStage(stage, obs({ metricValues: { error_rate: 0.2 } })), 'ABORT');
  });

  it('window too short → CONTINUE', () => {
    assert.equal(evaluateStage(stage, obs({ observedMs: 60_000 })), 'CONTINUE');
  });

  it('plan requires executable predicates and sane config', () => {
    assert.throws(() => defineCanaryPlan({ artifactDigest: '', targetEnv: 'PROD', stages: [stage] }), /artifactDigest/);
    assert.throws(() => defineCanaryPlan({ artifactDigest: 'd', targetEnv: 'PROD', stages: [] }), /at least one/);
    const bad = { ...stage, promotionRule: 'looks good' as never };
    assert.throws(() => defineCanaryPlan({ artifactDigest: 'd', targetEnv: 'PROD', stages: [bad] }), /executable predicates/);
  });
});

describe('observation / outcome / emergency (§41.5/§41.6)', () => {
  it('sufficient sample + all ACs pass → OUTCOME_VERIFIED', () => {
    const w = openObservationWindow({ deploymentId: 'dep-1', durationMs: 3_600_000, minSample: 100 });
    const e = evaluateOutcome(w, { 'AC-1': 'pass', 'AC-2': 'pass' }, 500);
    assert.equal(e.status, 'OUTCOME_VERIFIED');
  });

  it('small sample → OBSERVING, not verified', () => {
    const w = openObservationWindow({ deploymentId: 'dep-1', durationMs: 3_600_000, minSample: 100 });
    const e = evaluateOutcome(w, { 'AC-1': 'pass' }, 10);
    assert.equal(e.status, 'OBSERVING');
  });

  it('human-judgment AC without human result → WAITING_HUMAN', () => {
    const w = openObservationWindow({
      deploymentId: 'dep-1',
      durationMs: 3_600_000,
      minSample: 100,
      acOutcomeMethods: { 'AC-UX': 'human' },
    });
    const e = evaluateOutcome(w, { 'AC-1': 'pass' }, 500);
    assert.equal(e.status, 'WAITING_HUMAN');
    assert.deepEqual(e.waitingAcs, ['AC-UX']);
  });

  it('failed AC → OUTCOME_FAILED', () => {
    const w = openObservationWindow({ deploymentId: 'dep-1', durationMs: 3_600_000, minSample: 100 });
    const e = evaluateOutcome(w, { 'AC-1': 'fail' }, 500);
    assert.equal(e.status, 'OUTCOME_FAILED');
  });

  it('emergency: threshold + safe reversible path → AUTO_ROLLBACK', () => {
    assert.equal(
      decideEmergencyRecovery({ thresholdBreached: true, reversibility: 'REVERSIBLE', recoveryPathSafe: true }),
      'AUTO_ROLLBACK',
    );
  });

  it('emergency: irreversible without runbook → REQUIRE_HUMAN', () => {
    assert.equal(
      decideEmergencyRecovery({ thresholdBreached: true, reversibility: 'IRREVERSIBLE_UNKNOWN', recoveryPathSafe: true }),
      'REQUIRE_HUMAN',
    );
  });

  it('emergency: rollback failed / unknown data → ESCALATE', () => {
    assert.equal(
      decideEmergencyRecovery({ thresholdBreached: true, reversibility: 'REVERSIBLE', recoveryPathSafe: true, dataStateUnknown: true }),
      'ESCALATE',
    );
  });

  it('no threshold breach → REQUIRE_HUMAN (no auto action)', () => {
    assert.equal(
      decideEmergencyRecovery({ thresholdBreached: false, reversibility: 'REVERSIBLE', recoveryPathSafe: true }),
      'REQUIRE_HUMAN',
    );
  });
});

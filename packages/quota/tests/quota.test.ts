import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHandoffPackage,
  checkFallbackCompatibility,
  decideQuotaPolicy,
  describeUsage,
  HandoffActivationGuard,
  HandoffHashMismatch,
  IncompleteHandoff,
  IncompatibleFallback,
  QuotaMonitor,
  SecretInHandoff,
  UnknownQuotaData,
  verifyHandoffPackage,
  type HandoffInput,
  type QuotaBucket,
} from '../src/index';

function bucket(partial: Partial<QuotaBucket> = {}): QuotaBucket {
  return {
    providerAccountId: 'acct-1',
    workspaceId: 'ws-1',
    limitBucket: 'codex:standard',
    authState: 'ok',
    collectedAt: new Date(1_000).toISOString(),
    freshness: 'fresh',
    ...partial,
  };
}

describe('quota display honesty (§27.1)', () => {
  it('never fabricates a percentage when the provider is silent', () => {
    assert.match(describeUsage(bucket({ freshness: 'unknown' })), /unknown/);
    assert.match(describeUsage(bucket({ freshness: 'fresh' })), /unknown/);
    assert.ok(!/\d+%/.test(describeUsage(bucket({ freshness: 'unknown' }))));
  });

  it('shows used/limit only when the provider reported both', () => {
    const s = describeUsage(
      bucket({ used: 30, limit: 100, windowStart: 't0', windowEnd: 't1' }),
    );
    assert.ok(s.includes('30/100') && s.includes('30% used'));
  });

  it('UnknownQuotaData refuses fabrication', () => {
    assert.throws(() => {
      throw new UnknownQuotaData('reset timestamp');
    }, /refusing to fabricate/);
  });
});

describe('quota policies (§27.2)', () => {
  const event = {
    kind: 'CREDITS_EXHAUSTED' as const,
    bucket: bucket({ resetAt: undefined }),
    observedAt: new Date(1_000).toISOString(),
  };

  it('STRICT_PROVIDER parks runs and admits an unknown reset', () => {
    const d = decideQuotaPolicy('STRICT_PROVIDER', event, ['run-1', 'run-2']);
    assert.equal(d.action, 'WAIT_FOR_RESET');
    assert.equal(d.resetAt, null);
    assert.match(d.note, /unknown/);
  });

  it('STRICT_PROVIDER uses a known reset when the provider gives one', () => {
    const d = decideQuotaPolicy(
      'STRICT_PROVIDER',
      { ...event, bucket: bucket({ resetAt: '2026-10-11T00:00:00Z' }) },
      ['run-1'],
    );
    assert.equal(d.action, 'WAIT_FOR_RESET');
    assert.equal(d.resetAt, '2026-10-11T00:00:00Z');
  });

  it('GLOBAL_PAUSE_ON_PRIMARY_LIMIT pauses dev, keeps safety', () => {
    const d = decideQuotaPolicy('GLOBAL_PAUSE_ON_PRIMARY_LIMIT', event, ['run-1']);
    assert.equal(d.action, 'PAUSE_DEV_DOMAIN');
    assert.match(d.note, /safety/i);
  });

  it('fallback requires capability+privacy+budget+permission', () => {
    const good = checkFallbackCompatibility(
      { capabilities: ['tools', 'vision'], dataClasses: ['internal'], budgetNeeded: 50, permissionCeiling: ['shell.execute'] },
      { providerAccountId: 'a2', limitBucket: 'b2', capabilities: ['tools', 'vision'], allowedDataClasses: ['internal', 'public'], budgetRemaining: 100 },
    );
    assert.deepEqual(good.reasons, []);
    const bad = checkFallbackCompatibility(
      { capabilities: ['tools'], dataClasses: ['pii'], budgetNeeded: 500, permissionCeiling: [] },
      { providerAccountId: 'a2', limitBucket: 'b2', capabilities: ['tools'], allowedDataClasses: ['public'], budgetRemaining: 10 },
    );
    assert.ok(bad.reasons.length >= 3, JSON.stringify(bad.reasons));
    assert.throws(() => {
      throw new IncompatibleFallback(bad);
    }, /Fallback rejected/);
  });
});

function handoffInput(): HandoffInput {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    delegationId: 'del-1',
    rootAuthorizationId: 'auth-root',
    requirementVersion: 'REQ-1@3',
    acceptanceCriteriaVersions: ['AC-1@3', 'AC-2@3'],
    goal: 'fix login bug',
    scope: 'auth module only',
    plan: ['reproduce', 'fix', 'test'],
    completed: ['reproduce'],
    notCompleted: ['fix', 'test'],
    decisions: [{ decision: 'use bcrypt', rationale: 'policy', at: 't' }],
    gitBaseSha: 'base',
    gitCandidateSha: 'cand',
    diffRefs: ['art-diff-1'],
    fileRefs: ['src/auth.ts'],
    commands: ['pytest -x'],
    tests: [{ name: 'login', outcome: 'fail' }],
    failures: ['login test fails'],
    artifactRefs: ['art-1'],
    evidenceRefs: ['ev-1'],
    risks: [{ severity: 'MEDIUM', description: 'session handling' }],
    workerHost: 'host-a',
    environment: 'dev',
    pendingSideEffects: ['none outstanding'],
    checkpointRef: 'ckpt-1',
    policyVersion: 'pol@7',
    capabilityCeilingRef: 'cap-3',
    budgetUsed: 120,
    budgetRemaining: 880,
    contextSourceManifest: [{ source: 'repo', version: 'v3', hash: 'h' }],
  };
}

describe('handoff packages (§27.3)', () => {
  it('creates a sealed, hash-verified package', () => {
    const pkg = createHandoffPackage(handoffInput(), () => 5_000);
    assert.equal(pkg.schemaVersion, '2.0');
    assert.equal(pkg.packageHash.length, 64);
    assert.doesNotThrow(() => verifyHandoffPackage(pkg));
  });

  it('rejects tampered packages', () => {
    const pkg = createHandoffPackage(handoffInput());
    const tampered = { ...pkg, goal: 'mine crypto' };
    assert.throws(() => verifyHandoffPackage(tampered), HandoffHashMismatch);
  });

  it('rejects missing required fields', () => {
    const input = handoffInput() as Record<string, unknown>;
    delete input.checkpointRef;
    assert.throws(() => createHandoffPackage(input as HandoffInput), IncompleteHandoff);
  });

  it('refuses to carry raw secrets', () => {
    const input = handoffInput();
    input.decisions = [{ decision: 'x', rationale: 'used sk-abcdefghijklmnop', at: 't' }];
    assert.throws(() => createHandoffPackage(input), SecretInHandoff);
  });

  it('no-dual-write guard blocks activation while the old run is live', () => {
    const g = new HandoffActivationGuard();
    g.registerOldRun('run-1');
    assert.throws(() => g.assertOldRunSettled('run-1'), /still ACTIVE/);
    g.markOldRunSettled('run-1', 'PAUSED');
    assert.doesNotThrow(() => g.assertOldRunSettled('run-1'));
  });
});

describe('quota monitor (§27.4)', () => {
  it('classifies provider signals into limit events', () => {
    const m = new QuotaMonitor();
    const b = bucket();
    assert.equal(m.recordLimitSignal('429 Too Many Requests', b, 30).kind, 'RATE_LIMITED_429');
    assert.equal(m.recordLimitSignal('insufficient credits', b).kind, 'CREDITS_EXHAUSTED');
    assert.equal(m.recordLimitSignal('401 auth expired', b).kind, 'AUTH_EXPIRY');
    assert.equal(m.recordLimitSignal('weird provider smoke', b).kind, 'PROVIDER_OUTAGE');
  });

  it('applies the configured policy', () => {
    const m = new QuotaMonitor({ policy: 'GLOBAL_PAUSE_ON_PRIMARY_LIMIT' });
    const ev = m.recordLimitSignal('quota exhausted', bucket());
    assert.equal(m.decide(ev, ['r1']).action, 'PAUSE_DEV_DOMAIN');
  });

  it('lets authorized inflight deterministic tools continue, blocks the rest', () => {
    const m = new QuotaMonitor({ now: () => 10_000 });
    const okTool = {
      toolId: 'pytest', runId: 'r1', authorizationValid: true,
      budgetRemaining: 50, riskApproved: true, controlEpochCurrent: true,
      timeoutMs: 60_000, startedAt: 5_000,
    };
    assert.doesNotThrow(() => m.assertInflightToolMayContinue(okTool));
    assert.throws(
      () => m.assertInflightToolMayContinue({ ...okTool, authorizationValid: false }),
      /authorization no longer valid/,
    );
    assert.throws(
      () => m.assertInflightToolMayContinue({ ...okTool, controlEpochCurrent: false }),
      /control epoch changed/,
    );
    assert.throws(
      () => m.assertInflightToolMayContinue({ ...okTool, startedAt: 0, timeoutMs: 1_000 }),
      /own timeout exceeded/,
    );
  });
});

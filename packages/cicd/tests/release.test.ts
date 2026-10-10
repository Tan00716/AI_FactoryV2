/**
 * Tests for the Environment Manager + Release Manager (spec §40, §41, §77):
 * the full environment model, semver handling, changelog drafts, the gated
 * deploy flow (approval gate → snapshot → health check → auto-rollback),
 * and the audit hook.
 * Run: node --test dist/tests/release.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalRequiredError,
  DEFAULT_ENVIRONMENTS,
  EnvironmentNotFoundError,
  InvalidSemverError,
  ReleaseManager,
  ReleaseNotDeployableError,
  ReleaseNotFoundError,
  SnapshotStore,
  bumpVersion,
  draftChangelog,
  isValidSemver,
  type ApprovalRef,
  type ManagedEnvironment,
  type Release,
} from '../src/index';

const FIXED_NOW = '2026-10-09T09:00:00.000Z';

function manager(overrides: ConstructorParameters<typeof ReleaseManager>[0] = {}) {
  return new ReleaseManager({ now: () => FIXED_NOW, ...overrides });
}

function approvedRef(id = 'appr-1', level: 'ai' | 'human' = 'human'): ApprovalRef {
  return {
    approvalId: id,
    approver: level === 'human' ? 'tan' : 'ai-reviewer',
    decision: 'APPROVED',
    decidedAt: FIXED_NOW,
    level,
  };
}

describe('semver', () => {
  it('accepts plain and extended semver', () => {
    assert.equal(isValidSemver('1.2.3'), true);
    assert.equal(isValidSemver('0.0.1'), true);
    assert.equal(isValidSemver('10.20.30'), true);
    assert.equal(isValidSemver('1.2.3-alpha.1'), true);
    assert.equal(isValidSemver('1.2.3+build.5'), true);
    assert.equal(isValidSemver('2.0.0-rc.1+build.9'), true);
  });

  it('rejects non-semver strings', () => {
    assert.equal(isValidSemver('1.2'), false);
    assert.equal(isValidSemver('v1.2.3'), false);
    assert.equal(isValidSemver('1.2.3.4'), false);
    assert.equal(isValidSemver('01.2.3'), false);
    assert.equal(isValidSemver(''), false);
    assert.equal(isValidSemver('latest'), false);
  });

  it('bumps patch/minor/major correctly', () => {
    assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
    assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
    assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  });

  it('bump drops pre-release and build metadata', () => {
    assert.equal(bumpVersion('1.2.3-rc.1+build.9', 'patch'), '1.2.4');
    assert.equal(bumpVersion('1.2.3-rc.1', 'minor'), '1.3.0');
  });

  it('bump throws InvalidSemverError on bad input', () => {
    assert.throws(() => bumpVersion('1.2', 'patch'), InvalidSemverError);
    assert.throws(() => bumpVersion('nope', 'major'), /Invalid semver/);
  });
});

describe('environment model (§40)', () => {
  it('ships the four default environment presets', () => {
    const names = DEFAULT_ENVIRONMENTS.map((e) => e.name).sort();
    assert.deepEqual(names, ['DEV', 'LOCAL', 'PROD', 'UAT']);
  });

  it('PROD defaults to the human approval policy', () => {
    const prod = DEFAULT_ENVIRONMENTS.find((e) => e.name === 'PROD')!;
    assert.equal(prod.approvalPolicy, 'human');
    assert.equal(prod.id, 'env-prod');
  });

  it('lower environments have lighter policies (none/ai)', () => {
    const by = Object.fromEntries(DEFAULT_ENVIRONMENTS.map((e) => [e.name, e]));
    assert.equal(by['LOCAL'].approvalPolicy, 'none');
    assert.equal(by['DEV'].approvalPolicy, 'none');
    assert.equal(by['UAT'].approvalPolicy, 'ai');
  });

  it('secretRefs hold reference names only — never values', () => {
    for (const env of DEFAULT_ENVIRONMENTS) {
      for (const ref of env.secretRefs) {
        assert.match(ref, /^[a-z0-9-]+$/i, `secretRef looks like a value: ${ref}`);
        assert.ok(!ref.includes('='), 'no key=value pairs allowed');
      }
    }
    const prod = DEFAULT_ENVIRONMENTS.find((e) => e.name === 'PROD')!;
    assert.deepEqual(prod.secretRefs, ['prod-secrets']);
  });

  it('healthCheck is a structured {type, target} spec', () => {
    const prod = DEFAULT_ENVIRONMENTS.find((e) => e.name === 'PROD')!;
    assert.equal(prod.healthCheck.type, 'http');
    assert.ok(prod.healthCheck.target.includes('/healthz'));
    const local = DEFAULT_ENVIRONMENTS.find((e) => e.name === 'LOCAL')!;
    assert.equal(local.healthCheck.type, 'script');
  });

  it('resolves environments by id or by name', () => {
    const m = manager();
    assert.equal(m.getEnvironment('env-prod').name, 'PROD');
    assert.equal(m.getEnvironment('PROD').id, 'env-prod');
    assert.equal(m.listEnvironments().length, 4);
  });

  it('throws EnvironmentNotFoundError for unknown environments', () => {
    const m = manager();
    assert.throws(() => m.getEnvironment('STAGING'), EnvironmentNotFoundError);
    assert.throws(() => m.getEnvironment('env-staging'), /not found/);
  });

  it('registerEnvironment rejects secretRefs that look like values', () => {
    const m = manager();
    const env: ManagedEnvironment = {
      ...DEFAULT_ENVIRONMENTS[0],
      id: 'env-x',
      secretRefs: ['DB_PASSWORD=hunter2'],
    };
    assert.throws(() => m.registerEnvironment(env), /reference names only/);
  });
});

describe('release creation', () => {
  it('creates a draft release with validated semver', () => {
    const m = manager();
    const r = m.createRelease({
      version: '1.4.0',
      artifacts: ['app-1.4.0.tgz'],
      createdBy: 'tan',
    });
    assert.equal(r.status, 'draft');
    assert.equal(r.version, '1.4.0');
    assert.deepEqual(r.artifacts, ['app-1.4.0.tgz']);
    assert.equal(r.createdBy, 'tan');
    assert.equal(r.snapshotId, null);
    assert.ok(r.id.length > 0);
  });

  it('rejects invalid semver versions', () => {
    const m = manager();
    assert.throws(() => m.createRelease({ version: '1.4' }), InvalidSemverError);
  });

  it('rejects unknown target environments', () => {
    const m = manager();
    assert.throws(
      () => m.createRelease({ version: '1.0.0', environmentId: 'env-nope' }),
      EnvironmentNotFoundError,
    );
  });

  it('generates a changelog draft from a commit list', () => {
    const lines = draftChangelog(['feat: add dark mode', 'fix: login race']);
    assert.deepEqual(lines, ['- feat: add dark mode', '- fix: login race']);
  });

  it('changelog draft falls back to a placeholder with no commits', () => {
    const lines = draftChangelog([]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /manually/);
  });

  it('createRelease drafts the changelog from provided commits', () => {
    const m = manager();
    const r = m.createRelease({
      version: '2.0.0',
      commits: ['feat: v2 api', 'fix: leak'],
    });
    assert.deepEqual(r.changelog, ['- feat: v2 api', '- fix: leak']);
  });

  it('an explicit changelog overrides the generated draft', () => {
    const m = manager();
    const r = m.createRelease({
      version: '2.0.0',
      commits: ['feat: ignored'],
      changelog: ['- Hand-written notes'],
    });
    assert.deepEqual(r.changelog, ['- Hand-written notes']);
  });
});

describe('deploy gates (§41, §77)', () => {
  it('deploys to UAT with an approved AI approval (ai policy)', async () => {
    const m = manager();
    const r = m.createRelease({ version: '1.0.0', environmentId: 'env-uat' });
    m.addApproval(r.id, approvedRef('ai-1', 'ai'));
    const out = await m.deployRelease(r.id);
    assert.equal(out.release.status, 'deployed');
    assert.equal(out.rolledBack, false);
    assert.ok(out.release.snapshotId);
    assert.ok(out.snapshot.id === out.release.snapshotId);
  });

  it('an AI-level approval does not satisfy the PROD human gate', async () => {
    const m = manager();
    const r = m.createRelease({ version: '1.0.0', environmentId: 'env-prod' });
    m.addApproval(r.id, approvedRef('ai-1', 'ai'));
    await assert.rejects(() => m.deployRelease(r.id), ApprovalRequiredError);
  });

  it('deploys to DEV with no approval at all (none policy)', async () => {
    const m = manager();
    const r = m.createRelease({ version: '1.0.0', environmentId: 'env-dev' });
    const out = await m.deployRelease(r.id);
    assert.equal(out.release.status, 'deployed');
  });

  it('PROD deploy without approval is refused and parks at pending_approval', async () => {
    const m = manager();
    const r = m.createRelease({ version: '1.0.0', environmentId: 'env-prod' });
    await assert.rejects(() => m.deployRelease(r.id), ApprovalRequiredError);
    assert.equal(m.getRelease(r.id).status, 'pending_approval');
  });

  it('PROD deploy proceeds after a human approval is attached', async () => {
    const m = manager();
    const r = m.createRelease({ version: '1.0.0', environmentId: 'env-prod' });
    await assert.rejects(() => m.deployRelease(r.id), ApprovalRequiredError);
    const updated = m.addApproval(r.id, approvedRef('appr-human-1'));
    assert.equal(updated.status, 'approved');
    const out = await m.deployRelease(r.id);
    assert.equal(out.release.status, 'deployed');
  });

  it('a PENDING (undecided) approval does not satisfy the human gate', async () => {
    const m = manager();
    const r = m.createRelease({ version: '1.0.0', environmentId: 'env-prod' });
    m.addApproval(r.id, {
      approvalId: 'appr-pending',
      approver: 'tan',
      decision: 'PENDING',
      decidedAt: null,
    });
    await assert.rejects(() => m.deployRelease(r.id), ApprovalRequiredError);
  });

  it('a REJECTED approval does not satisfy the human gate', async () => {
    const m = manager();
    const r = m.createRelease({ version: '1.0.0', environmentId: 'env-prod' });
    m.addApproval(r.id, {
      approvalId: 'appr-no',
      approver: 'tan',
      decision: 'REJECTED',
      decidedAt: FIXED_NOW,
    });
    await assert.rejects(() => m.deployRelease(r.id), ApprovalRequiredError);
  });

  it('the injected isApprovalGranted predicate decides grant (approvals reuse)', async () => {
    // Server-side: consult the live @ai-factory/approvals store instead of refs.
    const granted = new Set(['ticket-9']);
    const m = manager({
      isApprovalGranted: (approvalId) => granted.has(approvalId),
    });
    const r = m.createRelease({ version: '1.0.0', environmentId: 'env-prod' });
    m.addApproval(r.id, approvedRef('ticket-9'));
    const out = await m.deployRelease(r.id);
    assert.equal(out.release.status, 'deployed');

    const m2 = manager({ isApprovalGranted: () => false });
    const r2 = m2.createRelease({ version: '1.0.1', environmentId: 'env-prod' });
    m2.addApproval(r2.id, approvedRef('ticket-9'));
    await assert.rejects(() => m2.deployRelease(r2.id), ApprovalRequiredError);
  });

  it('deploying an unknown release throws ReleaseNotFoundError', async () => {
    const m = manager();
    await assert.rejects(() => m.deployRelease('nope'), ReleaseNotFoundError);
  });

  it('deploying to an unknown environment throws EnvironmentNotFoundError', async () => {
    const m = manager();
    const r = m.createRelease({ version: '1.0.0', environmentId: 'env-dev' });
    await assert.rejects(
      () => m.deployRelease(r.id, 'env-nope'),
      EnvironmentNotFoundError,
    );
  });

  it('a deployed release cannot be redeployed to the same environment', async () => {
    const m = manager();
    const r = m.createRelease({ version: '1.0.0', environmentId: 'env-dev' });
    await m.deployRelease(r.id);
    await assert.rejects(
      () => m.deployRelease(r.id),
      ReleaseNotDeployableError,
    );
  });

  it('a deployed release can be promoted to another environment (UAT → PROD gate)', async () => {
    const m = manager();
    const r = m.createRelease({ version: '1.0.0', environmentId: 'env-uat' });
    m.addApproval(r.id, approvedRef('ai-1', 'ai'));
    const uat = await m.deployRelease(r.id);
    assert.equal(uat.release.status, 'deployed');
    assert.equal(uat.release.environmentId, 'env-uat');

    // Promoting to PROD without a human approval is refused…
    await assert.rejects(
      () => m.deployRelease(r.id, 'env-prod'),
      ApprovalRequiredError,
    );
    // …and succeeds once the human approval is attached.
    m.addApproval(r.id, approvedRef('human-1'));
    const prod = await m.deployRelease(r.id, 'env-prod');
    assert.equal(prod.release.status, 'deployed');
    assert.equal(prod.release.environmentId, 'env-prod');
  });

  it('a failed release may be redeployed', async () => {
    const m = manager();
    const r = m.createRelease({ version: '1.0.0', environmentId: 'env-dev' });
    const first = await m.deployRelease(r.id, undefined, {
      deployFn: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(first.release.status, 'failed');
    const second = await m.deployRelease(r.id);
    assert.equal(second.release.status, 'deployed');
  });
});

describe('health check + auto-rollback (§77)', () => {
  it('a failing health check rolls back to the pre-deploy snapshot', async () => {
    const store = new SnapshotStore();
    const m = manager({ snapshotStore: store });
    const r = m.createRelease({ version: '2.1.0', environmentId: 'env-uat' });
    m.addApproval(r.id, approvedRef());
    const out = await m.deployRelease(r.id, undefined, {
      healthCheckFn: async () => false,
    });
    assert.equal(out.release.status, 'rolled_back');
    assert.equal(out.rolledBack, true);
    assert.match(out.release.error ?? '', /health check failed/);
    // The snapshot exists and holds the pre-deploy state.
    const snap = store.get(out.release.snapshotId!);
    assert.ok(snap);
    assert.equal(
      (snap.data as { version: string }).version,
      '2.1.0',
    );
  });

  it('a throwing deployFn marks the release failed and restores the snapshot', async () => {
    const store = new SnapshotStore();
    const m = manager({ snapshotStore: store });
    const r = m.createRelease({ version: '3.0.0', environmentId: 'env-dev' });
    const out = await m.deployRelease(r.id, undefined, {
      deployFn: async () => {
        throw new Error('helm upgrade blew up');
      },
    });
    assert.equal(out.release.status, 'failed');
    assert.equal(out.rolledBack, true);
    assert.match(out.release.error ?? '', /helm upgrade blew up/);
    assert.ok(store.get(out.release.snapshotId!));
  });

  it('a passing health check keeps the release deployed', async () => {
    const m = manager();
    const r = m.createRelease({ version: '4.0.0', environmentId: 'env-dev' });
    const seen: string[] = [];
    const out = await m.deployRelease(r.id, undefined, {
      healthCheckFn: async (env) => {
        seen.push(env.healthCheck.target);
        return true;
      },
    });
    assert.equal(out.release.status, 'deployed');
    assert.ok(seen[0].includes('/healthz'));
  });

  it('manual rollbackRelease restores the snapshot and audits', async () => {
    const auditActions: string[] = [];
    const m = manager({ audit: (action) => void auditActions.push(action) });
    const r = m.createRelease({ version: '5.0.0', environmentId: 'env-dev' });
    await m.deployRelease(r.id);
    const rolled = m.rollbackRelease(r.id);
    assert.equal(rolled.status, 'rolled_back');
    assert.ok(auditActions.includes('RELEASE_ROLLED_BACK'));
  });

  it('manual rollback without a snapshot throws', () => {
    const m = manager();
    const r = m.createRelease({ version: '5.0.0', environmentId: 'env-dev' });
    assert.throws(() => m.rollbackRelease(r.id), /no snapshot/);
  });
});

describe('audit hook', () => {
  it('audits create, approval, deploy and rollback', async () => {
    const actions: string[] = [];
    const m = manager({ audit: (action) => void actions.push(action) });
    const r = m.createRelease({
      version: '6.0.0',
      environmentId: 'env-uat',
      commits: ['feat: x'],
    });
    assert.ok(actions.includes('RELEASE_CREATED'));

    m.addApproval(r.id, approvedRef());
    assert.ok(actions.includes('RELEASE_APPROVAL_ADDED'));

    const fail = await m.deployRelease(r.id, undefined, {
      healthCheckFn: async () => false,
    });
    assert.equal(fail.release.status, 'rolled_back');
    for (const a of [
      'RELEASE_APPROVED',
      'RELEASE_DEPLOY_STARTED',
      'RELEASE_ROLLED_BACK',
    ]) {
      assert.ok(actions.includes(a), `missing audit action ${a}`);
    }
  });

  it('audits the approval-required refusal for PROD', async () => {
    const actions: string[] = [];
    const m = manager({ audit: (action) => void actions.push(action) });
    const r = m.createRelease({ version: '7.0.0', environmentId: 'env-prod' });
    await assert.rejects(() => m.deployRelease(r.id), ApprovalRequiredError);
    assert.ok(actions.includes('RELEASE_APPROVAL_REQUIRED'));
  });
});

describe('release store hygiene', () => {
  it('getRelease returns copies — mutating them does not corrupt the store', () => {
    const m = manager();
    const r = m.createRelease({ version: '8.0.0' });
    const copy: Release = m.getRelease(r.id);
    copy.status = 'deployed';
    copy.approvals.push(approvedRef());
    assert.equal(m.getRelease(r.id).status, 'draft');
    assert.deepEqual(m.getRelease(r.id).approvals, []);
  });

  it('listReleases returns all releases', () => {
    const m = manager();
    m.createRelease({ version: '8.0.0' });
    m.createRelease({ version: '8.0.1' });
    assert.equal(m.listReleases().length, 2);
  });
});

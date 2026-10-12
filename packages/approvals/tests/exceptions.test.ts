/**
 * Unit tests for §23.4 Exception Grants: human-only, reasoned, TTL-capped
 * waivers. A covered gate failure is WAIVED — never PASS, never an approval —
 * and BLOCKED actions are non-waivable in both directions (grant + use).
 * Run from the package dir: npx tsc -p tsconfig.json && node --test dist/tests/*.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalManager,
  ApprovalNotApprovedError,
  BLOCKED_ACTIONS,
  ExceptionGrantDeniedError,
  ExceptionGrantNotFoundError,
  InMemoryApprovalStore,
  InMemoryExceptionGrantStore,
  isHumanActor,
} from '../src/index';

interface AuditCall {
  action: string;
  entityId: string;
  details: Record<string, unknown>;
}

function makeManager(
  opts: { defaultTtlMs?: number; maxTtlMs?: number } = {},
) {
  const calls: AuditCall[] = [];
  const manager = new ApprovalManager(new InMemoryApprovalStore(), {
    audit: (action, entityId, details) => calls.push({ action, entityId, details }),
    policyVersion: 'v2-test',
    exceptionGrants: new InMemoryExceptionGrantStore(),
    exceptionGrantDefaultTtlMs: opts.defaultTtlMs,
    exceptionGrantMaxTtlMs: opts.maxTtlMs,
  });
  return { manager, calls };
}

const GRANT = {
  action: 'deploy.prod',
  task_id: 't1',
  granted_by: 'human:cto',
  reason: 'hotfix window, canary already green in UAT',
};

describe('isHumanActor / BLOCKED_ACTIONS', () => {
  it('human and human:<name> are human; agents and AI are not', () => {
    assert.equal(isHumanActor('human'), true);
    assert.equal(isHumanActor('human:cto'), true);
    assert.equal(isHumanActor('agent-1'), false);
    assert.equal(isHumanActor('ai-reviewer'), false);
    assert.equal(isHumanActor('rogue-agent'), false);
    assert.equal(isHumanActor(''), false);
  });

  it('BLOCKED_ACTIONS is exactly the policy BLOCKED set (secret.write)', () => {
    assert.deepEqual([...BLOCKED_ACTIONS], ['secret.write']);
  });
});

describe('grantException', () => {
  it('a human grant is ACTIVE, always has expires_at, and is audited', () => {
    const { manager, calls } = makeManager({ defaultTtlMs: 60_000 });
    const g = manager.grantException(GRANT);
    assert.equal(g.status, 'ACTIVE');
    assert.equal(g.action, 'deploy.prod');
    assert.equal(g.task_id, 't1');
    assert.equal(g.granted_by, 'human:cto');
    assert.equal(g.reason, GRANT.reason);
    assert.ok(g.expires_at);
    const span = new Date(g.expires_at).getTime() - new Date(g.created_at).getTime();
    // created_at and expires_at come from two clock reads; allow 1s of skew.
    assert.ok(span > 55_000 && span <= 61_000, `ttl span ${span}`);
    const created = calls.find((c) => c.action === 'EXCEPTION_GRANT_CREATED');
    assert.ok(created);
    assert.equal(created.entityId, g.id);
    assert.equal(created.details.reason, GRANT.reason);
    assert.equal(created.details.granted_by, 'human:cto');
  });

  it('an AI actor cannot grant itself an exception (NON_HUMAN_GRANTOR, audited, nothing stored)', () => {
    const { manager, calls } = makeManager();
    assert.throws(
      () => manager.grantException({ ...GRANT, granted_by: 'agent-1' }),
      (e: unknown) =>
        e instanceof ExceptionGrantDeniedError && e.code === 'NON_HUMAN_GRANTOR',
    );
    assert.equal(manager.listExceptions().length, 0);
    const denied = calls.find((c) => c.action === 'EXCEPTION_GRANT_DENIED');
    assert.ok(denied);
    assert.equal(denied.details.code, 'NON_HUMAN_GRANTOR');
  });

  it('a missing/blank reason is refused (REASON_REQUIRED)', () => {
    const { manager } = makeManager();
    for (const reason of ['', '   ']) {
      assert.throws(
        () => manager.grantException({ ...GRANT, reason }),
        (e: unknown) =>
          e instanceof ExceptionGrantDeniedError && e.code === 'REASON_REQUIRED',
      );
    }
    assert.equal(manager.listExceptions().length, 0);
  });

  it('a TTL beyond the hard cap is refused — no permanent waivers (TTL_EXCEEDS_MAX)', () => {
    const { manager, calls } = makeManager({ maxTtlMs: 60_000 });
    assert.throws(
      () => manager.grantException({ ...GRANT, ttlMs: 120_000 }),
      (e: unknown) =>
        e instanceof ExceptionGrantDeniedError && e.code === 'TTL_EXCEEDS_MAX',
    );
    assert.equal(manager.listExceptions().length, 0);
    assert.ok(calls.some((c) => c.action === 'EXCEPTION_GRANT_DENIED'));
    // …but a TTL at the cap is fine.
    const g = manager.grantException({ ...GRANT, ttlMs: 60_000 });
    assert.equal(g.status, 'ACTIVE');
  });

  it('granting an exception for a BLOCKED action is refused and audited (BLOCKED_ACTION)', () => {
    const { manager, calls } = makeManager();
    assert.throws(
      () => manager.grantException({ ...GRANT, action: 'secret.write' }),
      (e: unknown) =>
        e instanceof ExceptionGrantDeniedError && e.code === 'BLOCKED_ACTION',
    );
    assert.equal(manager.listExceptions().length, 0);
    const denied = calls.find((c) => c.action === 'EXCEPTION_GRANT_DENIED');
    assert.ok(denied);
    assert.equal(denied.details.code, 'BLOCKED_ACTION');
    assert.equal(denied.details.action, 'secret.write');
  });
});

describe('evaluateApprovalGate', () => {
  it('without any approval or grant the gate is FAILED (unchanged baseline)', () => {
    const { manager } = makeManager();
    const r = manager.evaluateApprovalGate({ action: 'deploy.prod', task_id: 't1' });
    assert.equal(r.verdict, 'FAILED');
    assert.match(r.failure_reason ?? '', /no approval exists/);
    assert.equal(r.grant_id, null);
    assert.equal(r.approval_id, null);
  });

  it('a live grant turns the failure WAIVED — never PASS — preserving the original failure', () => {
    const { manager, calls } = makeManager();
    const pending = manager.request({
      action: 'deploy.prod',
      requester: 'release-bot',
      task_id: 't1',
    });
    const g = manager.grantException(GRANT);
    const r = manager.evaluateApprovalGate({ action: 'deploy.prod', task_id: 't1' });
    assert.equal(r.verdict, 'WAIVED');
    assert.notEqual(r.verdict, 'PASS');
    assert.equal(r.grant_id, g.id);
    assert.equal(r.granted_by, 'human:cto');
    assert.match(r.failure_reason ?? '', /still PENDING/);
    assert.equal(r.approval_id, null);
    // The waiver did not touch the ticket: still PENDING, no APPROVED exists,
    // and no approval evidence payload can be produced from it.
    assert.equal(manager.get(pending.approval_id).status, 'PENDING');
    assert.equal(manager.list('APPROVED').length, 0);
    assert.throws(
      () => manager.approvalEvidencePayload(manager.get(pending.approval_id)),
      ApprovalNotApprovedError,
    );
    // Audit records the waiver with grant id + original failure reason.
    const waived = calls.find((c) => c.action === 'APPROVAL_GATE_WAIVED');
    assert.ok(waived);
    assert.equal(waived.entityId, g.id);
    assert.equal(waived.details.grant_id, g.id);
    assert.match(String(waived.details.failure_reason), /still PENDING/);
  });

  it('a REJECTED decision stays the recorded failure under a waiver (not washed into PASS)', () => {
    const { manager } = makeManager();
    const a = manager.request({
      action: 'deploy.prod',
      requester: 'release-bot',
      task_id: 't1',
    });
    manager.decide(a.approval_id, {
      approved: false,
      decided_by: 'human',
      decision_reason: 'tests red',
    });
    const before = manager.evaluateApprovalGate({ action: 'deploy.prod', task_id: 't1' });
    assert.equal(before.verdict, 'FAILED');
    assert.match(before.failure_reason ?? '', /REJECTED by human: tests red/);

    manager.grantException(GRANT);
    const after = manager.evaluateApprovalGate({ action: 'deploy.prod', task_id: 't1' });
    assert.equal(after.verdict, 'WAIVED');
    assert.match(after.failure_reason ?? '', /REJECTED by human: tests red/);
    // The decision record itself is untouched by the grant.
    assert.equal(manager.get(a.approval_id).status, 'REJECTED');
  });

  it('a usable APPROVED approval wins PASS over a grant (grant is not consumed)', () => {
    const { manager, calls } = makeManager();
    const a = manager.request({
      action: 'deploy.prod',
      requester: 'release-bot',
      task_id: 't1',
    });
    manager.decide(a.approval_id, { approved: true, decided_by: 'human' });
    manager.grantException(GRANT);
    const r = manager.evaluateApprovalGate({ action: 'deploy.prod', task_id: 't1' });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.approval_id, a.approval_id);
    assert.equal(r.grant_id, null);
    assert.ok(!calls.some((c) => c.action === 'APPROVAL_GATE_WAIVED'));
  });

  it('an AUTO action passes with no approval and no grant', () => {
    const { manager } = makeManager();
    const r = manager.evaluateApprovalGate({ action: 'filesystem.write', task_id: 't1' });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.failure_reason, null);
  });

  it('a BLOCKED action is BLOCKED at the gate even with grants around (use-side refusal, audited)', () => {
    const { manager, calls } = makeManager();
    manager.grantException(GRANT); // some unrelated live grant
    const r = manager.evaluateApprovalGate({ action: 'secret.write', task_id: 't1' });
    assert.equal(r.verdict, 'BLOCKED');
    assert.notEqual(r.verdict, 'WAIVED');
    assert.equal(r.grant_id, null);
    assert.match(r.failure_reason ?? '', /BLOCKED by policy/);
    assert.ok(calls.some((c) => c.action === 'APPROVAL_GATE_BLOCKED'));
  });

  it('scope: a task-scoped grant does not waive another task; an any-task grant does; action must match exactly', () => {
    const { manager } = makeManager();
    manager.grantException(GRANT); // task t1 only
    assert.equal(
      manager.evaluateApprovalGate({ action: 'deploy.prod', task_id: 't2' }).verdict,
      'FAILED',
    );
    assert.equal(
      manager.evaluateApprovalGate({ action: 'git.push', task_id: 't1' }).verdict,
      'FAILED',
    );
    manager.grantException({
      action: 'deploy.prod',
      granted_by: 'human',
      reason: 'org-wide maintenance window',
    });
    assert.equal(
      manager.evaluateApprovalGate({ action: 'deploy.prod', task_id: 't2' }).verdict,
      'WAIVED',
    );
  });
});

describe('grant expiry / revocation (fail-closed)', () => {
  it('an expired grant does not waive; encountering it marks EXPIRED with audit', () => {
    const { manager, calls } = makeManager();
    const g = manager.grantException({ ...GRANT, ttlMs: -1000 }); // born expired
    const r = manager.evaluateApprovalGate({ action: 'deploy.prod', task_id: 't1' });
    assert.equal(r.verdict, 'FAILED');
    assert.equal(r.grant_id, null);
    assert.equal(manager.getException(g.id).status, 'EXPIRED');
    assert.ok(calls.some((c) => c.action === 'EXCEPTION_GRANT_EXPIRED'));
  });

  it('sweepExpiredGrants expires only overdue ACTIVE grants', () => {
    const { manager } = makeManager();
    const old = manager.grantException({ ...GRANT, ttlMs: -1000 });
    const fresh = manager.grantException({ ...GRANT, task_id: 't9' });
    const swept = manager.sweepExpiredGrants();
    assert.deepEqual(swept.map((g) => g.id), [old.id]);
    assert.equal(manager.getException(fresh.id).status, 'ACTIVE');
  });

  it('a revoked grant does not waive; revocation is human-only and audited', () => {
    const { manager, calls } = makeManager();
    const g = manager.grantException(GRANT);
    assert.throws(
      () => manager.revokeException(g.id, { revoked_by: 'agent-1' }),
      (e: unknown) =>
        e instanceof ExceptionGrantDeniedError && e.code === 'NON_HUMAN_GRANTOR',
    );
    const revoked = manager.revokeException(g.id, {
      revoked_by: 'human:cto',
      reason: 'window closed early',
    });
    assert.equal(revoked.status, 'REVOKED');
    assert.equal(revoked.revoked_by, 'human:cto');
    assert.equal(revoked.revocation_reason, 'window closed early');
    assert.ok(calls.some((c) => c.action === 'EXCEPTION_GRANT_REVOKED'));
    assert.equal(
      manager.evaluateApprovalGate({ action: 'deploy.prod', task_id: 't1' }).verdict,
      'FAILED',
    );
    // Revoking again is refused (not ACTIVE anymore).
    assert.throws(
      () => manager.revokeException(g.id, { revoked_by: 'human' }),
      (e: unknown) =>
        e instanceof ExceptionGrantDeniedError && e.code === 'NOT_ACTIVE',
    );
  });

  it('getException throws for unknown ids', () => {
    const { manager } = makeManager();
    assert.throws(() => manager.getException('nope'), ExceptionGrantNotFoundError);
  });
});

describe('no-grant behavior is unchanged (§23.3 paths untouched)', () => {
  it('request/decide flows behave exactly as before when grants exist but do not apply', () => {
    const { manager } = makeManager();
    manager.grantException({ ...GRANT, action: 'git.push', task_id: 'other' });
    const a = manager.request({
      action: 'deploy.prod',
      requester: 'release-bot',
      task_id: 't1',
    });
    const decided = manager.decide(a.approval_id, {
      approved: false,
      decided_by: 'human',
      decision_reason: 'not today',
    });
    assert.equal(decided.status, 'REJECTED');
    assert.equal(decided.decision_reason, 'not today');
    const r = manager.evaluateApprovalGate({ action: 'deploy.prod', task_id: 't1' });
    assert.equal(r.verdict, 'FAILED');
    assert.match(r.failure_reason ?? '', /REJECTED by human: not today/);
  });
});

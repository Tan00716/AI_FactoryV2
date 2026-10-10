/**
 * Unit tests for the v2 approval system (SPEC §23.3, §23.4), incl. DEF-001
 * regression tests and approval invalidation on bound-context change.
 * Run from the package dir: npx tsc -p tsconfig.json && node --test dist/tests/*.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalBlockedError,
  ApprovalDeciderNotAuthorizedError,
  ApprovalManager,
  ApprovalNotApprovedError,
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  InMemoryApprovalStore,
  actionDigest,
  deciderSatisfies,
  evaluateAction,
} from '../src/index';
import {
  EvidenceEngine,
  TaskManager,
  AuditLog,
  WorkflowEngine,
} from '@ai-factory/core';

interface AuditCall {
  action: string;
  entityId: string;
  details: Record<string, unknown>;
}

function makeManager(policyVersion = 'v2-test') {
  const calls: AuditCall[] = [];
  const manager = new ApprovalManager(new InMemoryApprovalStore(), {
    audit: (action, entityId, details) => calls.push({ action, entityId, details }),
    policyVersion,
  });
  return { manager, calls };
}

const PASS = { verdict: 'PASS' };

const BINDING = {
  candidate_digest: 'sha256:candidate-1',
  evidence_manifest_hash: 'sha256:manifest-1',
  policy_version: 'v2-test',
  environment: 'prod',
};

function requestDeploy(manager: ApprovalManager) {
  return manager.request({
    action: 'deploy.prod',
    requester: 'release-bot',
    task_id: 't1',
    candidate_digest: BINDING.candidate_digest,
    environment: BINDING.environment,
    evidence_manifest_hash: BINDING.evidence_manifest_hash,
    risk_level: 'HIGH',
  });
}

describe('ApprovalManager lifecycle (v2 fields)', () => {
  it('request creates a PENDING approval with §23.3 fields and audits APPROVAL_REQUESTED', () => {
    const { manager, calls } = makeManager();
    const a = requestDeploy(manager);
    assert.equal(a.status, 'PENDING');
    assert.equal(a.decision, '');
    assert.deepEqual(a.required_approvers, ['human']);
    assert.equal(a.risk_level, 'HIGH');
    assert.equal(a.task_id, 't1');
    assert.equal(a.candidate_digest, BINDING.candidate_digest);
    assert.equal(a.environment, 'prod');
    assert.equal(a.evidence_manifest_hash, BINDING.evidence_manifest_hash);
    assert.equal(a.policy_version, 'v2-test');
    assert.equal(a.action_digest, actionDigest('deploy.prod'));
    assert.equal(a.action_digest.length, 64);
    assert.ok(a.deadline);
    assert.equal(a.decided_at, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'APPROVAL_REQUESTED');
    assert.equal(calls[0].entityId, a.approval_id);
  });

  it('request honours an explicit required_approvers array', () => {
    const { manager } = makeManager();
    const a = manager.request({
      action: 'deploy.prod',
      requester: 'x',
      required_approvers: ['human:cto', 'human:vp-eng'],
    });
    assert.deepEqual(a.required_approvers, ['human:cto', 'human:vp-eng']);
  });

  it('approve path sets APPROVED with decider and audits APPROVAL_DECIDED', () => {
    const { manager, calls } = makeManager();
    const a = requestDeploy(manager);
    const decided = manager.decide(a.approval_id, {
      approved: true,
      decided_by: 'human',
      decision_reason: 'canary green',
    });
    assert.equal(decided.status, 'APPROVED');
    assert.equal(decided.decision, 'APPROVED');
    assert.equal(decided.decided_by, 'human');
    assert.equal(decided.decision_reason, 'canary green');
    assert.ok(decided.decided_at);
    const last = calls[calls.length - 1];
    assert.equal(last.action, 'APPROVAL_DECIDED');
    assert.equal(last.details['approved'], true);
  });

  it('reject path sets REJECTED with decision_reason', () => {
    const { manager } = makeManager();
    const a = manager.request({ action: 'secret.read', requester: 'agent-2' });
    const decided = manager.decide(a.approval_id, {
      approved: false,
      decided_by: 'human:lead',
      decision_reason: 'no business need',
    });
    assert.equal(decided.status, 'REJECTED');
    assert.equal(decided.decided_by, 'human:lead');
  });

  it('double decide throws ApprovalNotPendingError', () => {
    const { manager } = makeManager();
    const a = requestDeploy(manager);
    manager.decide(a.approval_id, { approved: true, decided_by: 'human' });
    assert.throws(
      () => manager.decide(a.approval_id, { approved: false, decided_by: 'human' }),
      ApprovalNotPendingError,
    );
  });

  it('decide on an unknown id throws ApprovalNotFoundError', () => {
    const { manager } = makeManager();
    assert.throws(
      () => manager.decide('nope', { approved: true, decided_by: 'human' }),
      ApprovalNotFoundError,
    );
  });

  it('decide on an expired request auto-marks EXPIRED, audits, and throws', () => {
    const { manager, calls } = makeManager();
    const a = manager.request({
      action: 'deploy.prod',
      requester: 'agent-1',
      ttlMs: -1000, // already expired
    });
    assert.throws(
      () => manager.decide(a.approval_id, { approved: true, decided_by: 'human' }),
      (e: unknown) => e instanceof Error && e.name === 'ApprovalExpiredError',
    );
    assert.equal(manager.get(a.approval_id).status, 'EXPIRED');
    assert.ok(calls.some((c) => c.action === 'APPROVAL_EXPIRED'));
  });

  it('sweepExpired expires only overdue PENDING approvals', () => {
    const { manager, calls } = makeManager();
    const old = manager.request({
      action: 'deploy.prod', requester: 'agent-1', ttlMs: -1000,
    });
    const fresh = manager.request({ action: 'git.push', requester: 'agent-2' });
    const swept = manager.sweepExpired();
    assert.equal(swept.length, 1);
    assert.equal(swept[0].approval_id, old.approval_id);
    assert.equal(manager.get(old.approval_id).status, 'EXPIRED');
    assert.equal(manager.get(fresh.approval_id).status, 'PENDING');
    assert.equal(
      calls.filter((c) => c.action === 'APPROVAL_EXPIRED').length, 1,
    );
  });

  it('cancel moves PENDING → CANCELLED and audits', () => {
    const { manager, calls } = makeManager();
    const a = requestDeploy(manager);
    const cancelled = manager.cancel(a.approval_id, 'human');
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.decided_by, 'human');
    assert.ok(cancelled.decided_at);
    assert.ok(calls.some((c) => c.action === 'APPROVAL_CANCELLED'));
  });

  it('cancel on a decided approval throws ApprovalNotPendingError', () => {
    const { manager } = makeManager();
    const a = requestDeploy(manager);
    manager.decide(a.approval_id, { approved: true, decided_by: 'human' });
    assert.throws(() => manager.cancel(a.approval_id, 'human'), ApprovalNotPendingError);
  });

  it('request validates required fields', () => {
    const { manager } = makeManager();
    assert.throws(() => manager.request({ action: '', requester: 'x' }), /action is required/);
    assert.throws(() => manager.request({ action: 'git.push', requester: '' }), /requester is required/);
  });

  it('list filters by status and listByTask scopes to the task', () => {
    const { manager } = makeManager();
    const a1 = manager.request({ action: 'deploy.prod', requester: 'x', task_id: 't1' });
    const a2 = manager.request({ action: 'git.push', requester: 'x', task_id: 't2' });
    manager.decide(a2.approval_id, { approved: true, decided_by: 'human' });
    assert.equal(manager.list('PENDING').length, 1);
    assert.equal(manager.list('PENDING')[0].approval_id, a1.approval_id);
    assert.equal(manager.list().length, 2);
    assert.deepEqual(manager.listByTask('t1').map((a) => a.approval_id), [a1.approval_id]);
  });

  it('approvalEvidencePayload carries the bound context for an APPROVED approval', () => {
    const { manager } = makeManager();
    const a = requestDeploy(manager);
    const decided = manager.decide(a.approval_id, { approved: true, decided_by: 'human' });
    const payload = manager.approvalEvidencePayload(decided);
    assert.deepEqual(payload, {
      verdict: 'APPROVED',
      approval_id: decided.approval_id,
      action: 'deploy.prod',
      action_digest: actionDigest('deploy.prod'),
      decided_by: 'human',
      candidate_digest: BINDING.candidate_digest,
      evidence_manifest_hash: BINDING.evidence_manifest_hash,
      policy_version: 'v2-test',
      environment: 'prod',
    });
  });

  it('approvalEvidencePayload throws for a non-APPROVED approval', () => {
    const { manager } = makeManager();
    const pending = requestDeploy(manager);
    assert.throws(() => manager.approvalEvidencePayload(pending), ApprovalNotApprovedError);
  });
});

describe('DEF-001 regression: policy enforcement at the manager', () => {
  it('request() refuses a BLOCKED action — no ticket is created', () => {
    const { manager, calls } = makeManager();
    assert.throws(
      () => manager.request({ action: 'secret.write', requester: 'rogue-agent' }),
      (e: unknown) =>
        e instanceof ApprovalBlockedError &&
        /BLOCKED actions cannot be approved/.test(e.message),
    );
    assert.equal(manager.list().length, 0);
    assert.ok(!calls.some((c) => c.action === 'APPROVAL_REQUESTED'));
  });

  it('request() refuses BLOCKED even at CRITICAL risk', () => {
    const { manager } = makeManager();
    assert.throws(
      () =>
        manager.request({ action: 'secret.write', requester: 'x', risk_level: 'CRITICAL' }),
      ApprovalBlockedError,
    );
  });

  it('decide() rejects a decider that does not satisfy required_approvers', () => {
    const { manager } = makeManager();
    const a = requestDeploy(manager); // required_approvers defaults to ['human']
    assert.throws(
      () => manager.decide(a.approval_id, { approved: true, decided_by: 'rogue-agent' }),
      (e: unknown) =>
        e instanceof ApprovalDeciderNotAuthorizedError &&
        /rogue-agent/.test(e.message),
    );
    // Still PENDING — the rogue decision did not land.
    assert.equal(manager.get(a.approval_id).status, 'PENDING');
  });

  it('decide() rejects a wrong human identity when a specific approver is required', () => {
    const { manager } = makeManager();
    const a = manager.request({
      action: 'deploy.prod',
      requester: 'x',
      required_approvers: ['human:cto'],
    });
    assert.throws(
      () => manager.decide(a.approval_id, { approved: true, decided_by: 'human:vp-eng' }),
      ApprovalDeciderNotAuthorizedError,
    );
  });

  it('deciderSatisfies: role prefix matches, exact identity matches, others fail', () => {
    assert.equal(deciderSatisfies(['human'], 'human'), true);
    assert.equal(deciderSatisfies(['human'], 'human:alice'), true);
    assert.equal(deciderSatisfies(['human:alice'], 'human:alice'), true);
    assert.equal(deciderSatisfies(['human:alice'], 'human:bob'), false);
    assert.equal(deciderSatisfies(['human'], 'rogue-agent'), false);
    assert.equal(deciderSatisfies(['human', 'ai:reviewer-1'], 'ai:reviewer-1'), true);
    assert.equal(deciderSatisfies([], 'human'), false);
  });

  it('decide() requires decided_by', () => {
    const { manager } = makeManager();
    const a = requestDeploy(manager);
    assert.throws(
      () => manager.decide(a.approval_id, { approved: true, decided_by: '' }),
      /decided_by is required/,
    );
  });
});

describe('§23.3 invalidation on bound-context change', () => {
  it('unchanged context keeps the approval usable', () => {
    const { manager } = makeManager();
    const a = requestDeploy(manager);
    const decided = manager.decide(a.approval_id, { approved: true, decided_by: 'human' });
    const r = manager.invalidate(a.approval_id, BINDING);
    assert.equal(r.invalidated, false);
    assert.deepEqual(r.changed, []);
    assert.equal(manager.isUsable(decided, BINDING), true);
  });

  it('a changed candidate_digest INVALIDATES the approval (history kept)', () => {
    const { manager, calls } = makeManager();
    const a = requestDeploy(manager);
    manager.decide(a.approval_id, { approved: true, decided_by: 'human' });
    const r = manager.invalidate(a.approval_id, {
      ...BINDING,
      candidate_digest: 'sha256:candidate-2',
    });
    assert.equal(r.invalidated, true);
    assert.deepEqual(r.changed, ['candidate_digest']);
    const stored = manager.get(a.approval_id);
    assert.equal(stored.status, 'INVALIDATED');
    assert.equal(stored.decision, 'APPROVED'); // original decision preserved in history
    assert.ok(calls.some((c) => c.action === 'APPROVAL_INVALIDATED'));
  });

  it('each bound field independently triggers invalidation', () => {
    const fields = [
      'candidate_digest',
      'evidence_manifest_hash',
      'policy_version',
      'environment',
    ] as const;
    for (const field of fields) {
      const { manager } = makeManager();
      const a = requestDeploy(manager);
      manager.decide(a.approval_id, { approved: true, decided_by: 'human' });
      const r = manager.invalidate(a.approval_id, { ...BINDING, [field]: 'changed' });
      assert.equal(r.invalidated, true, field);
      assert.deepEqual(r.changed, [field]);
    }
  });

  it('an INVALIDATED approval cannot produce an evidence payload', () => {
    const { manager } = makeManager();
    const a = requestDeploy(manager);
    const decided = manager.decide(a.approval_id, { approved: true, decided_by: 'human' });
    manager.invalidate(a.approval_id, { ...BINDING, environment: 'staging' });
    assert.throws(
      () => manager.approvalEvidencePayload(manager.get(a.approval_id)),
      ApprovalNotApprovedError,
    );
    assert.equal(manager.isUsable(decided, { ...BINDING, environment: 'staging' }), false);
  });

  it('invalidate on a non-APPROVED approval is a no-op', () => {
    const { manager } = makeManager();
    const a = requestDeploy(manager); // still PENDING
    const r = manager.invalidate(a.approval_id, { ...BINDING, environment: 'staging' });
    assert.equal(r.invalidated, false);
    assert.equal(manager.get(a.approval_id).status, 'PENDING');
  });
});

describe('evaluateAction policy matrix', () => {
  it('deploy.prod → HUMAN_APPROVAL and requires approval', () => {
    const r = evaluateAction('deploy.prod', 'MEDIUM');
    assert.equal(r.level, 'HUMAN_APPROVAL');
    assert.equal(r.requiresApproval, true);
  });

  it('unknown actions default to AUTO with no approval required', () => {
    const r = evaluateAction('shell.execute', 'LOW');
    assert.equal(r.level, 'AUTO');
    assert.equal(r.requiresApproval, false);
    assert.match(r.reason, /defaulting to AUTO/);
  });

  it('CRITICAL risk escalates an AUTO action to HUMAN_APPROVAL', () => {
    const r = evaluateAction('filesystem.write', 'CRITICAL');
    assert.equal(r.level, 'HUMAN_APPROVAL');
    assert.equal(r.requiresApproval, true);
    assert.match(r.reason, /escalates/);
  });

  it('secret.write → BLOCKED regardless of risk', () => {
    for (const risk of ['LOW', 'CRITICAL'] as const) {
      const r = evaluateAction('secret.write', risk);
      assert.equal(r.level, 'BLOCKED');
      assert.match(r.reason, /BLOCKED/);
    }
  });

  it('deploy.uat / git.push → AI_REVIEW', () => {
    assert.equal(evaluateAction('deploy.uat').level, 'AI_REVIEW');
    assert.equal(evaluateAction('git.push').level, 'AI_REVIEW');
    assert.equal(evaluateAction('deploy.uat').requiresApproval, true);
  });
});

describe('approval gate integration (PENDING_PROD → PROD_DEPLOYING)', () => {
  function walkToPendingProd() {
    const tasks = new TaskManager();
    const evidence = new EvidenceEngine();
    const audit = new AuditLog();
    const engine = new WorkflowEngine({ tasks, evidence, audit });
    const t = tasks.create({ projectId: 'p1', title: 'Ship v1.2.3' });
    const ev = (
      type: Parameters<EvidenceEngine['create']>[0]['type'],
      payload: Record<string, unknown> = PASS,
    ) => evidence.create({ taskId: t.id, type, title: type, payload, createdBy: 'ci' });
    const go = (to: Parameters<WorkflowEngine['requestTransition']>[1]) => {
      const r = engine.requestTransition(t.id, to, 'ai-pm');
      assert.equal(r.ok, true, `expected ${to} to be allowed: ${JSON.stringify(r)}`);
    };
    go('PLANNING');
    ev('plan', { title: 'Release plan' });
    go('IN_PROGRESS');
    ev('code_change', { sha: 'abc123' });
    go('CODE_REVIEW');
    ev('code_review', PASS);
    go('PENDING_QA');
    go('QA');
    ev('ci_result', PASS);
    ev('qa_result', PASS);
    ev('security_report', PASS);
    go('PENDING_UAT_MERGE');
    ev('merge', { pr: 42 });
    go('UAT');
    ev('uat_result', PASS);
    go('PENDING_PROD');
    assert.equal(tasks.get(t.id).status, 'PENDING_PROD');
    return { tasks, evidence, engine, taskId: t.id };
  }

  it('denies PROD_DEPLOYING without an approval evidence record', () => {
    const { engine, taskId } = walkToPendingProd();
    const r = engine.requestTransition(taskId, 'PROD_DEPLOYING', 'ai-pm');
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, 'GATE_DENIED');
      assert.ok(r.missing.some((m) => m.includes('Production deployment approval')));
    }
  });

  it('grants PROD_DEPLOYING once an approved approval is attached as evidence', () => {
    const { evidence, engine, taskId } = walkToPendingProd();
    const { manager } = makeManager();
    const approval = manager.request({
      action: 'deploy.prod',
      requester: 'release-bot',
      task_id: taskId,
      risk_level: 'HIGH',
    });
    const decided = manager.decide(approval.approval_id, { approved: true, decided_by: 'human' });
    evidence.create({
      taskId,
      type: 'approval',
      title: `Approval: ${decided.action}`,
      payload: { ...manager.approvalEvidencePayload(decided) },
      createdBy: decided.decided_by,
    });
    const r = engine.requestTransition(taskId, 'PROD_DEPLOYING', 'human');
    assert.equal(r.ok, true, `expected transition to be granted: ${JSON.stringify(r)}`);
  });
});

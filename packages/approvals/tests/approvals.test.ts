/**
 * Unit tests for the approval system (spec §45, §69) and its integration with
 * the PENDING_PROD → PROD_DEPLOYING gate (spec §41).
 * Run from the package dir: npx tsc -p tsconfig.json && node --test dist/tests/*.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalManager,
  ApprovalNotApprovedError,
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  InMemoryApprovalStore,
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

function makeManager() {
  const calls: AuditCall[] = [];
  const manager = new ApprovalManager(new InMemoryApprovalStore(), {
    audit: (action, entityId, details) => calls.push({ action, entityId, details }),
  });
  return { manager, calls };
}

const PASS = { verdict: 'PASS' };

describe('ApprovalManager lifecycle', () => {
  it('request creates a PENDING approval and audits APPROVAL_REQUESTED', () => {
    const { manager, calls } = makeManager();
    const a = manager.request({
      action: 'deploy.prod',
      requestedBy: 'agent-1',
      taskId: 't1',
      riskLevel: 'HIGH',
      evidenceIds: ['ev1'],
    });
    assert.equal(a.status, 'PENDING');
    assert.equal(a.decision, '');
    assert.equal(a.requiredApprover, 'human');
    assert.equal(a.riskLevel, 'HIGH');
    assert.deepEqual(a.evidenceIds, ['ev1']);
    assert.ok(a.expiresAt);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'APPROVAL_REQUESTED');
    assert.equal(calls[0].entityId, a.id);
  });

  it('approve path sets APPROVED and audits APPROVAL_DECIDED with {approved:true}', () => {
    const { manager, calls } = makeManager();
    const a = manager.request({ action: 'deploy.prod', requestedBy: 'agent-1' });
    const decided = manager.decide(a.id, { approved: true, decidedBy: 'human' });
    assert.equal(decided.status, 'APPROVED');
    assert.equal(decided.decision, 'APPROVED');
    assert.equal(decided.decidedBy, 'human');
    assert.ok(decided.decidedAt);
    const last = calls[calls.length - 1];
    assert.equal(last.action, 'APPROVAL_DECIDED');
    assert.equal(last.details['approved'], true);
  });

  it('approvalEvidencePayload builds the gate payload for an APPROVED approval', () => {
    const { manager } = makeManager();
    const a = manager.request({ action: 'deploy.prod', requestedBy: 'agent-1' });
    const decided = manager.decide(a.id, { approved: true, decidedBy: 'human' });
    const payload = manager.approvalEvidencePayload(decided);
    assert.deepEqual(payload, {
      verdict: 'APPROVED',
      approvalId: decided.id,
      action: 'deploy.prod',
      decidedBy: 'human',
    });
  });

  it('approvalEvidencePayload throws for a non-APPROVED approval', () => {
    const { manager } = makeManager();
    const pending = manager.request({ action: 'deploy.prod', requestedBy: 'agent-1' });
    assert.throws(() => manager.approvalEvidencePayload(pending), ApprovalNotApprovedError);
  });

  it('reject path sets REJECTED with decision REJECTED', () => {
    const { manager, calls } = makeManager();
    const a = manager.request({ action: 'secret.read', requestedBy: 'agent-2' });
    const decided = manager.decide(a.id, { approved: false, decidedBy: 'lead' });
    assert.equal(decided.status, 'REJECTED');
    assert.equal(decided.decision, 'REJECTED');
    assert.equal(decided.decidedBy, 'lead');
    assert.equal(calls[calls.length - 1].details['approved'], false);
  });

  it('double decide throws ApprovalNotPendingError', () => {
    const { manager } = makeManager();
    const a = manager.request({ action: 'deploy.prod', requestedBy: 'agent-1' });
    manager.decide(a.id, { approved: true, decidedBy: 'human' });
    assert.throws(
      () => manager.decide(a.id, { approved: false, decidedBy: 'human' }),
      ApprovalNotPendingError,
    );
  });

  it('decide on an unknown id throws ApprovalNotFoundError', () => {
    const { manager } = makeManager();
    assert.throws(
      () => manager.decide('nope', { approved: true, decidedBy: 'human' }),
      ApprovalNotFoundError,
    );
  });

  it('decide on an expired request auto-marks EXPIRED, audits, and throws', () => {
    const { manager, calls } = makeManager();
    const a = manager.request({
      action: 'deploy.prod',
      requestedBy: 'agent-1',
      ttlMs: -1000, // already expired
    });
    assert.throws(
      () => manager.decide(a.id, { approved: true, decidedBy: 'human' }),
      (e: unknown) => e instanceof Error && e.name === 'ApprovalExpiredError',
    );
    assert.equal(manager.get(a.id).status, 'EXPIRED');
    assert.ok(calls.some((c) => c.action === 'APPROVAL_EXPIRED'));
  });

  it('sweepExpired expires only overdue PENDING approvals', () => {
    const { manager, calls } = makeManager();
    const old = manager.request({
      action: 'deploy.prod', requestedBy: 'agent-1', ttlMs: -1000,
    });
    const fresh = manager.request({ action: 'git.push', requestedBy: 'agent-2' });
    const swept = manager.sweepExpired();
    assert.equal(swept.length, 1);
    assert.equal(swept[0].id, old.id);
    assert.equal(manager.get(old.id).status, 'EXPIRED');
    assert.equal(manager.get(fresh.id).status, 'PENDING');
    assert.equal(
      calls.filter((c) => c.action === 'APPROVAL_EXPIRED').length, 1,
    );
  });

  it('cancel moves PENDING → CANCELLED and audits', () => {
    const { manager, calls } = makeManager();
    const a = manager.request({ action: 'deploy.prod', requestedBy: 'agent-1' });
    const cancelled = manager.cancel(a.id, 'human');
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.decidedBy, 'human');
    assert.ok(cancelled.decidedAt);
    assert.ok(calls.some((c) => c.action === 'APPROVAL_CANCELLED'));
  });

  it('cancel on a decided approval throws ApprovalNotPendingError', () => {
    const { manager } = makeManager();
    const a = manager.request({ action: 'deploy.prod', requestedBy: 'agent-1' });
    manager.decide(a.id, { approved: true, decidedBy: 'human' });
    assert.throws(() => manager.cancel(a.id, 'human'), ApprovalNotPendingError);
  });

  it('request validates required fields', () => {
    const { manager } = makeManager();
    assert.throws(() => manager.request({ action: '', requestedBy: 'x' }), /action is required/);
    assert.throws(() => manager.request({ action: 'git.push', requestedBy: '' }), /requestedBy is required/);
  });

  it('list filters by status and listByTask scopes to the task', () => {
    const { manager } = makeManager();
    const a1 = manager.request({ action: 'deploy.prod', requestedBy: 'x', taskId: 't1' });
    const a2 = manager.request({ action: 'git.push', requestedBy: 'x', taskId: 't2' });
    manager.decide(a2.id, { approved: true, decidedBy: 'human' });
    assert.equal(manager.list('PENDING').length, 1);
    assert.equal(manager.list('PENDING')[0].id, a1.id);
    assert.equal(manager.list().length, 2);
    assert.deepEqual(manager.listByTask('t1').map((a) => a.id), [a1.id]);
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
      requestedBy: 'release-bot',
      taskId,
      riskLevel: 'HIGH',
    });
    const decided = manager.decide(approval.id, { approved: true, decidedBy: 'human' });
    evidence.create({
      taskId,
      type: 'approval',
      title: `Approval: ${decided.action}`,
      payload: { ...manager.approvalEvidencePayload(decided) },
      createdBy: decided.decidedBy,
    });
    const r = engine.requestTransition(taskId, 'PROD_DEPLOYING', 'human');
    assert.equal(r.ok, true, `expected transition to be granted: ${JSON.stringify(r)}`);
  });
});

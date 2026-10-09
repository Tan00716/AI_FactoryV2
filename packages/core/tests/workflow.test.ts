/**
 * Unit tests for the workflow state machine + gates (spec §11, §12).
 * Run: npm test  (from the repo root)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRegistry,
  AuditLog,
  EvidenceEngine,
  TaskManager,
  WorkflowEngine,
  allowedNextStates,
} from '../src/index';

function makeStack() {
  const tasks = new TaskManager();
  const evidence = new EvidenceEngine();
  const audit = new AuditLog();
  const agents = new AgentRegistry();
  const engine = new WorkflowEngine({ tasks, evidence, audit });
  return { tasks, evidence, audit, agents, engine };
}

const PASS = { verdict: 'PASS' };

describe('workflow state machine', () => {
  it('walks the full happy path TODO → DONE when evidence is present', () => {
    const { tasks, evidence, engine } = makeStack();
    const t = tasks.create({ projectId: 'p1', title: 'Fix payment bug' });
    const ev = (type: Parameters<EvidenceEngine['create']>[0]['type'], payload: Record<string, unknown> = PASS) =>
      evidence.create({ taskId: t.id, type, title: type, payload, createdBy: 'qa' });

    const go = (to: Parameters<WorkflowEngine['requestTransition']>[1]) => {
      const r = engine.requestTransition(t.id, to, 'ai-pm');
      assert.equal(r.ok, true, `expected ${to} to be allowed, got ${JSON.stringify(r)}`);
    };

    go('PLANNING');
    ev('plan', { title: 'Plan v1' });
    go('IN_PROGRESS');
    ev('code_change', { sha: 'abc123' });
    go('CODE_REVIEW');
    ev('code_review', PASS);
    go('PENDING_QA');
    go('QA');
    ev('ci_result', PASS);
    ev('qa_result', { verdict: 'PASS', total: 524, passed: 524 });
    ev('security_report', PASS);
    go('PENDING_UAT_MERGE');
    ev('merge', { pr: 481 });
    go('UAT');
    ev('uat_result', PASS);
    go('PENDING_PROD');
    ev('approval', { by: 'human', decision: 'APPROVED' });
    go('PROD_DEPLOYING');
    ev('deployment', { env: 'prod', build: '1.2.3' });
    go('PROD_VERIFICATION');
    ev('smoke_test', PASS);
    go('DONE');

    assert.equal(tasks.get(t.id).status, 'DONE');
    assert.ok(tasks.get(t.id).completedAt);
  });

  it('denies QA → PENDING_UAT_MERGE when security evidence is missing, naming what is missing', () => {
    const { tasks, evidence, engine } = makeStack();
    const t = tasks.create({ projectId: 'p1', title: 'Feature X' });
    const mk = (type: 'plan' | 'code_change' | 'code_review' | 'ci_result' | 'qa_result', payload: Record<string, unknown> = PASS) =>
      evidence.create({ taskId: t.id, type, title: type, payload, createdBy: 'agent' });

    for (const to of ['PLANNING', 'IN_PROGRESS', 'CODE_REVIEW', 'PENDING_QA', 'QA'] as const) {
      if (to === 'IN_PROGRESS') mk('plan', {});
      if (to === 'CODE_REVIEW') mk('code_change', {});
      if (to === 'PENDING_QA') mk('code_review');
      if (to === 'QA') { /* no evidence needed */ }
      const r = engine.requestTransition(t.id, to, 'ai-pm');
      assert.equal(r.ok, true);
    }
    mk('ci_result');
    mk('qa_result', { verdict: 'PASS', total: 10, passed: 10 });
    // NOTE: no security_report attached.

    const denied = engine.requestTransition(t.id, 'PENDING_UAT_MERGE', 'ai-pm');
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'GATE_DENIED');
    assert.ok(
      denied.missing.some((m) => m.includes('Security report')),
      `missing list should name the security report, got: ${denied.missing}`,
    );
    // Denial must not mutate state.
    assert.equal(tasks.get(t.id).status, 'QA');

    // Attach the missing evidence → the same transition now succeeds.
    evidence.create({ taskId: t.id, type: 'security_report', title: 'sec', payload: PASS, createdBy: 'sec-agent' });
    const allowed = engine.requestTransition(t.id, 'PENDING_UAT_MERGE', 'ai-pm');
    assert.equal(allowed.ok, true);
  });

  it('rejects transitions that do not exist in the workflow (e.g. TODO → DONE)', () => {
    const { tasks, engine } = makeStack();
    const t = tasks.create({ projectId: 'p1', title: 'Shortcut attempt' });
    const r = engine.requestTransition(t.id, 'DONE', 'rogue-agent');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'UNKNOWN_TRANSITION');
    assert.equal(tasks.get(t.id).status, 'TODO');
  });

  it('a FAIL verdict does not satisfy a verdict gate ("evidence beats claims")', () => {
    const { tasks, evidence, engine } = makeStack();
    const t = tasks.create({ projectId: 'p1', title: 'Shaky feature' });
    evidence.create({ taskId: t.id, type: 'plan', title: 'plan', payload: {}, createdBy: 'pm' });
    assert.equal(engine.requestTransition(t.id, 'PLANNING', 'pm').ok, true);
    assert.equal(engine.requestTransition(t.id, 'IN_PROGRESS', 'pm').ok, true);
    evidence.create({ taskId: t.id, type: 'code_change', title: 'c', payload: {}, createdBy: 'coder' });
    assert.equal(engine.requestTransition(t.id, 'CODE_REVIEW', 'coder').ok, true);
    // A review claiming problems were found (verdict FAIL) must not open the QA gate.
    evidence.create({
      taskId: t.id, type: 'code_review', title: 'review',
      payload: { verdict: 'FAIL', issues: 3 }, createdBy: 'reviewer',
    });
    const r = engine.requestTransition(t.id, 'PENDING_QA', 'coder');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'GATE_DENIED');
  });

  it('seals evidence consumed by a gate and writes an audit record', () => {
    const { tasks, evidence, engine, audit } = makeStack();
    const t = tasks.create({ projectId: 'p1', title: 'Seal check' });
    const plan = evidence.create({ taskId: t.id, type: 'plan', title: 'plan', payload: {}, createdBy: 'pm' });
    assert.equal(engine.requestTransition(t.id, 'PLANNING', 'pm').ok, true);
    const r = engine.requestTransition(t.id, 'IN_PROGRESS', 'pm');
    assert.equal(r.ok, true);
    assert.equal(evidence.statusOf(plan.id), 'SEALED');

    const records = audit.list();
    assert.ok(records.some((rec) => rec.action === 'WORKFLOW_TRANSITIONED' && rec.entityId === t.id));
  });

  it('denied transitions are audited too', () => {
    const { tasks, engine, audit } = makeStack();
    const t = tasks.create({ projectId: 'p1', title: 'Audit denial' });
    engine.requestTransition(t.id, 'DONE', 'rogue-agent');
    const records = audit.list();
    assert.ok(records.some((r) => r.action === 'WORKFLOW_TRANSITION_DENIED'));
  });

  it('allowedNextStates exposes legal moves for the UI', () => {
    const next = allowedNextStates('QA').map((d) => d.to);
    assert.ok(next.includes('PENDING_UAT_MERGE'));
    assert.ok(next.includes('QA_FAILED'));
    assert.deepEqual(allowedNextStates('DONE'), []);
  });
});

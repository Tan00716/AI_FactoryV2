/**
 * Tests for incident management (SPEC v2 §42).
 * Run: node --test dist/tests/incidents.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  IncidentManager,
  IllegalIncidentTransitionError,
  MissingRecoveryEvidenceError,
  ThresholdGamingRefusedError,
  IncompletePostmortemError,
  IncidentNotFoundError,
  Runbook,
} from '../src/index';

function runbook(over: Partial<Runbook> = {}): Runbook {
  return {
    id: 'rb-1',
    name: 'restart-web',
    trigger: 'error_rate > 5%',
    falsePositiveChecks: ['deploy in progress?'],
    allowedEnvs: ['PROD'],
    allowedTools: ['deploy-broker'],
    allowedActions: ['restart-service'],
    maxBlastRadius: 'single service',
    budgetUnits: 10,
    approvalConditions: [],
    recoveryStopPoints: ['service healthy'],
    verification: ['smoke'],
    notifications: ['#incidents'],
    preauthorized: true,
    version: 1,
    ...over,
  };
}

function mgr() {
  return new IncidentManager({ now: () => new Date('2026-10-10T00:00:00.000Z').getTime() });
}

describe('lifecycle', () => {
  it('detection starts at DETECTED', () => {
    const m = mgr();
    const inc = m.create({ title: 'prod 500s', severity: 'P0', detectedBy: 'monitor' });
    assert.equal(inc.status, 'DETECTED');
    assert.ok(inc.id.length > 0);
  });

  it('walks the full legal path DETECTED→…→CLOSED', () => {
    const m = mgr();
    const inc = m.create({ title: 'x', severity: 'P1', detectedBy: 'monitor' });
    const path = ['TRIAGED', 'INVESTIGATING', 'MITIGATING', 'RECOVERING'] as const;
    for (const s of path) m.transition(inc.id, s, 'responder');
    m.addRecoveryEvidence(inc.id, 'ev-smoke-green', 'responder');
    m.transition(inc.id, 'RESOLVED', 'responder');
    m.setPostmortem(inc.id, { rootCause: 'bad deploy', followUp: ['add canary'] }, 'responder');
    m.transition(inc.id, 'POSTMORTEM', 'responder');
    m.transition(inc.id, 'CLOSED', 'responder');
    assert.equal(m.get(inc.id).status, 'CLOSED');
  });

  it('skipping phases is refused', () => {
    const m = mgr();
    const inc = m.create({ title: 'x', severity: 'P1', detectedBy: 'monitor' });
    assert.throws(() => m.transition(inc.id, 'RESOLVED', 'responder'), IllegalIncidentTransitionError);
    assert.throws(() => m.transition(inc.id, 'CLOSED', 'responder'), IllegalIncidentTransitionError);
  });

  it('RESOLVED requires recovery evidence', () => {
    const m = mgr();
    const inc = m.create({ title: 'x', severity: 'P1', detectedBy: 'monitor' });
    for (const s of ['TRIAGED', 'INVESTIGATING', 'MITIGATING', 'RECOVERING'] as const) {
      m.transition(inc.id, s, 'responder');
    }
    assert.throws(() => m.transition(inc.id, 'RESOLVED', 'responder'), MissingRecoveryEvidenceError);
  });

  it('CLOSED requires root cause + follow-ups', () => {
    const m = mgr();
    const inc = m.create({ title: 'x', severity: 'P1', detectedBy: 'monitor' });
    for (const s of ['TRIAGED', 'INVESTIGATING', 'MITIGATING', 'RECOVERING'] as const) {
      m.transition(inc.id, s, 'responder');
    }
    m.addRecoveryEvidence(inc.id, 'ev-1', 'responder');
    m.transition(inc.id, 'RESOLVED', 'responder');
    assert.throws(() => m.transition(inc.id, 'CLOSED', 'responder'), IllegalIncidentTransitionError); // must go via POSTMORTEM
    m.transition(inc.id, 'POSTMORTEM', 'responder');
    assert.throws(() => m.transition(inc.id, 'CLOSED', 'responder'), IncompletePostmortemError);
  });

  it('human confirmation required when policy demands it', () => {
    const m = new IncidentManager({ closePolicy: { requireHumanConfirmation: true } });
    const inc = m.create({ title: 'x', severity: 'P0', detectedBy: 'monitor' });
    for (const s of ['TRIAGED', 'INVESTIGATING', 'MITIGATING', 'RECOVERING'] as const) {
      m.transition(inc.id, s, 'responder');
    }
    m.addRecoveryEvidence(inc.id, 'ev-1', 'responder');
    m.transition(inc.id, 'RESOLVED', 'responder');
    m.setPostmortem(inc.id, { rootCause: 'rc', followUp: ['f1'] }, 'responder');
    m.transition(inc.id, 'POSTMORTEM', 'responder');
    assert.throws(() => m.transition(inc.id, 'CLOSED', 'responder'), IncompletePostmortemError);
    m.setPostmortem(inc.id, { rootCause: 'rc', followUp: ['f1'], humanConfirmedBy: 'human:owner' }, 'human:owner');
    m.transition(inc.id, 'CLOSED', 'human:owner');
    assert.equal(m.get(inc.id).status, 'CLOSED');
  });

  it('unknown incident id throws', () => {
    assert.throws(() => mgr().get('nope'), IncidentNotFoundError);
  });
});

describe('threshold gaming ban', () => {
  it('resolving by changing alert thresholds is refused', () => {
    const m = mgr();
    const inc = m.create({ title: 'x', severity: 'P0', detectedBy: 'monitor' });
    assert.throws(
      () => m.setResolutionBasis(inc.id, 'raised alert threshold to 50%', 'responder'),
      ThresholdGamingRefusedError,
    );
  });

  it('evidence-based resolution basis is accepted', () => {
    const m = mgr();
    const inc = m.create({ title: 'x', severity: 'P0', detectedBy: 'monitor' });
    m.setResolutionBasis(inc.id, 'restarted service, smoke evidence ev-1', 'responder');
    assert.equal(m.get(inc.id).resolutionBasis, 'restarted service, smoke evidence ev-1');
  });
});

describe('runbooks and auto-mitigation', () => {
  it('only pre-authorized runbooks may auto-mitigate', () => {
    const m = mgr();
    m.registerRunbook(runbook({ id: 'rb-auto', preauthorized: true }));
    m.registerRunbook(runbook({ id: 'rb-manual', preauthorized: false }));
    assert.equal(m.canAutoMitigate('rb-auto', true), true);
    assert.equal(m.canAutoMitigate('rb-manual', true), false);
    assert.equal(m.canAutoMitigate('rb-unknown', true), false);
  });

  it('approval conditions gate auto-mitigation', () => {
    const m = mgr();
    m.registerRunbook(runbook({ id: 'rb-cond', preauthorized: true, approvalConditions: ['human ack'] }));
    assert.equal(m.canAutoMitigate('rb-cond', false), false);
    assert.equal(m.canAutoMitigate('rb-cond', true), true);
  });

  it('untrusted-tool emergency stop requires an isolated recovery path', () => {
    const m = mgr();
    const inc = m.create({ title: 'x', severity: 'P0', detectedBy: 'monitor' });
    const plan = m.planRecovery({ incidentId: inc.id, triggeredByUntrustedTool: true });
    assert.equal(plan.isolatedPathRequired, true);
    assert.ok(plan.forbiddenTools.length > 0);
    const ok = m.planRecovery({ incidentId: inc.id, triggeredByUntrustedTool: false });
    assert.equal(ok.isolatedPathRequired, false);
  });
});

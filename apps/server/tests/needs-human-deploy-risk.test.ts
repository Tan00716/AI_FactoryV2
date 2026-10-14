/**
 * Batch 39 — §81 'high-risk-deployment' emission via real assessRisk.
 *
 * What this pins:
 *  1. POST /api/pipelines/:id/deploy no longer mints the parked-approval
 *     ticket with a hardcoded risk_level 'HIGH'. The ticket carries the
 *     ASSESSED level from assessRisk (@ai-factory/cicd, SPEC §41.1 — real
 *     rule engine, un-lowerable floor).
 *  2. parseDeployRiskInput: optional `risk` body object, strict types
 *     (400 on garbage), honest defaults — unknown signals default per
 *     assessRisk's own strictness contract (booleans false, changeType '',
 *     blastRadius 'unknown'), so a deploy with no signals assesses HIGH
 *     for computed reasons, not by assertion.
 *  3. isHighRiskDeployment: only a real HIGH/CRITICAL assessment emits.
 *  4. buildDeployUpgradeRecord: reason 'high-risk-deployment', recipient
 *     null (no named human accounts), requiredDeciderLevel 'manager'
 *     (the §8 human-approver level above daily-work 'operator').
 *  5. emitDeployNeedsHuman: insert-only + NEEDS_HUMAN_RAISED; a failed
 *     write-through audits NEEDS_HUMAN_PERSIST_FAILED and never throws
 *     (must not roll back the parked deployment or its ticket).
 *
 * Dual-mode note: imports the COMPILED ../dist/routes/cicd.js (root
 * build must run first) because src/routes/cicd.ts value-imports the
 * sibling './project-guard' extensionless, which node type-stripping
 * cannot resolve from src. See AGENTS.md dual-mode import rule.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryNeedsHumanStore } from '@ai-factory/db';
import { assessRisk } from '@ai-factory/cicd';
import {
  buildDeployUpgradeRecord,
  emitDeployNeedsHuman,
  isHighRiskDeployment,
  parseDeployRiskInput,
} from '../dist/routes/cicd.js';
import type { RouteContext } from '../src/routes/context.ts';

function makeCtx(store: InMemoryNeedsHumanStore, auditCalls: unknown[][]): RouteContext {
  return {
    fdb: { needsHuman: store },
    audit: {
      record: (...args: unknown[]) => {
        auditCalls.push(args);
      },
    },
  } as unknown as RouteContext;
}

function lowRiskBody() {
  return {
    changeType: 'bugfix',
    blastRadius: 'single-service',
    recoveryReady: true,
    observabilityReady: true,
    testIndependence: true,
  };
}

describe('parseDeployRiskInput (Batch 39)', () => {
  it('absent risk object → honest defaults, nothing claimed provided', () => {
    for (const raw of [undefined, null]) {
      const r = parseDeployRiskInput(raw);
      assert.ok(!('error' in r));
      if ('error' in r) throw new Error('unreachable');
      assert.equal(r.input.changeType, '');
      assert.equal(r.input.blastRadius, 'unknown');
      assert.equal(r.input.recoveryReady, false);
      assert.deepEqual(r.provided, []);
    }
  });

  it('valid signals pass through and are marked provided', () => {
    const r = parseDeployRiskInput({ ...lowRiskBody(), businessCritical: true });
    assert.ok(!('error' in r));
    if ('error' in r) throw new Error('unreachable');
    assert.equal(r.input.changeType, 'bugfix');
    assert.equal(r.input.businessCritical, true);
    assert.ok(r.provided.includes('changeType'));
    assert.ok(r.provided.includes('businessCritical'));
    assert.ok(!r.provided.includes('hasMigration'));
  });

  it('garbage types are rejected, not coerced', () => {
    assert.ok('error' in parseDeployRiskInput('high'));
    assert.ok('error' in parseDeployRiskInput(['high']));
    assert.ok('error' in parseDeployRiskInput({ changeType: 42 }));
    assert.ok('error' in parseDeployRiskInput({ recoveryReady: 'yes' }));
    assert.ok('error' in parseDeployRiskInput({ llmProposedLevel: 'EXTREME' }));
    assert.ok('error' in parseDeployRiskInput({ llmRationale: 7 }));
  });

  it('llmProposedLevel is accepted but can never lower the floor', () => {
    const r = parseDeployRiskInput({ llmProposedLevel: 'LOW', llmRationale: 'looks fine' });
    assert.ok(!('error' in r));
    if ('error' in r) throw new Error('unreachable');
    // Unknown readiness → strict: floor is HIGH regardless of the LLM's LOW.
    const a = assessRisk(r.input);
    assert.equal(a.level, 'HIGH');
    assert.ok(a.reasons.some((x) => x.includes('LLM-proposed LOW rejected')));
  });
});

describe('assessed levels drive the §81 predicate (Batch 39)', () => {
  it('no signals → HIGH by computation (unknown → strict), not by hardcode', () => {
    const r = parseDeployRiskInput(undefined);
    assert.ok(!('error' in r));
    if ('error' in r) throw new Error('unreachable');
    const a = assessRisk(r.input);
    assert.equal(a.level, 'HIGH');
    assert.ok(a.reasons.includes('no verified recovery path (unknown → strict)'));
    assert.equal(isHighRiskDeployment(a.level), true);
  });

  it('fully-ready bugfix → LOW → no emission', () => {
    const r = parseDeployRiskInput(lowRiskBody());
    assert.ok(!('error' in r));
    if ('error' in r) throw new Error('unreachable');
    const a = assessRisk(r.input);
    assert.equal(a.level, 'LOW');
    assert.equal(isHighRiskDeployment(a.level), false);
  });

  it('data-deletion → CRITICAL → emits', () => {
    const r = parseDeployRiskInput({ changeType: 'data-deletion' });
    assert.ok(!('error' in r));
    if ('error' in r) throw new Error('unreachable');
    const a = assessRisk(r.input);
    assert.equal(a.level, 'CRITICAL');
    assert.equal(isHighRiskDeployment(a.level), true);
  });

  it('MEDIUM does not emit', () => {
    assert.equal(isHighRiskDeployment('MEDIUM'), false);
    assert.equal(isHighRiskDeployment('LOW'), false);
  });
});

describe('buildDeployUpgradeRecord (Batch 39)', () => {
  function record() {
    const r = parseDeployRiskInput({ changeType: 'auth-change' });
    assert.ok(!('error' in r));
    if ('error' in r) throw new Error('unreachable');
    return buildDeployUpgradeRecord({
      deploymentId: 'dep-1',
      pipelineId: 'pipe-1',
      environment: 'PROD',
      taskId: 'task-1',
      actor: 'human',
      assessment: assessRisk(r.input),
    });
  }

  it('§81 shape: high-risk-deployment, honest recipient, manager decider', () => {
    const rec = record();
    assert.equal(rec.reason, 'high-risk-deployment');
    assert.equal(rec.reasonZh, '高风险部署');
    assert.equal(rec.severity, 'high');
    assert.equal(rec.source, 'cicd-deploy:dep-1');
    assert.equal(rec.recipient, null);
    assert.equal(rec.requiredDeciderLevel, 'manager');
    assert.equal(rec.status, 'open');
    const detail = JSON.parse(rec.detailJson) as Record<string, unknown>;
    assert.equal(detail['deploymentId'], 'dep-1');
    assert.equal(detail['level'], 'HIGH');
    assert.ok(Array.isArray(detail['reasons']));
    assert.ok((detail['reasons'] as string[]).includes('auth/permission-sensitive change'));
    const context = JSON.parse(rec.contextJson) as Record<string, string>;
    assert.equal(context['environment'], 'PROD');
    assert.equal(context['taskId'], 'task-1');
    // F19 follow-up (Batch 45): the honest narrative must survive
    // persistence — it is copied into detailJson, not only the transient
    // autonomy record.
    assert.match(
      String(detail['narrative']),
      /no deployment was executed — the gate held/,
    );
  });
});

describe('emitDeployNeedsHuman (Batch 39)', () => {
  function record() {
    const r = parseDeployRiskInput(undefined);
    assert.ok(!('error' in r));
    if ('error' in r) throw new Error('unreachable');
    return buildDeployUpgradeRecord({
      deploymentId: 'dep-2',
      pipelineId: 'pipe-2',
      environment: 'PROD',
      taskId: 'task-2',
      actor: 'human',
      assessment: assessRisk(r.input),
    });
  }

  it('insert-only write-through + NEEDS_HUMAN_RAISED audit', () => {
    const store = new InMemoryNeedsHumanStore();
    const audits: unknown[][] = [];
    const rec = record();
    emitDeployNeedsHuman(makeCtx(store, audits), rec);
    assert.equal(store.get(rec.id)?.reason, 'high-risk-deployment');
    const raised = audits.find((a) => a[1] === 'NEEDS_HUMAN_RAISED');
    assert.ok(raised);
    assert.equal((raised?.[4] as Record<string, unknown>)['source'], 'cicd-deploy:dep-2');
  });

  it('failed write-through audits NEEDS_HUMAN_PERSIST_FAILED and never throws', () => {
    const broken = {
      submit: () => {
        throw new Error('disk on fire');
      },
    };
    const audits: unknown[][] = [];
    const rec = record();
    assert.doesNotThrow(() =>
      emitDeployNeedsHuman(makeCtx(broken as unknown as InMemoryNeedsHumanStore, audits), rec),
    );
    const failed = audits.find((a) => a[1] === 'NEEDS_HUMAN_PERSIST_FAILED');
    assert.ok(failed);
  });
});

/**
 * Tests for decide(action, mode) — the §80 four-tier grading matrix.
 * Run: node --test dist/tests/decide.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_RISKS,
  decide,
  isProdDeploy,
  resolveRisk,
} from '../src/index';

const FIXED_NOW = 1728374400000;
const now = () => FIXED_NOW;

describe('resolveRisk', () => {
  it('maps run-tests to low and deploy-prod to critical', () => {
    assert.equal(resolveRisk('run-tests'), 'low');
    assert.equal(resolveRisk('deploy-prod'), 'critical');
  });

  it('honours an explicit risk override on the action object', () => {
    assert.equal(resolveRisk({ kind: 'run-tests', risk: 'high' }), 'high');
  });

  it('defaults unknown actions to medium (fail-safe)', () => {
    assert.equal(resolveRisk('some-new-action'), 'medium');
  });

  it('isProdDeploy detects prod deploy actions', () => {
    assert.equal(isProdDeploy('deploy-prod'), true);
    assert.equal(isProdDeploy('deploy-staging'), false);
    assert.equal(isProdDeploy('run-tests'), false);
  });

  it('ACTION_RISKS covers low/medium/high/critical', () => {
    const risks = new Set(Object.values(ACTION_RISKS));
    assert.deepEqual([...risks].sort(), ['critical', 'high', 'low', 'medium']);
  });
});

describe('decide — assisted', () => {
  it('low risk runs automatically', () => {
    const d = decide('run-tests', 'assisted', { now });
    assert.equal(d.outcome, 'auto');
    assert.equal(d.risk, 'low');
    assert.equal(d.decidedAt, FIXED_NOW);
  });

  it('medium risk needs human confirmation', () => {
    const d = decide('deploy-staging', 'assisted', { now });
    assert.equal(d.outcome, 'human');
    assert.equal(d.step, 'confirm');
  });

  it('high and critical risk need human approval', () => {
    assert.equal(decide('run-migrations-prod', 'assisted', { now }).outcome, 'human');
    assert.equal(decide('deploy-prod', 'assisted', { now }).outcome, 'human');
    assert.equal(decide('deploy-prod', 'assisted', { now }).step, 'approve');
  });
});

describe('decide — semi', () => {
  it('routine engineering (low/medium) is auto', () => {
    assert.equal(decide('run-tests', 'semi', { now }).outcome, 'auto');
    assert.equal(decide('deploy-staging', 'semi', { now }).outcome, 'auto');
  });

  it('high+ (deployments) need human approval', () => {
    const d = decide('run-migrations-prod', 'semi', { now });
    assert.equal(d.outcome, 'human');
    assert.equal(d.step, 'approve');
    assert.equal(decide('deploy-prod', 'semi', { now }).outcome, 'human');
  });
});

describe('decide — autonomous', () => {
  it('low/medium are auto', () => {
    assert.equal(decide('run-tests', 'autonomous', { now }).outcome, 'auto');
    assert.equal(decide('deploy-staging', 'autonomous', { now }).outcome, 'auto');
  });

  it('high goes through AI review', () => {
    const d = decide('run-migrations-prod', 'autonomous', { now });
    assert.equal(d.outcome, 'ai-review');
    assert.equal(d.step, 'review');
  });

  it('critical is denied by default policy (reserved for full)', () => {
    const d = decide('deploy-prod', 'autonomous', { now });
    assert.equal(d.outcome, 'denied');
    assert.equal(d.step, 'blocked');
  });

  it('a permissive policy can allow critical in autonomous', () => {
    const d = decide('deploy-prod', 'autonomous', {
      now,
      policy: () => true,
    });
    assert.equal(d.outcome, 'auto');
  });

  it('policy may route critical to AI review', () => {
    const d = decide('deploy-prod', 'autonomous', {
      now,
      policy: () => 'ai-review',
    });
    assert.equal(d.outcome, 'ai-review');
  });
});

describe('decide — full', () => {
  it('everything is auto, including production deploys', () => {
    for (const action of ['run-tests', 'deploy-staging', 'run-migrations-prod', 'deploy-prod']) {
      const d = decide(action, 'full', { now });
      assert.equal(d.outcome, 'auto', `${action} should be auto in full mode`);
    }
  });

  it('production deploys still flag mandatory independent verification (§41)', () => {
    const d = decide('deploy-prod', 'full', { now });
    assert.equal(d.requiresProdVerification, true);
    assert.ok(d.reason.includes('verification'));
  });

  it('non-deploy actions do not require prod verification', () => {
    assert.equal(decide('run-tests', 'full', { now }).requiresProdVerification, false);
  });

  it('an explicit policy block still denies in full mode', () => {
    const d = decide('drop-database', 'full', { now, policy: () => false });
    assert.equal(d.outcome, 'denied');
  });

  it('unknown mode fails closed to human', () => {
    const d = decide('run-tests', 'bogus' as never, { now });
    assert.equal(d.outcome, 'human');
  });
});

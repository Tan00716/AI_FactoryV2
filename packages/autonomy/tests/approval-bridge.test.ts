/**
 * Tests for requireApproval — the loose bridge to @ai-factory/approvals.
 * Run: node --test dist/tests/approval-bridge.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { approvalTypeToLevel, requireApproval } from '../src/index';

const now = () => 1728374400000;

describe('requireApproval', () => {
  it('auto actions need no approval (type auto)', () => {
    const r = requireApproval('run-tests', 'semi', { now });
    assert.equal(r.required, false);
    assert.equal(r.approvalType, 'auto');
    assert.equal(r.decision.outcome, 'auto');
  });

  it('human-gated actions require human approval', () => {
    const r = requireApproval('deploy-prod', 'semi', { now });
    assert.equal(r.required, true);
    assert.equal(r.approvalType, 'human');
  });

  it('assisted medium+ requires human', () => {
    assert.equal(requireApproval('deploy-staging', 'assisted', { now }).approvalType, 'human');
    assert.equal(requireApproval('deploy-prod', 'assisted', { now }).required, true);
  });

  it('autonomous high-risk routes to ai-review', () => {
    const r = requireApproval('run-migrations-prod', 'autonomous', { now });
    assert.equal(r.required, true);
    assert.equal(r.approvalType, 'ai-review');
  });

  it('denied actions require a human override', () => {
    const r = requireApproval('deploy-prod', 'autonomous', { now });
    assert.equal(r.required, true);
    assert.equal(r.approvalType, 'human');
    assert.equal(r.decision.outcome, 'denied');
  });

  it('full mode needs no approval for prod deploy (verification is separate)', () => {
    const r = requireApproval('deploy-prod', 'full', { now });
    assert.equal(r.required, false);
    assert.equal(r.approvalType, 'auto');
    assert.equal(r.decision.requiresProdVerification, true);
  });

  it('approvalTypeToLevel maps to the approvals package vocabulary', () => {
    assert.equal(approvalTypeToLevel('human'), 'HUMAN_APPROVAL');
    assert.equal(approvalTypeToLevel('ai-review'), 'AI_REVIEW');
    assert.equal(approvalTypeToLevel('auto'), 'AUTO');
  });
});

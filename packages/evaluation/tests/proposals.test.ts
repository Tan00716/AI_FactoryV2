/**
 * Tests for the §58 improvement-proposal governance state machine:
 * PROPOSED → APPROVED → APPLIED. Unapproved proposals can never APPLY,
 * and critical org-rule changes can never be silently modified.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProposalBoard, ProposalTransitionError, LockedDomainError } from '../src/index';

function board(now = 1_000): ProposalBoard {
  return new ProposalBoard({ now: () => now });
}

describe('ProposalBoard lifecycle', () => {
  it('runs PROPOSED → APPROVED → APPLIED and records the audit trail', () => {
    const b = board();
    const p = b.propose({
      kind: 'skill-improvement',
      title: 'Retry DB writes with backoff',
      description: 'Add a retry policy to the SQL skill.',
      proposedBy: 'backend-01',
      lessonIds: ['lesson_1'],
    });
    assert.equal(p.status, 'PROPOSED');
    assert.equal(p.proposalId.startsWith('prop_'), true);
    assert.deepEqual(p.lessonIds, ['lesson_1']);

    const approved = b.approve(p.proposalId, 'human:cto');
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.decidedBy, 'human:cto');
    assert.equal(approved.decidedAt, 1_000);

    const applied = b.apply(p.proposalId);
    assert.equal(applied.status, 'APPLIED');
    assert.equal(applied.appliedAt, 1_000);
    assert.equal(b.pending().length, 0);
  });

  it('refuses to APPLY a proposal that was never approved', () => {
    const b = board();
    const p = b.propose({
      kind: 'skill-improvement',
      title: 'Silent rule change',
      description: 'No approval anywhere.',
      proposedBy: 'backend-01',
    });
    assert.throws(() => b.apply(p.proposalId), ProposalTransitionError);
    assert.equal(b.get(p.proposalId)!.status, 'PROPOSED');
  });

  it('marks org-rule proposals as critical and blocks agent approval', () => {
    const b = board();
    const p = b.propose({
      kind: 'org-rule',
      title: 'Auto-merge all PRs',
      description: 'Remove the review gate.',
      proposedBy: 'agent-x',
    });
    assert.equal(p.criticalOrgRule, true);
    assert.throws(
      () => b.approve(p.proposalId, 'agent-x'),
      ProposalTransitionError,
    );
    // explicit human/governance approval is the only way forward
    b.approve(p.proposalId, 'human:cto');
    b.apply(p.proposalId);
    assert.equal(b.get(p.proposalId)!.status, 'APPLIED');
  });

  it('rejects policy auto-approve for critical org-rule proposals', () => {
    const b = new ProposalBoard({
      now: () => 1_000,
      autoApprove: () => true,
    });
    assert.throws(
      () =>
        b.propose({
          kind: 'org-rule',
          title: 'Silent governance change',
          description: 'Tried to slip through policy.',
          criticalOrgRule: true,
          proposedBy: 'agent-x',
        }),
      ProposalTransitionError,
    );
  });

  it('auto-approves non-critical proposals through policy, still requiring apply', () => {
    const b = new ProposalBoard({
      now: () => 1_000,
      autoApprove: () => true,
    });
    const p = b.propose({
      kind: 'skill-improvement',
      title: 'Cache lint results',
      description: 'Skip unchanged files.',
      proposedBy: 'agent-x',
    });
    // Policy approval is recorded — it never jumps straight to APPLIED.
    assert.equal(p.status, 'APPROVED');
    assert.equal(p.decidedBy, 'policy:auto-approve');
    const applied = b.apply(p.proposalId);
    assert.equal(applied.status, 'APPLIED');
  });

  it('allows rejecting a proposal, and rejected proposals stay terminal', () => {
    const b = board();
    const p = b.propose({
      kind: 'process',
      title: 'Skip all tests',
      description: 'Ship faster.',
      proposedBy: 'agent-x',
    });
    b.reject(p.proposalId, 'human:cto', 'tests are mandatory');
    assert.equal(b.get(p.proposalId)!.status, 'REJECTED');
    assert.throws(() => b.apply(p.proposalId), ProposalTransitionError);
    assert.throws(() => b.approve(p.proposalId, 'human:cto'), ProposalTransitionError);
  });

  it('treats APPLIED as terminal', () => {
    const b = board();
    const p = b.propose({
      kind: 'skill-improvement',
      title: 'Tidy logs',
      description: 'Rotate logs.',
      proposedBy: 'agent-x',
    });
    b.approve(p.proposalId, 'human:cto');
    b.apply(p.proposalId);
    assert.throws(() => b.reject(p.proposalId, 'human:cto'), ProposalTransitionError);
    assert.throws(() => b.approve(p.proposalId, 'human:cto'), ProposalTransitionError);
  });

  it('rejects double approval', () => {
    const b = board();
    const p = b.propose({
      kind: 'skill-improvement',
      title: 'Once',
      description: 'Approve me once.',
      proposedBy: 'agent-x',
    });
    b.approve(p.proposalId, 'human:cto');
    assert.throws(() => b.approve(p.proposalId, 'human:cto'), ProposalTransitionError);
  });

  it('throws for unknown proposal ids', () => {
    const b = board();
    assert.throws(() => b.approve('prop_nope', 'human:cto'), /Unknown proposal/);
  });

  it('pending() lists only unapproved proposals', () => {
    const b = board();
    const a = b.propose({
      kind: 'skill-improvement', title: 'A', description: 'a', proposedBy: 'x',
    });
    const c = b.propose({
      kind: 'skill-improvement', title: 'C', description: 'c', proposedBy: 'x',
    });
    b.approve(a.proposalId, 'human:cto');
    assert.deepEqual(b.pending().map((p) => p.proposalId), [c.proposalId]);
  });
});

describe('locked domains — rejected at creation [§45.2]', () => {
  it('rejects a proposal that targets lock-rules via targetDomains', () => {
    const b = board();
    assert.throws(
      () =>
        b.propose({
          kind: 'org-rule',
          title: 'Simplify execution',
          description: 'Speed up the loop.',
          proposedBy: 'human:cto',
          targetDomains: ['lock-rules'],
        }),
      (err: unknown) => {
        assert.ok(err instanceof LockedDomainError);
        assert.equal(err.code, 'LOCKED_DOMAIN');
        assert.equal(err.domain, 'lock-rules');
        return true;
      },
    );
  });

  it('rejects locked proposals regardless of approver — even human:cto cannot file one', () => {
    const b = board();
    const before = b.pending().length;
    assert.throws(
      () =>
        b.propose({
          kind: 'process',
          title: 'Remove human authority from deploys',
          description: 'Agents should deploy without asking.',
          proposedBy: 'human:cto',
        }),
      (err: unknown) => err instanceof LockedDomainError && err.code === 'LOCKED_DOMAIN',
    );
    // Rejected at creation: nothing was stored, nothing to approve.
    assert.equal(b.pending().length, before);
  });

  it('detects each locked domain: human authority, permission ceiling, AC, gate standards', () => {
    const b = board();
    const cases: Array<[string, string, string]> = [
      ['human-authority', 'Grant agents prod admin', 'Bypass human authority for speed.'],
      ['permission-ceiling', 'Raise the caps', 'Lift the permission ceiling on tool access.'],
      ['access-control', 'Loosen AC', 'Relax the access control on the model registry.'],
      ['gate-standards', 'Weaken gates', 'Lower the gate standards for canary promotion.'],
    ];
    for (const [domain, title, description] of cases) {
      assert.throws(
        () => b.propose({ kind: 'org-rule', title, description, proposedBy: 'agent-x' }),
        (err: unknown) =>
          err instanceof LockedDomainError && err.domain === domain && err.code === 'LOCKED_DOMAIN',
        `expected LOCKED_DOMAIN for ${domain}`,
      );
    }
  });

  it('a benign proposal with similar-sounding words still passes', () => {
    const b = board();
    const p = b.propose({
      kind: 'skill-improvement',
      title: 'Cache lint results',
      description: 'Skip unchanged files; keep the review gate intact.',
      proposedBy: 'agent-x',
    });
    assert.equal(p.status, 'PROPOSED');
  });
});

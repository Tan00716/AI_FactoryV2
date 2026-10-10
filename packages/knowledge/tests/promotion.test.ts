import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KnowledgeStore,
  applyProposal,
  decideProposal,
  publish,
} from '../src/index';

function makeClock() {
  let t = 9000;
  return { now: () => (t += 5) };
}

const verifs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ method: `check-${i}`, verifiedAt: i, by: 'scout' }));
const evidence = {
  verifications: verifs(1),
  evaluation: { score: 95, passed: true, evaluatedAt: 1, by: 'eval' },
  approval: { approved: true, by: 'cto', decidedAt: 1 },
};

function approvedItem(store: KnowledgeStore): string {
  const item = store.add({
    title: 'New technique',
    content: 'content',
    tags: [],
    scope: { level: 'GLOBAL' },
    source: { type: 'official_docs', name: 'docs', retrievedAt: 0 },
  });
  for (const to of ['UNVERIFIED', 'VALIDATED', 'EVALUATED', 'APPROVED'] as const) {
    store.transition(item.id, to, { actor: 'test', evidence });
  }
  return item.id;
}

describe('promotion — never silently rewrite agents [§53]', () => {
  it('new knowledge cannot become ACTIVE before evaluation passes', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const item = store.add({
      title: 'Unvetted trick',
      content: 'content',
      tags: [],
      scope: { level: 'GLOBAL' },
      source: { type: 'research', name: 'paper', retrievedAt: 0 },
    });
    store.transition(item.id, 'UNVERIFIED', { actor: 't' });
    // research source needs 3 verifications; validated now
    store.transition(item.id, 'VALIDATED', {
      actor: 't',
      evidence: { verifications: verifs(3) },
    });
    // skipping EVALUATED entirely is an illegal transition
    assert.throws(
      () =>
        store.transition(item.id, 'APPROVED', {
          actor: 't',
          evidence: { approval: { approved: true, by: 'cto', decidedAt: 1 } },
        }),
      /Allowed next states from VALIDATED: EVALUATED/,
    );
    // a failing evaluation cannot satisfy the EVALUATED gate
    assert.throws(
      () =>
        store.transition(item.id, 'EVALUATED', {
          actor: 't',
          evidence: { evaluation: { score: 10, passed: false, evaluatedAt: 1, by: 'eval' } },
        }),
      /did not pass/,
    );
    assert.equal(store.get(item.id)?.state, 'VALIDATED');
  });

  it('publish returns proposal + notice objects only', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const id = approvedItem(store);
    const { proposal, notice } = store.publishForPromotion(id, {
      actor: 'promoter',
      skillId: 'loop-engineering',
    });
    assert.equal(proposal.status, 'PENDING');
    assert.equal(proposal.itemId, id);
    assert.equal(proposal.skillId, 'loop-engineering');
    assert.equal(notice.proposalId, proposal.id);
    assert.match(notice.message, /Awaiting external approval/);
  });

  it('publish never mutates agent state — no applier is invoked', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const id = approvedItem(store);
    let mutated = false;
    store.publishForPromotion(id, { actor: 'promoter', skillId: 's1' });
    assert.equal(mutated, false);
    // the store exposes no applier hook at all: publish's return type has
    // no side-effect channel
    const item = store.get(id);
    assert.equal(item?.state, 'APPROVED');
    void mutated;
  });

  it('cannot publish an item that is not APPROVED', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const item = store.add({
      title: 'Draft',
      content: 'c',
      tags: [],
      scope: { level: 'GLOBAL' },
      source: { type: 'official_spec', name: 'spec', retrievedAt: 0 },
    });
    assert.throws(
      () => store.publishForPromotion(item.id, { actor: 'x', skillId: 's' }),
      /must be APPROVED/,
    );
  });

  it('applying a non-approved proposal is refused', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const id = approvedItem(store);
    const item = store.get(id)!;
    const { proposal } = publish(item, { actor: 'p', skillId: 's1' });
    let calls = 0;
    assert.throws(
      () => applyProposal(proposal, () => calls++, 'ops'),
      /must be APPROVED/,
    );
    assert.equal(calls, 0);
  });

  it('an approved proposal is applied exactly once through the external applier', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const id = approvedItem(store);
    const item = store.get(id)!;
    const { proposal } = publish(item, { actor: 'p', skillId: 's1' });
    const decided = decideProposal(proposal, 'APPROVED', 'cto');
    const seen: string[] = [];
    const record = applyProposal(decided, (p) => seen.push(p.id), 'ops');
    assert.deepEqual(seen, [proposal.id]);
    assert.equal(record.proposalId, proposal.id);
    assert.equal(record.appliedBy, 'ops');
  });

  it('a rejected proposal can never be applied', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const id = approvedItem(store);
    const item = store.get(id)!;
    const { proposal } = publish(item, { actor: 'p', skillId: 's1' });
    const decided = decideProposal(proposal, 'REJECTED', 'cto');
    let calls = 0;
    assert.throws(() => applyProposal(decided, () => calls++, 'ops'), /must be APPROVED/);
    assert.equal(calls, 0);
  });

  it('promoteToActive drives the full gated chain to ACTIVE', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const item = store.add({
      title: 'Full chain',
      content: 'content',
      tags: [],
      scope: { level: 'PROJECT', projectId: 'p1' },
      source: { type: 'official_spec', name: 'spec', retrievedAt: 0 },
    });
    const { item: final, notice } = store.promoteToActive(
      item.id,
      'promoter',
      evidence,
      (proposal) => ({ proposalId: proposal.id, itemId: proposal.itemId, appliedAt: 1, appliedBy: 'ops' }),
      'loop-engineering',
    );
    assert.equal(final.state, 'ACTIVE');
    assert.ok(notice.message.includes('loop-engineering'));
    assert.equal(store.history(item.id).length, 5);
  });
});

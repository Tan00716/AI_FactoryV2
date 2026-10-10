import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KnowledgeStore,
  LifecycleError,
  type KnowledgeItem,
} from '../src/index';

function makeClock() {
  let t = 5000;
  return { now: () => (t += 10) };
}

function add(store: KnowledgeStore, source: 'official_spec' | 'community' = 'official_spec'): KnowledgeItem {
  return store.add({
    title: 'New technique',
    content: 'a brand-new prompting pattern',
    tags: ['prompting'],
    scope: { level: 'GLOBAL' },
    source: { type: source, name: 'src', retrievedAt: 0 },
  });
}

const verifs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ method: `check-${i}`, verifiedAt: i, by: 'scout' }));
const goodEval = { score: 90, passed: true, evaluatedAt: 1, by: 'eval' };
const approval = { approved: true, by: 'cto', decidedAt: 1 };

describe('lifecycle — gated state machine [§53]', () => {
  it('DISCOVERED → UNVERIFIED succeeds and records timestamp + actor', () => {
    const clock = makeClock();
    const store = new KnowledgeStore({ clock });
    const item = add(store);
    const { item: next, transition } = store.transition(item.id, 'UNVERIFIED', { actor: 'scout-1' });
    assert.equal(next.state, 'UNVERIFIED');
    assert.equal(transition.from, 'DISCOVERED');
    assert.equal(transition.to, 'UNVERIFIED');
    assert.equal(transition.actor, 'scout-1');
    assert.ok(transition.at > 0);
    assert.equal(store.history(item.id).length, 1);
  });

  it('illegal jump DISCOVERED → ACTIVE is rejected with an explanation', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const item = add(store);
    assert.throws(
      () => store.transition(item.id, 'ACTIVE', { actor: 'rogue' }),
      (err: unknown) => {
        assert.ok(err instanceof LifecycleError);
        assert.match(err.message, /DISCOVERED → ACTIVE/);
        assert.match(err.message, /Allowed next states.*UNVERIFIED/);
        return true;
      },
    );
    assert.equal(store.get(item.id)?.state, 'DISCOVERED');
  });

  it('UNVERIFIED → VALIDATED requires enough verifications for the source', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const item = add(store, 'community'); // threshold 4
    store.transition(item.id, 'UNVERIFIED', { actor: 'scout' });
    assert.throws(
      () => store.transition(item.id, 'VALIDATED', { actor: 'scout', evidence: { verifications: verifs(2) } }),
      /requires 4 independent verification\(s\)/,
    );
    const { item: next } = store.transition(item.id, 'VALIDATED', {
      actor: 'scout',
      evidence: { verifications: verifs(4) },
    });
    assert.equal(next.state, 'VALIDATED');
  });

  it('a high-credibility source has a lower verification bar', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const item = add(store, 'official_spec'); // threshold 1
    store.transition(item.id, 'UNVERIFIED', { actor: 'scout' });
    const { item: next } = store.transition(item.id, 'VALIDATED', {
      actor: 'scout',
      evidence: { verifications: verifs(1) },
    });
    assert.equal(next.state, 'VALIDATED');
  });

  it('VALIDATED → EVALUATED requires a passing evaluation', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const item = add(store);
    store.transition(item.id, 'UNVERIFIED', { actor: 's' });
    store.transition(item.id, 'VALIDATED', { actor: 's', evidence: { verifications: verifs(1) } });
    assert.throws(
      () => store.transition(item.id, 'EVALUATED', { actor: 's' }),
      /must pass evaluation/,
    );
    assert.throws(
      () =>
        store.transition(item.id, 'EVALUATED', {
          actor: 's',
          evidence: { evaluation: { score: 30, passed: false, evaluatedAt: 1, by: 'eval' } },
        }),
      /did not pass/,
    );
    const { item: next } = store.transition(item.id, 'EVALUATED', {
      actor: 's',
      evidence: { evaluation: goodEval },
    });
    assert.equal(next.state, 'EVALUATED');
  });

  it('EVALUATED → APPROVED requires an explicit approval decision', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const item = add(store);
    store.transition(item.id, 'UNVERIFIED', { actor: 's' });
    store.transition(item.id, 'VALIDATED', { actor: 's', evidence: { verifications: verifs(1) } });
    store.transition(item.id, 'EVALUATED', { actor: 's', evidence: { evaluation: goodEval } });
    assert.throws(
      () => store.transition(item.id, 'APPROVED', { actor: 's' }),
      /explicit approval/,
    );
    const { item: next } = store.transition(item.id, 'APPROVED', { actor: 's', evidence: { approval } });
    assert.equal(next.state, 'APPROVED');
  });

  it('APPROVED → ACTIVE requires an applied, externally approved proposal', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const item = add(store);
    for (const [to, evidence] of [
      ['UNVERIFIED', {}],
      ['VALIDATED', { verifications: verifs(1) }],
      ['EVALUATED', { evaluation: goodEval }],
      ['APPROVED', { approval }],
    ] as const) {
      store.transition(item.id, to, { actor: 's', evidence });
    }
    assert.throws(
      () => store.transition(item.id, 'ACTIVE', { actor: 's' }),
      /externally approved/,
    );
    const { item: next } = store.transition(item.id, 'ACTIVE', {
      actor: 's',
      evidence: { appliedProposalId: 'prop_123' },
      note: 'published via approved proposal',
    });
    assert.equal(next.state, 'ACTIVE');
  });

  it('ACTIVE → DEPRECATED → RETIRED works; DEPRECATED → ACTIVE is rejected', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const item = add(store);
    for (const [to, evidence] of [
      ['UNVERIFIED', {}],
      ['VALIDATED', { verifications: verifs(1) }],
      ['EVALUATED', { evaluation: goodEval }],
      ['APPROVED', { approval }],
      ['ACTIVE', { appliedProposalId: 'p' }],
    ] as const) {
      store.transition(item.id, to, { actor: 's', evidence });
    }
    store.transition(item.id, 'DEPRECATED', { actor: 'maintainer', note: 'superseded' });
    assert.throws(() => store.transition(item.id, 'ACTIVE', { actor: 'rogue' }), LifecycleError);
    const { item: retired } = store.transition(item.id, 'RETIRED', { actor: 'maintainer' });
    assert.equal(retired.state, 'RETIRED');
    assert.throws(() => store.transition(item.id, 'DEPRECATED', { actor: 'rogue' }), LifecycleError);
  });

  it('history records every transition in order with actor and timestamp', () => {
    const clock = makeClock();
    const store = new KnowledgeStore({ clock });
    const item = add(store);
    store.transition(item.id, 'UNVERIFIED', { actor: 'scout' });
    store.transition(item.id, 'VALIDATED', { actor: 'verifier', evidence: { verifications: verifs(1) } });
    const history = store.history(item.id);
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((h) => h.to), ['UNVERIFIED', 'VALIDATED']);
    assert.deepEqual(history.map((h) => h.actor), ['scout', 'verifier']);
    assert.ok(history[1].at > history[0].at);
  });
});

/**
 * @ai-factory/knowledge demo — v2 hardened pipeline (spec §44):
 *   1. source rating (rankSource) + community doubled verification
 *   2. scout: collect → normalize → compare → verify → evaluate → proposal
 *      — produces proposal CANDIDATES only; live objects stay byte-identical
 *   3. lifecycle gates → ACTIVE (external proposal/approval/applier)
 *   4. distribution license gate for external scripts
 *   5. Update Feed: Activate/Defer/Reject + source-unavailable marking
 *
 * Run: node packages/knowledge/dist/demo/knowledge.demo.js
 */
import {
  KnowledgeScout,
  KnowledgeStore,
  applyProposal,
  assertDistributable,
  rankSource,
  recordFeedDecision,
  markSourceUnavailable,
  sampleFeedCards,
  verificationThreshold,
  type LifecycleState,
  type TransitionEvidence,
} from '../src/index';

let t = 1_700_000_000_000;
const clock = { now: () => (t += 1000) };

async function main(): Promise<void> {
  const store = new KnowledgeStore({ clock });
  const scout = new KnowledgeScout({ clock });

  console.log('== 1. Source rating (§44) ==');
  for (const type of ['official_spec', 'official_docs', 'official_release', 'primary_article', 'research', 'community'] as const) {
    console.log(`   ${type}: score=${rankSource(type)} verify-threshold=${verificationThreshold(type)}`);
  }
  console.log('   → community sources need DOUBLED verification (8).');

  console.log('\n== 2. Scout: candidates only, never live-object mutation ==');
  const liveEmployee = { id: 'emp-1', skills: ['debugging'], state: 'running' };
  const before = JSON.stringify(liveEmployee);
  const { artifact, records, budget } = await scout.run(
    {
      title: 'Loop engineering: retry with backoff',
      rawContent:
        'When an agent loop step fails transiently, retry with exponential backoff and jitter, ' +
        'capped at five attempts, then escalate to a human operator. Backoff starts at 200ms and ' +
        'doubles per attempt; jitter prevents thundering-herd retries across parallel workers. ' +
        'Permanent failures (4xx-class, validation errors) must never be retried.',
      topic: 'Loop Engineering',
      tags: ['loop', 'retry'],
      source: { type: 'official_docs' as const, name: 'vendor agent guide', retrievedAt: clock.now() },
      scope: { level: 'GLOBAL' as const },
      verifications: [{ method: 'doc-read', verifiedAt: clock.now(), by: 'scout' }],
    },
    {
      store,
      budget: { total: 10 },
      hooks: {
        onStageStart: (s) => process.stdout.write(`   … ${s}`),
        onStageComplete: () => process.stdout.write(' ✓\n'),
      },
    },
  );
  console.log(`   stages: ${records.map((r) => `${r.stage}:${r.status}`).join(' → ')}`);
  console.log(`   budget: total=${budget.total} spent=${budget.spent} exhausted=${budget.exhausted}`);
  console.log(`   proposal candidate: ${artifact.proposal!.id} [${artifact.proposal!.status}]`);
  console.log(`   live employee byte-identical: ${JSON.stringify(liveEmployee) === before}`);

  console.log('\n== 3. Lifecycle → ACTIVE (gated; proposal → approval → external applier) ==');
  const p = artifact.proposal!;
  const item = store.add({
    title: p.title,
    content: p.content,
    tags: p.tags,
    scope: p.scope,
    source: p.source,
  });
  const actor = 'demo-operator';
  const step = (to: LifecycleState, evidence: TransitionEvidence, note?: string) => {
    const { transition } = store.transition(item.id, to, { actor, evidence, note });
    console.log(`   ${transition.from} → ${transition.to}  (actor=${transition.actor})`);
  };
  step('UNVERIFIED', {}, 'scout intake');
  step('VALIDATED', { verifications: [{ method: 'doc-read', verifiedAt: clock.now(), by: 'demo' }] }, 'meets source threshold (1)');
  step('EVALUATED', { evaluation: { score: artifact.evaluation!.score, passed: true, evaluatedAt: clock.now(), by: 'eval-service' } }, 'score ≥ 60');
  step('APPROVED', { approval: { approved: true, by: 'cto', decidedAt: clock.now() } }, 'external approval');
  const { proposal, notice } = store.publishForPromotion(item.id, { actor, skillId: 'loop-engineering' });
  console.log(`   published: proposal ${proposal.id} [${proposal.status}] — "${notice.message}"`);
  const decided = store.decideProposal(proposal, 'APPROVED', 'cto');
  const applied = applyProposal(
    decided,
    (ap) => console.log(`   [external] skill registry applied proposal ${ap.id} → skill ${ap.skillId}`),
    'ops',
  );
  step('ACTIVE', { appliedProposalId: applied.proposalId }, 'published via approved proposal');

  console.log('\n== 4. Distribution license gate ==');
  const script = store.add({
    title: 'External retry helper',
    content: '…',
    tags: ['external_script'],
    scope: { level: 'GLOBAL' },
    source: { type: 'primary_article', name: 'blog', retrievedAt: clock.now() },
  });
  try {
    assertDistributable(script);
    console.log('   ERROR: should have been refused');
  } catch (e) {
    console.log(`   refused (no license): ${(e as Error).name} — ${(e as Error).message.split(' — ')[0]}`);
  }

  console.log('\n== 5. Update Feed: Activate/Defer/Reject ==');
  const cards = sampleFeedCards();
  const decided1 = recordFeedDecision(cards[0], 'Activate', { by: 'human:cto', now: clock.now });
  const decided2 = recordFeedDecision(cards[1], 'Defer', { by: 'human:cto', now: clock.now });
  console.log(`   "${decided1.title}" → ${decided1.action} by ${decided1.actionBy}`);
  console.log(`   "${decided2.title}" → ${decided2.action} by ${decided2.actionBy}`);
  const unavailable = markSourceUnavailable(cards[2]);
  console.log(`   "${unavailable.title}" sourceAvailable=${unavailable.sourceAvailable} ` +
    `(verified date kept: ${unavailable.lastVerifiedAt})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

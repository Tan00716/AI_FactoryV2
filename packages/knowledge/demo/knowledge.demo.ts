/**
 * @ai-factory/knowledge demo — full pipeline:
 *   1. ingest a candidate knowledge item
 *   2. run the scout through all nine stages
 *   3. drive the lifecycle to ACTIVE through the gated chain
 *   4. hierarchical query with scope fallback
 *
 * Run: node packages/knowledge/dist/demo/knowledge.demo.js
 */
import {
  KnowledgeScout,
  KnowledgeStore,
  applyProposal,
  type LifecycleState,
  type TransitionEvidence,
} from '../src/index';

let t = 1_700_000_000_000;
const clock = { now: () => (t += 1000) };

async function main(): Promise<void> {
  const store = new KnowledgeStore({ clock });
  const scout = new KnowledgeScout({ clock });

  // Seed a project-scoped item so the query demo shows fallback levels.
  const seeded = store.add({
    title: 'Project deploy checklist',
    content: 'Always deploy to staging first; production requires two approvals.',
    tags: ['deploy'],
    scope: { level: 'PROJECT', organizationId: 'acme', projectId: 'ai-factory' },
    source: { type: 'official_docs', name: 'acme runbook', retrievedAt: clock.now() },
    initialState: 'UNVERIFIED',
  });
  store.transition(seeded.id, 'VALIDATED', {
    actor: 'demo',
    evidence: { verifications: [{ method: 'runbook-read', verifiedAt: clock.now(), by: 'demo' }] },
  });

  console.log('== 1. Ingest candidate knowledge ==');
  const candidate = {
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
  };
  console.log(`   candidate: "${candidate.title}" (source: ${candidate.source.type})`);

  console.log('\n== 2. Scout pipeline ==');
  const { artifact, records } = await scout.run(candidate, {
    store,
    hooks: {
      onStageStart: (s) => process.stdout.write(`   … ${s}`),
      onStageComplete: () => process.stdout.write(' ✓\n'),
    },
  });
  console.log(`   stages: ${records.map((r) => `${r.stage}:${r.status}`).join(' → ')}`);
  console.log(`   stored item: ${artifact.storedItem!.id} [${artifact.storedItem!.state}]`);
  console.log(`   evaluation score: ${artifact.evaluation!.score} (passed=${artifact.evaluation!.passed})`);

  console.log('\n== 3. Lifecycle → ACTIVE (gated) ==');
  const id = artifact.storedItem!.id;
  const actor = 'demo-operator';
  const step = (to: LifecycleState, evidence: TransitionEvidence, note?: string) => {
    const { item, transition } = store.transition(id, to, { actor, evidence, note });
    console.log(`   ${transition.from} → ${transition.to}  (actor=${transition.actor})`);
    return item;
  };
  step('UNVERIFIED', {}, 'scout intake');
  step('VALIDATED', { verifications: candidate.verifications }, 'meets source threshold (1)');
  const evaluation = artifact.evaluation!;
  step('EVALUATED', { evaluation: { ...evaluation, by: 'eval-service' } }, 'score ≥ 60');

  // Publish produces proposal + notice ONLY — no agent is touched.
  step('APPROVED', { approval: { approved: true, by: 'cto', decidedAt: clock.now() } }, 'external approval');
  const { proposal, notice } = store.publishForPromotion(id, { actor, skillId: 'loop-engineering' });
  console.log(`   published: proposal ${proposal.id} [${proposal.status}]`);
  console.log(`   notice: "${notice.message}"`);

  // External approval + external applier. The package never rewrites agents itself.
  const decided = store.decideProposal(proposal, 'APPROVED', 'cto');
  const applied = applyProposal(
    decided,
    (p) => {
      // This callback lives OUTSIDE the package: the real skill registry write.
      console.log(`   [external] skill registry applied proposal ${p.id} → skill ${p.skillId}`);
    },
    'ops',
  );
  step('ACTIVE', { appliedProposalId: applied.proposalId }, 'published via approved proposal');

  console.log('\n== 4. Hierarchical query (TASK → … → GLOBAL) ==');
  // Activate the seeded project item for the query demo.
  store.transition(seeded.id, 'EVALUATED', {
    actor: 'demo',
    evidence: { evaluation: { score: 80, passed: true, evaluatedAt: clock.now(), by: 'eval' } },
  });
  store.transition(seeded.id, 'APPROVED', {
    actor: 'demo',
    evidence: { approval: { approved: true, by: 'cto', decidedAt: clock.now() } },
  });
  store.transition(seeded.id, 'ACTIVE', {
    actor: 'demo',
    evidence: { appliedProposalId: 'prop_seed' },
  });

  const ctx = { organizationId: 'acme', projectId: 'ai-factory', employeeId: 'emp-7', taskId: 'task-42' };
  const hits = store.query(ctx);
  for (const h of hits) {
    console.log(`   [${h.matchedScope.level}] ${h.item.title} — ${h.item.state}`);
  }
  console.log(`\n${hits.length} hit(s); most specific scope wins, broader scopes fall back.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

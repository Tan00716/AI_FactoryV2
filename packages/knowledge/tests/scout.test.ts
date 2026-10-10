import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KnowledgeScout,
  KnowledgeStore,
  SCOUT_STAGES,
  ScoutError,
  defaultHandlers,
  type ScoutCandidate,
} from '../src/index';

function makeClock() {
  let t = 20000;
  return { now: () => (t += 1) };
}

function candidate(over: Partial<ScoutCandidate> = {}): ScoutCandidate {
  return {
    title: 'Loop engineering: retry with backoff',
    rawContent: 'When an agent loop step fails transiently, retry with exponential backoff and jitter.',
    topic: 'Loop Engineering',
    tags: ['Loop', ' RETRY '],
    source: { type: 'official_docs', name: 'vendor docs', retrievedAt: 0 },
    scope: { level: 'GLOBAL' },
    verifications: [{ method: 'doc-read', verifiedAt: 1, by: 'scout' }],
    ...over,
  };
}

describe('scout — §44 stage pipeline (collect → normalize → compare → verify → evaluate → proposal)', () => {
  it('executes all six stages in spec order and fires hooks per stage', async () => {
    const scout = new KnowledgeScout({ clock: makeClock() });
    const started: string[] = [];
    const completed: string[] = [];
    const { artifact, records, budget } = await scout.run(candidate(), {
      hooks: {
        onStageStart: (s) => started.push(s),
        onStageComplete: (s) => completed.push(s),
      },
    });
    assert.deepEqual(records.map((r) => r.stage), [...SCOUT_STAGES]);
    assert.deepEqual(records.map((r) => r.stage), [
      'collect', 'normalize', 'compare', 'verify', 'evaluate', 'proposal',
    ]);
    assert.deepEqual(started, [...SCOUT_STAGES]);
    assert.deepEqual(completed, [...SCOUT_STAGES]);
    assert.ok(records.every((r) => r.status === 'ok'));
    assert.ok(artifact.proposal, 'pipeline emits a proposal candidate');
    assert.equal(artifact.proposal!.status, 'PROPOSED');
    assert.ok(artifact.proposal!.title.toLowerCase().includes('backoff'));
    assert.deepEqual(budget, { total: 1000, spent: 1, exhausted: false });
  });

  it('verify runs AFTER compare and community sources need doubled verification', async () => {
    const scout = new KnowledgeScout({ clock: makeClock() });
    const order: string[] = [];
    await scout.run(
      candidate({
        source: { type: 'community', name: 'blog', retrievedAt: 0 },
        // 8 verifications = doubled community threshold (§44)
        verifications: Array.from({ length: 8 }, (_, i) => ({
          method: `repro-${i}`, verifiedAt: i, by: 'scout',
        })),
      }),
      { hooks: { onStageStart: (s) => order.push(s) } },
    );
    assert.deepEqual(order, ['collect', 'normalize', 'compare', 'verify', 'evaluate', 'proposal']);
  });

  it('rejects community candidates with fewer than 8 verifications', async () => {
    const scout = new KnowledgeScout({ clock: makeClock() });
    await assert.rejects(
      () =>
        scout.run(
          candidate({
            source: { type: 'community', name: 'blog', retrievedAt: 0 },
            verifications: [{ method: 'x', verifiedAt: 1, by: 's' }],
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof ScoutError);
        assert.equal(err.code, 'SCOUT_STAGE_FAILED');
        assert.equal(err.stage, 'verify');
        return true;
      },
    );
  });

  it('IRULE: running employee/skill/policy objects stay byte-identical — scout only emits candidates', async () => {
    const scout = new KnowledgeScout({ clock: makeClock() });
    // Simulated live objects: frozen running-state snapshots.
    const liveEmployee = Object.freeze({ id: 'emp-1', skills: ['debugging'], state: 'running' });
    const liveSkill = Object.freeze({ id: 'skill-1', version: 'v1.2', config: { retries: 3 } });
    const livePolicy = Object.freeze({ id: 'policy-1', autonomy: 'L2', rules: ['no-prod'] });
    const before = JSON.stringify([liveEmployee, liveSkill, livePolicy]);

    const input = candidate({ tags: ['ref:emp-1', 'ref:skill-1'] });
    const { artifact } = await scout.run(input);

    const after = JSON.stringify([liveEmployee, liveSkill, livePolicy]);
    assert.equal(after, before, 'live objects must be byte-identical after a scout run');
    // The caller's candidate object is not mutated either (scout deep-copies at intake).
    assert.deepEqual(input.tags, ['ref:emp-1', 'ref:skill-1']);
    assert.equal(input.source.type, 'official_docs');
    assert.ok(artifact.proposal);
  });

  it('rogue handlers cannot mutate the candidate in place', async () => {
    const scout = new KnowledgeScout({ clock: makeClock() });
    const input = candidate();
    await scout.run(input, {
      handlers: {
        normalize: (artifact) => {
          // A rogue handler that tries to mutate the candidate in place.
          (artifact.candidate as { title: string }).title = 'MUTATED';
          return defaultHandlers.normalize(artifact, { clock: makeClock() });
        },
      },
    });
    assert.notEqual(input.title, 'MUTATED', 'caller candidate untouched by rogue handler');
  });

  it('independent budget: exhausted budget stops collecting (SCOUT_BUDGET_EXHAUSTED)', async () => {
    const scout = new KnowledgeScout({ clock: makeClock() });
    await assert.rejects(
      () => scout.run(candidate(), { budget: { total: 0 } }),
      (err: unknown) => {
        assert.ok(err instanceof ScoutError);
        assert.equal((err as ScoutError).code, 'SCOUT_BUDGET_EXHAUSTED');
        assert.match((err as Error).message, /budget exhausted/i);
        assert.equal((err as ScoutError).stage, 'collect');
        return true;
      },
    );
  });

  it('independent budget: a collect that would exceed the budget is refused', async () => {
    const scout = new KnowledgeScout({ clock: makeClock() });
    // A 1-unit budget is exhausted by one collect.
    const first = await scout.run(candidate(), { budget: { total: 1 } });
    assert.deepEqual(first.budget, { total: 1, spent: 1, exhausted: true });
    // A collect costing more than the budget is refused up front.
    await assert.rejects(
      () => scout.run(candidate(), { budget: { total: 1, costPerCollect: 2 } }),
      (err: unknown) =>
        err instanceof ScoutError && err.code === 'SCOUT_BUDGET_EXHAUSTED',
    );
  });

  it('retry and skip still work with recorded attempts', async () => {
    const scout = new KnowledgeScout({ clock: makeClock() });
    let calls = 0;
    const { records, artifact } = await scout.run(candidate(), {
      handlers: {
        evaluate: (art, ctx) => {
          calls++;
          if (calls < 3) throw new Error('flaky evaluator');
          return defaultHandlers.evaluate(art, ctx);
        },
      },
      retry: { evaluate: 5 },
    });
    const ev = records.find((r) => r.stage === 'evaluate')!;
    assert.equal(ev.status, 'ok');
    assert.equal(ev.attempts, 3);
    assert.ok(artifact.proposal);
  });

  it('compare detects duplicates read-only (store is read, never written by the scout)', async () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const scout = new KnowledgeScout({ clock: makeClock() });
    const seeded = store.add({
      title: 'Loop engineering: retry with backoff',
      content: 'seeded',
      scope: { level: 'GLOBAL' },
      source: { type: 'official_docs', name: 'x', retrievedAt: 0 },
    });
    const before = store.all().length;
    const { artifact } = await scout.run(candidate(), { store });
    assert.deepEqual(artifact.duplicates, [seeded.id]);
    assert.equal(store.all().length, before, 'scout writes nothing to the store');
    assert.equal(artifact.proposal!.kind, 'knowledge_intake');
    assert.deepEqual(artifact.proposal!.duplicateOf, [seeded.id]);
  });

  it('hooks fire onStageError for failed stages', async () => {
    const scout = new KnowledgeScout({ clock: makeClock() });
    const errors: string[] = [];
    await assert.rejects(
      () =>
        scout.run(candidate(), {
          hooks: { onStageError: (s, e, attempt) => errors.push(`${s}:${attempt}:${e.message}`) },
          handlers: { verify: () => { throw new Error('nope'); } },
        }),
      ScoutError,
    );
    assert.ok(errors.length >= 1);
    assert.match(errors[0], /^verify:1:nope/);
  });
});

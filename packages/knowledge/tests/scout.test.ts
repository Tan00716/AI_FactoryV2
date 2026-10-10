import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KnowledgeScout,
  KnowledgeStore,
  SCOUT_STAGES,
  ScoutError,
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

describe('scout — stage state machine [§52]', () => {
  it('executes all nine stages in spec order and fires hooks per stage', () => {
    return (async () => {
      const clock = makeClock();
      const store = new KnowledgeStore({ clock });
      const scout = new KnowledgeScout({ clock });
      const started: string[] = [];
      const completed: string[] = [];
      const { artifact, records } = await scout.run(candidate(), {
        store,
        hooks: {
          onStageStart: (s) => started.push(s),
          onStageComplete: (s) => completed.push(s),
        },
      });
      assert.deepEqual(records.map((r) => r.stage), [...SCOUT_STAGES]);
      assert.deepEqual(started, [...SCOUT_STAGES]);
      assert.deepEqual(completed, [...SCOUT_STAGES]);
      assert.ok(records.every((r) => r.status === 'ok' && r.attempts === 1));
      assert.ok(artifact.storedItem);
      assert.equal(artifact.storedItem?.state, 'DISCOVERED');
      assert.deepEqual(artifact.normalized?.tags, ['loop', 'retry']);
      assert.ok(artifact.published);
    })();
  });

  it('a failing stage can be retried and then succeed', () => {
    return (async () => {
      const scout = new KnowledgeScout({ clock: makeClock() });
      let calls = 0;
      const { records } = await scout.run(candidate(), {
        handlers: {
          collect: (artifact) => {
            calls++;
            if (calls === 1) throw new Error('transient fetch failure');
            return artifact;
          },
        },
        retry: { collect: 1 },
      });
      const collect = records.find((r) => r.stage === 'collect')!;
      assert.equal(collect.status, 'ok');
      assert.equal(collect.attempts, 2);
    })();
  });

  it('a failing stage can be skipped, recorded, and the pipeline continues', () => {
    return (async () => {
      const scout = new KnowledgeScout({ clock: makeClock() });
      const store = new KnowledgeStore({ clock: makeClock() });
      const { artifact, records } = await scout.run(candidate(), {
        store,
        handlers: {
          verify: () => {
            throw new Error('verifier offline');
          },
        },
        skip: ['verify'],
      });
      const verify = records.find((r) => r.stage === 'verify')!;
      assert.equal(verify.status, 'skipped');
      assert.match(verify.error ?? '', /verifier offline/);
      assert.equal(records.filter((r) => r.status === 'ok').length, SCOUT_STAGES.length - 1);
      assert.ok(artifact.storedItem, 'later stages still ran');
    })();
  });

  it('an unrecoverable stage failure throws ScoutError with the run records', () => {
    return (async () => {
      const scout = new KnowledgeScout({ clock: makeClock() });
      await assert.rejects(
        () =>
          scout.run(candidate(), {
            handlers: {
              normalize: () => {
                throw new Error('normalizer crashed');
              },
            },
          }),
        (err: unknown) => {
          assert.ok(err instanceof ScoutError);
          assert.equal(err.stage, 'normalize');
          assert.match(err.message, /normalizer crashed/);
          assert.ok(err.records.length >= 3, 'records stages completed so far');
          return true;
        },
      );
    })();
  });

  it('injected handlers override defaults (real verifier plugs in)', () => {
    return (async () => {
      const scout = new KnowledgeScout({ clock: makeClock() });
      const { artifact } = await scout.run(
        candidate({ verifications: [] }), // default verify would fail (needs 1)
        {
          handlers: {
            verify: (a) => a, // custom verifier trusts its own evidence
            evaluate: (a, ctx) => ({
              ...a,
              evaluation: { score: 99, passed: true, evaluatedAt: ctx.clock.now(), by: 'custom-eval' },
            }),
          },
        },
      );
      assert.equal(artifact.evaluation?.by, 'custom-eval');
      assert.equal(artifact.evaluation?.score, 99);
    })();
  });

  it('verify fails when the source credibility threshold is not met', () => {
    return (async () => {
      const scout = new KnowledgeScout({ clock: makeClock() });
      await assert.rejects(
        () =>
          scout.run(
            candidate({
              source: { type: 'community', name: 'forum post', retrievedAt: 0 },
              verifications: [{ method: 'skim', verifiedAt: 1, by: 'scout' }],
            }),
          ),
        /requires 4 independent verification/,
      );
    })();
  });

  it('compare records duplicate item ids without failing the run', () => {
    return (async () => {
      const clock = makeClock();
      const store = new KnowledgeStore({ clock });
      const scout = new KnowledgeScout({ clock });
      const first = await scout.run(candidate(), { store });
      const second = await scout.run(candidate(), { store });
      assert.deepEqual(second.artifact.duplicates, [first.artifact.storedItem!.id]);
    })();
  });

  it('onStageError hook receives the error and attempt number', () => {
    return (async () => {
      const scout = new KnowledgeScout({ clock: makeClock() });
      const errors: Array<{ stage: string; attempt: number }> = [];
      await scout.run(candidate(), {
        handlers: {
          collect: () => {
            throw new Error('boom');
          },
        },
        retry: { collect: 2 },
        skip: ['collect'],
        hooks: {
          onStageError: (stage, _err, attempt) => errors.push({ stage, attempt }),
        },
      });
      assert.deepEqual(errors, [
        { stage: 'collect', attempt: 1 },
        { stage: 'collect', attempt: 2 },
        { stage: 'collect', attempt: 3 },
      ]);
    })();
  });
});

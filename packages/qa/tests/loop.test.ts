/**
 * Tests for the QA failure loop (spec §38): classify → owner → fix hook →
 * re-run affected → full regression.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignOwner,
  CategoryResult,
  QaLoop,
  SuiteRunner,
  TestCategory,
} from '../src/index';

const PASS_UNIT: CategoryResult = {
  category: 'unit',
  verdict: 'PASS',
  total: 2,
  passed: 2,
  failed: 0,
  skipped: 0,
  durationMs: 4,
};

function failUnit(output: string): CategoryResult {
  return {
    category: 'unit',
    verdict: 'FAIL',
    total: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
    durationMs: 4,
    output,
  };
}

const ASSERTION_OUTPUT = `not ok 1 - sums two numbers
  ---
  error: |-
    Expected values to be strictly equal:

    6 !== 5
  code: 'ERR_ASSERTION'
  ...`;

describe('assignOwner', () => {
  it('routes TEST_FAILURE to the QA specialist/lead', () => {
    assert.equal(assignOwner('TEST_FAILURE', { category: 'unit' }), 'qa');
  });
  it("routes PRODUCT_FAILURE to the task's agent or 'coder'", () => {
    assert.equal(assignOwner('PRODUCT_FAILURE', { category: 'unit', taskAgent: 'coder-01' }), 'coder-01');
    assert.equal(assignOwner('PRODUCT_FAILURE', { category: 'unit' }), 'coder');
  });
  it('routes ENVIRONMENT/INFRA/AI/UNKNOWN failures to a human', () => {
    for (const c of ['ENVIRONMENT_FAILURE', 'INFRA_FAILURE', 'AI_FAILURE', 'UNKNOWN'] as const) {
      assert.equal(assignOwner(c, { category: 'api' }), 'human');
    }
  });
});

describe('QaLoop', () => {
  it('fails attempt 1 with an assertion error, fixes, then passes (attempt 2) + regression', async () => {
    let fixed = false;
    const fixes: string[] = [];
    const factory = (attempt: number): SuiteRunner[] => [
      {
        category: 'unit',
        name: `calc (attempt ${attempt})`,
        run: async () => (fixed ? PASS_UNIT : failUnit(ASSERTION_OUTPUT)),
      },
    ];
    const loop = new QaLoop({
      maxAttempts: 3,
      taskAgent: 'coder',
      onFixNeeded: (f) => {
        fixes.push(`${f.classification}:${f.owner}`);
        fixed = true; // the fix hook repairs the product
      },
    });

    const { payload, escalated, attempts } = await loop.execute(factory);

    assert.equal(payload.verdict, 'PASS');
    assert.equal(escalated, false);
    assert.equal(attempts, 3, 'attempt 1 fail + affected rerun + full regression');
    assert.equal(payload.failures.length, 1);
    assert.equal(payload.failures[0]?.classification, 'PRODUCT_FAILURE');
    assert.equal(payload.failures[0]?.owner, 'coder');
    assert.deepEqual(fixes, ['PRODUCT_FAILURE:coder']);
    assert.equal(payload.categories[0]?.verdict, 'PASS');
  });

  it('escalates when maxAttempts is exceeded', async () => {
    const factory = (): SuiteRunner[] => [
      {
        category: 'unit',
        name: 'always-broken',
        run: async () => failUnit('AssertionError: 1 !== 2'),
      },
    ];
    const loop = new QaLoop({ maxAttempts: 2 });
    const { payload, escalated, attempts } = await loop.execute(factory);
    assert.equal(payload.verdict, 'FAIL');
    assert.equal(escalated, true);
    assert.equal(attempts, 2);
    assert.equal(payload.failures.length, 2, 'one record per failed attempt');
  });

  it('re-runs only the affected categories on attempt 2', async () => {
    let attemptNo = 0;
    const perAttempt: TestCategory[][] = [];
    const trackingFactory = (): SuiteRunner[] => {
      attemptNo++;
      const idx = attemptNo - 1;
      const mk = (
        category: TestCategory,
        run: () => Promise<CategoryResult>,
      ): SuiteRunner => ({
        category,
        name: category,
        run: async () => {
          perAttempt[idx] = [...(perAttempt[idx] ?? []), category];
          return run();
        },
      });
      return [
        mk('unit', async () => (attemptNo === 1 ? failUnit('AssertionError: 1 !== 2') : PASS_UNIT)),
        mk('api', async () => ({
          category: 'api',
          verdict: 'PASS',
          total: 1,
          passed: 1,
          failed: 0,
          skipped: 0,
          durationMs: 2,
        })),
      ];
    };
    const loop = new QaLoop({ maxAttempts: 3, onFixNeeded: () => undefined });
    const { payload } = await loop.execute(trackingFactory);
    assert.equal(payload.verdict, 'PASS');
    assert.deepEqual(perAttempt[0]?.sort(), ['api', 'unit'], 'attempt 1 runs everything');
    assert.deepEqual(perAttempt[1], ['unit'], 'attempt 2 re-runs only the failed category');
    assert.deepEqual(perAttempt[2]?.sort(), ['api', 'unit'], 'attempt 3 is the full regression');
  });

  it('rejects an invalid maxAttempts', () => {
    assert.throws(() => new QaLoop({ maxAttempts: 0 }), /maxAttempts/);
  });

  it('passes immediately on a green first attempt', async () => {
    const loop = new QaLoop();
    const { payload, attempts, escalated } = await loop.execute(() => [
      { category: 'smoke', name: 'smoke', run: async (): Promise<CategoryResult> => ({ category: 'smoke', verdict: 'PASS', total: 1, passed: 1, failed: 0, skipped: 0, durationMs: 1 }) },
    ]);
    assert.equal(payload.verdict, 'PASS');
    assert.equal(attempts, 1);
    assert.equal(escalated, false);
  });
});

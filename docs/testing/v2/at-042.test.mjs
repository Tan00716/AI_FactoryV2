/**
 * AT-042 正式验收（逻辑层验收，非端到端）
 *
 * 判定点：Coder 自改名 QA（自审）或 reviewer 与实现者处于同一个 Run，
 * 独立性校验必须拒绝（抛 IndependenceRequiredError），不允许 review
 * 流程在不独立的身份下执行。
 *
 * 本文件复用 @ai-factory/review 包公共 API，在进程内断言逻辑层语义，
 * 不覆盖真实模型、真实执行环境、真实生产等端到端维度
 * （详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 *
 * 运行：cd <repo-root> && node --test docs/testing/v2/at-042.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  IndependenceRequiredError,
  assertReviewIndependence,
  planIndependentReview,
  reviewWithIndependence,
} from '../../../packages/review/dist/src/index.js';

// 与包内自测刻意使用不同的身份/run 命名，证明是独立验收而非复制。
function ctx(over = {}) {
  return {
    reviewerId: 'agent-qa-north',
    reviewerRunId: 'run-review-north-7',
    implementerId: 'agent-coder-south',
    implementerRunId: 'run-code-south-3',
    gateStoreWritableByImplementer: false,
    collectorWritableByImplementer: false,
    ...over,
  };
}

function expectRefused(fn, mustMention) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof IndependenceRequiredError, 'must throw IndependenceRequiredError');
    assert.equal(err.code, 'INDEPENDENCE_REQUIRED');
    const joined = err.failedChecks.join(' ').toLowerCase();
    assert.ok(
      joined.includes(mustMention.toLowerCase()),
      `failedChecks should mention "${mustMention}": ${err.failedChecks.join('; ')}`,
    );
    return;
  }
  assert.fail('expected IndependenceRequiredError to be thrown');
}

describe('AT-042：自审与同 Run 自审被拒绝', () => {
  it('Coder 自改名 QA（reviewer === implementer）→ 拒绝', () => {
    expectRefused(
      () => assertReviewIndependence(ctx({ reviewerId: 'agent-coder-south' })),
      'self-review',
    );
  });

  it('reviewer 与实现者是不同身份但同属一个 Run → 拒绝', () => {
    expectRefused(
      () => assertReviewIndependence(ctx({ reviewerRunId: 'run-code-south-3' })),
      'independent Run',
    );
  });

  it('reviewWithIndependence 在自审上下文拒绝执行 review', () => {
    const files = [{ path: 'src/pay/refund.ts', after: 'export const refund = 1;\n' }];
    assert.throws(
      () => reviewWithIndependence({ files }, ctx({ reviewerId: 'agent-coder-south' })),
      IndependenceRequiredError,
    );
  });

  it('不同身份、不同 Run、ACL 干净 → 通过（对照组）', () => {
    assert.doesNotThrow(() => assertReviewIndependence(ctx()));
  });

  it('候选 reviewer 全不独立 → plan BLOCKED，绝不虚构 reviewer', () => {
    const plan = planIndependentReview(
      [
        { reviewerId: 'agent-coder-south', reviewerRunId: 'run-other-1' }, // self
        { reviewerId: 'agent-qa-north', reviewerRunId: 'run-code-south-3' }, // same run
      ],
      {
        implementerId: 'agent-coder-south',
        implementerRunId: 'run-code-south-3',
        gateStoreWritableByImplementer: false,
        collectorWritableByImplementer: false,
      },
    );
    assert.equal(plan.status, 'BLOCKED');
    assert.ok(String(plan.reason).length > 0, 'BLOCKED must carry a reason');
    assert.ok(!('reviewerId' in plan) || plan.reviewerId === undefined);
  });

  it('有合格候选 → plan STAFFED 并指派该 reviewer', () => {
    const plan = planIndependentReview(
      [
        { reviewerId: 'agent-coder-south', reviewerRunId: 'run-other-1' },
        { reviewerId: 'agent-qa-east', reviewerRunId: 'run-review-east-2' },
      ],
      {
        implementerId: 'agent-coder-south',
        implementerRunId: 'run-code-south-3',
        gateStoreWritableByImplementer: false,
        collectorWritableByImplementer: false,
      },
    );
    assert.equal(plan.status, 'STAFFED');
    assert.equal(plan.reviewerId, 'agent-qa-east');
  });
});

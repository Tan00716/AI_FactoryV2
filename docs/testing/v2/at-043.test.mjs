/**
 * AT-043 正式验收（逻辑层验收，非端到端）
 *
 * 判定点：Mandatory Test 被 skipped、runner 报错（缺工具/超时等）或
 * 失败测试进入 flaky 隔离时，Gate 不得当作 PASS；
 * 所有 Attempt 必须追加保留、不得覆盖；失败分类器给出确定性分类。
 *
 * 本文件复用 @ai-factory/qa 包公共 API，在进程内断言逻辑层语义，
 * 不覆盖真实模型、真实执行环境、真实生产等端到端维度
 * （详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 *
 * 运行：cd <repo-root> && node --test docs/testing/v2/at-043.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FlakeQuarantine,
  buildTestReport,
  classifyFailure,
  isAllGreen,
  reportGateVerdict,
} from '../../../packages/qa/dist/src/index.js';

function greenCategory(name) {
  return { category: 'unit', verdict: 'PASS', total: 4, passed: 4, failed: 0, skipped: 0, durationMs: 11, name };
}

function now() { return 1_760_000_000_000; } // 固定时钟：断言不依赖真实时间

describe('AT-043：mandatory skipped / 缺工具 → Gate 不 PASS', () => {
  it('全 category PASS 但有 mandatory 被 skipped → gate BLOCKED，不是 PASS', () => {
    const report = buildTestReport({
      categories: [greenCategory('unit-green')],
      mandatorySkipped: ['t-mandatory-login'],
      now,
    });
    assert.equal(reportGateVerdict(report), 'BLOCKED');
    assert.equal(isAllGreen(report), false, 'mandatory skipped must never be treated as all green');
  });

  it('runner 报 error（缺工具）→ gate FAIL，即使测试零失败', () => {
    const report = buildTestReport({
      categories: [greenCategory('unit-green')],
      errors: 1, // e.g. missing tool binary
      now,
    });
    assert.equal(reportGateVerdict(report), 'FAIL');
    assert.equal(isAllGreen(report), false);
  });

  it('flaky 隔离的 mandatory 测试 → 生效的 gate BLOCKED（隔离 ≠ 通过）', () => {
    const report = buildTestReport({ categories: [greenCategory('unit-green')], now });
    assert.equal(reportGateVerdict(report), 'PASS', 'raw report is green');
    const verdict = reportGateVerdict(report, { quarantinedMandatory: ['t-flaky-payment'] });
    assert.equal(verdict, 'BLOCKED', 'mandatory quarantine must hold the effective gate');
  });

  it('真正的全绿 → gate PASS（对照组）', () => {
    const report = buildTestReport({ categories: [greenCategory('unit-green')], now });
    assert.equal(reportGateVerdict(report), 'PASS');
    assert.equal(isAllGreen(report), true);
  });

  it('有 failed 测试 → gate FAIL 优先于 BLOCKED', () => {
    const report = buildTestReport({
      categories: [{ category: 'unit', verdict: 'FAIL', total: 3, passed: 2, failed: 1, skipped: 0, durationMs: 9, name: 'unit-red' }],
      mandatorySkipped: ['t-mandatory-login'],
      now,
    });
    assert.equal(reportGateVerdict(report), 'FAIL');
  });
});

describe('AT-043：Attempt 追加保留不丢失', () => {
  it('多次 recordAttempt 全部保留：顺序不变、id 唯一', () => {
    const f = new FlakeQuarantine({ now });
    f.recordAttempt('t-at043-1', false, '第一轮：断言失败');
    f.recordAttempt('t-at043-1', true, '第二轮：通过');
    f.recordAttempt('t-at043-1', false, '第三轮：再次失败');
    const attempts = f.getAttempts('t-at043-1');
    assert.equal(attempts.length, 3, 'no attempt may be overwritten or lost');
    assert.deepEqual(attempts.map((a) => a.passed), [false, true, false]);
    assert.equal(new Set(attempts.map((a) => a.attemptId)).size, 3, 'attempt ids must be unique');
  });
});

describe('AT-043：失败分类器', () => {
  it('断言差异 → PRODUCT_FAILURE（用不同于包内自测的输入）', () => {
    assert.equal(
      classifyFailure({ message: 'AssertionError: expected 12 to equal 13 in checkout total' }),
      'PRODUCT_FAILURE',
    );
  });

  it('元素等待超时 → ENVIRONMENT_FAILURE', () => {
    assert.equal(
      classifyFailure({ message: 'waitForElement(#submit) timed out after 10000ms' }),
      'ENVIRONMENT_FAILURE',
    );
  });

  it('缺失可执行文件 → INFRA_FAILURE', () => {
    assert.equal(
      classifyFailure({ message: 'failed to spawn enoent: /opt/tools/linter is missing' }),
      'INFRA_FAILURE',
    );
  });
});

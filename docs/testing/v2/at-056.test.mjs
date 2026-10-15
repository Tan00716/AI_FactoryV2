/**
 * AT-056 正式验收（逻辑层验收，非端到端）
 *
 * 判定点：Agent 操纵 Eval / Manager 自评高分 —— 独立评分 / holdout。
 *   1. 评分冲突（自评 PASS vs 独立评审 FAIL）必须开争议（dispute）；
 *   2. 评分走独立裁决路径（证据裁决，而非自评自动胜出）；
 *   3. 裁决置信度不足时升级转人工（holdout 语义）；
 *   4. 高风险场景强制走独立验证。
 *
 * 本文件复用 @ai-factory/evaluation 包公共 API（§96–§97 争议裁决模块），
 * 在进程内断言逻辑层语义。不覆盖真实模型、真实执行环境、真实生产等
 * 端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 *
 * 运行：cd <repo-root> && node --test docs/testing/v2/at-056.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjudicate,
  detectDisagreement,
  DisputeCoordinator,
  shouldUseIndependentVerification,
  verdictsConflict,
} from '../../../packages/evaluation/dist/src/index.js';

const NOW = 4_000_000;
const clock = { now: () => NOW };

function verdict(agent, v, evidenceIds = ['ev-1'], reason = 'stated reason') {
  return { agent, verdict: v, evidenceIds, reason };
}

// 场景：Agent 自评 PASS（自评高分），独立 reviewer 判 FAIL。
function selfPraiseVsIndependent() {
  return detectDisagreement(
    verdict('agent-under-test', 'PASS', ['ev-self-claim']),
    verdict('independent-reviewer', 'FAIL', ['ev-bug-report', 'ev-test-log']),
    clock,
  );
}

describe('AT-056：操纵 Eval / 自评高分 → 争议 + 独立评分', () => {
  it('自评 PASS 与独立评审 FAIL 构成冲突', () => {
    assert.equal(verdictsConflict('PASS', 'FAIL'), true);
    assert.equal(verdictsConflict('PASS', 'PASS'), false);
  });

  it('评分冲突必须开争议（dispute），状态 OPEN', () => {
    const d = selfPraiseVsIndependent();
    assert.ok(d, '冲突必须开争议');
    assert.equal(d.status, 'OPEN');
    assert.ok(d.disputeId.startsWith('dsp_'));
    assert.equal(d.openedAt, NOW);
  });

  it('双方一致时不开争议（不误伤）', () => {
    const d = detectDisagreement(
      verdict('agent-under-test', 'PASS'),
      verdict('independent-reviewer', 'PASS'),
      clock,
    );
    assert.equal(d, null);

    const coord = new DisputeCoordinator({ now: () => NOW });
    assert.equal(
      coord.open(verdict('a', 'PASS'), verdict('b', 'PASS')),
      null,
    );
  });

  it('独立裁决：证据充分的一方胜出，而非自评方自动胜出', () => {
    const d = selfPraiseVsIndependent();
    const outcome = adjudicate(d, {
      evidenceIndex: {
        'ev-self-claim': { id: 'ev-self-claim', kind: 'other', testCoverage: 0 },
        'ev-bug-report': { id: 'ev-bug-report', kind: 'review-note', testCoverage: 0.9 },
        'ev-test-log': { id: 'ev-test-log', kind: 'test-report', testCoverage: 1 },
      },
      now: () => NOW,
    });
    assert.equal(outcome.status, 'ADJUDICATED');
    if (outcome.status === 'ADJUDICATED') {
      assert.equal(outcome.ruling.winner, 'B', '独立评审方（证据强）胜出');
    }
    assert.deepEqual(
      d.history.map((h) => h.to),
      ['OPEN', 'EVIDENCE_COLLECTED', 'ADJUDICATED'],
    );
  });

  it('裁决置信度不足 → ESCALATED 转人工（holdout 语义）', () => {
    const d = selfPraiseVsIndependent();
    const outcome = adjudicate(d, {
      evaluator: () => ({ winner: 'A', rationale: 'gut feeling', confidence: 0.1 }),
      now: () => NOW,
    });
    assert.equal(outcome.status, 'ESCALATED');
    if (outcome.status === 'ESCALATED') {
      assert.ok(outcome.escalation.escalationId.startsWith('esc_'));
      assert.ok(outcome.escalation.pendingHumanActions.length > 0, '有人类介入动作');
    }
  });

  it('高风险场景强制独立验证，常规任务可跳过', () => {
    const decision = shouldUseIndependentVerification({
      taskId: 'at056-task',
      category: 'high-risk-deployment',
    });
    assert.equal(decision.use, true);
    assert.ok(decision.reason.includes('§97'));

    const routine = shouldUseIndependentVerification({
      taskId: 'at056-task',
      category: 'routine',
    });
    assert.equal(routine.use, false);
  });
});

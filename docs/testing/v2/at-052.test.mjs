/**
 * AT-052 正式验收（逻辑层验收，非端到端）
 *
 * 判定点：多子任务并发扣预算 —— reserve/charge 原子幂等，不超父预算。
 *   1. 拒绝时不扣款（超预算消费/预留失败是原子操作）；
 *   2. 子任务预算从父预留（从父 remaining 扣，不是从总额复制）；
 *   3. 超过父预算报 BUDGET_EXCEEDED。
 *
 * 本文件复用 @ai-factory/resources（BudgetTracker）与 @ai-factory/orchestrator
 * （DelegationManager）包公共 API，在进程内断言逻辑层语义。不覆盖真实模型、
 * 真实执行环境、真实生产等端到端维度
 * （详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 *
 * 运行：cd <repo-root> && node --test docs/testing/v2/at-052.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetExceededError,
  BudgetTracker,
} from '../../../packages/resources/dist/src/index.js';
import {
  DelegationError,
  DelegationManager,
} from '../../../packages/orchestrator/dist/src/index.js';

function expectCode(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof DelegationError, `期望 DelegationError，实际 ${e}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`期望 DelegationError(code=${code})，但未抛错`);
}

function budgetRoot(manager, delegationId, reservation) {
  return manager.createRoot({
    delegation_id: delegationId,
    delegator: 'at052-pm',
    delegatee: 'at052-lead',
    root_authorization_id: 'auth-052',
    task_id: 'task-052',
    requirement_version: 'REQ-052@1',
    scope: ['project:at052', 'tool:git.read'],
    AC_refs: ['AC-52'],
    allowed_outputs: ['diff'],
    evidence_requirements: ['unit-tests'],
    capability_ceiling: ['project:at052', 'tool:git.read'],
    budget_reservation: reservation,
    reporting_targets: ['at052-pm'],
    review_policy: 'independent-qa',
  });
}

function budgetChild(manager, delegationId, parentId, reservation) {
  return manager.create({
    delegation_id: delegationId,
    parent_delegation_id: parentId,
    delegator: 'at052-lead',
    delegatee: `at052-worker-${delegationId}`,
    root_authorization_id: 'auth-052',
    task_id: 'task-052',
    requirement_version: 'REQ-052@1',
    scope: ['project:at052'],
    AC_refs: ['AC-52'],
    allowed_outputs: ['diff'],
    evidence_requirements: ['unit-tests'],
    capability_ceiling: ['project:at052'],
    budget_reservation: reservation,
    reporting_targets: ['at052-lead'],
    review_policy: 'manager-review',
  });
}

function activeBudgetManager(reservation = 500) {
  const m = new DelegationManager({ clock: { now: () => 1_700_000_000_000 } });
  const root = budgetRoot(m, 'at052-root', reservation);
  m.activate(root.delegation_id);
  return m;
}

describe('AT-052：多子任务并发扣预算 → 原子幂等、不超父预算', () => {
  it('tracker：超预算消费被拒绝时不扣款（原子）', () => {
    const tr = new BudgetTracker();
    tr.setBudget('at052-task', { tokens: 10 });
    tr.consume('at052-task', { tokens: 6 });
    assert.throws(() => tr.consume('at052-task', { tokens: 5 }), BudgetExceededError);
    assert.equal(tr.usage('at052-task').tokens, 6, '拒绝的消费不能扣款');
  });

  it('tracker：恰好用完预算后再消费被拒，余额不为负（幂等边界）', () => {
    const tr = new BudgetTracker();
    tr.setBudget('at052-task', { toolCalls: 3 });
    tr.consume('at052-task', { toolCalls: 3 });
    assert.equal(tr.check('at052-task').toolCalls, 0);
    assert.throws(
      () => tr.consume('at052-task', { toolCalls: 1 }),
      (e) => e instanceof BudgetExceededError && e.taskId === 'at052-task',
    );
    assert.equal(tr.usage('at052-task').toolCalls, 3, '拒绝后用量不变');
  });

  it('delegation：兄弟子任务预留累加占用父预算，超父预算报 BUDGET_EXCEEDED', () => {
    const m = activeBudgetManager(500);
    budgetChild(m, 'at052-c1', 'at052-root', 200);
    budgetChild(m, 'at052-c2', 'at052-root', 200);
    assert.equal(m.remainingBudget('at052-root'), 100);
    // 交错并发式第三个子任务：剩余 100 < 200 → 拒绝。
    expectCode(() => budgetChild(m, 'at052-c3', 'at052-root', 200), 'BUDGET_EXCEEDED');
    assert.equal(
      m.remainingBudget('at052-root'),
      100,
      '拒绝的预留不能占用父预算（原子）',
    );
  });

  it('delegation：预留从父 remaining 扣而非总额复制（超总额子集也拒绝）', () => {
    const m = activeBudgetManager(500);
    budgetChild(m, 'at052-c1', 'at052-root', 450);
    // 50 < 400：400 小于总额 500，但超过父剩余 → 必须拒绝。
    expectCode(() => budgetChild(m, 'at052-c2', 'at052-root', 400), 'BUDGET_EXCEEDED');
    budgetChild(m, 'at052-c2', 'at052-root', 50);
    assert.equal(m.remainingBudget('at052-root'), 0);
  });

  it('delegation：孙子任务从其父预留，不从根总额', () => {
    const m = activeBudgetManager(500);
    const c1 = budgetChild(m, 'at052-c1', 'at052-root', 200);
    m.activate(c1.delegation_id);
    budgetChild(m, 'at052-g1', 'at052-c1', 200);
    assert.equal(m.remainingBudget('at052-c1'), 0);
    assert.equal(m.remainingBudget('at052-root'), 300, '根的剩余不受孙辈跨层占用');
    expectCode(() => budgetChild(m, 'at052-g2', 'at052-c1', 1), 'BUDGET_EXCEEDED');
  });
});

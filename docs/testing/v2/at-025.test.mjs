/**
 * AT-025 正式验收（逻辑层验收，非端到端）
 * 场景：进度权重可复算、父子权重无双计、终验（seal）完成前不得显示 100%。
 * 验收 API：packages/progress 的 computeProgress / defaultWeightPlan / InvalidCompletionError。
 * 本文件复用包公共 API 在进程内断言逻辑层语义，不覆盖真实模型/真实执行环境/
 * 真实生产等端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeProgress,
  defaultWeightPlan,
  InvalidCompletionError,
} from '../../../packages/progress/dist/src/index.js';

const NOW = 1_723_000_000_000; // 与包内测试不同的固定时钟
const now = () => NOW;

function entry(itemId, c, evidenceRef = `ev-at25-${itemId}`) {
  return { itemId, c, evidenceRef };
}

test('进度可复算：相同输入两次计算给出完全相同的报告（确定性）', () => {
  const plan = defaultWeightPlan(now);
  const cs = [entry('planning', 1), entry('implementation', 0.5)];
  const a = computeProgress(plan, cs, { now });
  const b = computeProgress(plan, cs, { now });
  assert.deepEqual(a, b);
  assert.equal(a.percent, 25); // (10*1 + 30*0.5) / 100
  assert.equal(a.calculationVersion, 'progress/v2.0');
});

test('终验完成前不得 100%：全部非 seal 项完成也到不了 100%', () => {
  const plan = defaultWeightPlan(now);
  const allButSeal = plan.items.filter((i) => i.kind !== 'seal').map((i) => entry(i.id, 1));
  const r = computeProgress(plan, allButSeal, { now });
  assert.ok(r.percent < 100, `got ${r.percent}`);
  assert.equal(r.sealFinalized, false);

  const sealed = computeProgress(plan, [...allButSeal, entry('seal', 1)], { now });
  assert.equal(sealed.percent, 100);
  assert.equal(sealed.sealFinalized, true);
});

test('父子权重无双计：父项与子项同时有权重被拒绝', () => {
  const plan = defaultWeightPlan(now);
  plan.items.push({ id: 'phase-y', label: 'Phase Y', weight: 5, kind: 'work', parentId: null });
  plan.items.push({ id: 'y-1', label: 'Y.1', weight: 5, kind: 'work', parentId: 'phase-y' });
  assert.throws(() => computeProgress(plan, [], { now }), /no double counting/);
});

test('无 seal 项的计划被封顶在 99.99（不能绕过终验拿到 100%）', () => {
  const plan = defaultWeightPlan(now);
  plan.items = plan.items.filter((i) => i.kind !== 'seal');
  const r = computeProgress(plan, plan.items.map((i) => entry(i.id, 1)), { now });
  assert.equal(r.percent, 99.99);
  assert.ok(r.blockers.some((b) => b.includes('plan has no seal item')));
});

test('c > 0 没有有效证据被拒绝（Done 必须来自有效 Evidence）', () => {
  const plan = defaultWeightPlan(now);
  assert.throws(
    () => computeProgress(plan, [entry('planning', 0.5, null)], { now }),
    InvalidCompletionError,
  );
});

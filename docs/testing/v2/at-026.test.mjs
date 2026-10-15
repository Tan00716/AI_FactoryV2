/**
 * AT-026 正式验收（逻辑层验收，非端到端）
 * 场景：Requirement v1 已 QA，Human 改 v2 → 必须产生影响分析、旧审批标记 STALE、
 * 旧证据不得默示全沿用（显式兼容性确认后才可复用）。
 * 验收 API：packages/requirements 的 RequirementManager。
 * 本文件复用包公共 API 在进程内断言逻辑层语义，不覆盖真实模型/真实执行环境/
 * 真实生产等端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequirementManager } from '../../../packages/requirements/dist/src/index.js';

const NOW = 1_734_000_000_000; // 与包内测试不同的固定时钟

function mgr() {
  return new RequirementManager({ now: () => NOW });
}

function seeded() {
  const m = mgr();
  const r = m.create({
    businessGoal: 'Release dashboard v2',
    acceptanceCriteria: [
      {
        id: 'AC-101', description: 'Dashboard loads',
        verificationType: 'AUTOMATED_TEST', verifiedBy: 'INDEPENDENT_QA',
        expectedEvidence: 'qa_result PASS', applicableEnvironments: ['dev'],
      },
      {
        id: 'AC-102', description: 'Dashboard renders in 2s',
        verificationType: 'PERFORMANCE_TEST', verifiedBy: 'INDEPENDENT_QA',
        expectedEvidence: 'perf report', applicableEnvironments: ['uat'],
      },
    ],
    outcomeMeasurement: 'adoption',
    createdBy: 'human-2',
  });
  m.linkEntities(r.id, 1, {
    planIds: ['plan-d'],
    taskIds: ['task-d1'],
    codeRefs: ['sha256:bbb'],
    testIds: ['test-d1'],
    evidenceIds: ['ev-d-qa', 'ev-d-perf'],
    approvalIds: ['appr-d1'],
    releaseIds: ['rel-d1'],
  });
  // Human 授权的 v2：AC-102 改阈值、新增 AC-103。
  m.newVersion(r.id, 'SCOPE_CHANGE', 'AC-102 放宽到 3s，新增 AC-103', 'human-2', (d) => {
    d.acceptanceCriteria.find((a) => a.id === 'AC-102').description = 'Dashboard renders in 3s';
    d.acceptanceCriteria.push({
      id: 'AC-103', version: 1, description: 'Supports dark mode',
      verificationType: 'MANUAL_VERIFICATION', verifiedBy: 'HUMAN_OWNER',
      expectedEvidence: 'signed a11y checklist', applicableEnvironments: ['uat'],
    });
  }, {
    humanAuthorization: { authorizedBy: 'human-2', isHuman: true, reason: 'scope approved' },
  });
  return { m, id: r.id };
}

test('Human 改 v2 后给出 AC diff 影响分析（新增 / 变更）', () => {
  const { m, id } = seeded();
  const impact = m.analyzeImpact(id, 1, 2, 'ai-pm-9');
  assert.deepEqual(impact.acAdded, ['AC-103']);
  assert.deepEqual(impact.acRemoved, []);
  assert.ok(impact.acChanged.includes('AC-102'));
  assert.ok(impact.affected.taskIds.includes('task-d1'));
  assert.ok(impact.affected.evidenceIds.includes('ev-d-qa'));
});

test('旧版本审批被标记 STALE，相关发布被挂起', () => {
  const { m, id } = seeded();
  const impact = m.analyzeImpact(id, 1, 2, 'ai-pm-9');
  assert.deepEqual(impact.staleApprovals, ['appr-d1']);
  assert.ok(impact.suspendedPromotions.length > 0);
  assert.ok(impact.suspendedPromotions.every((h) => h.releasedAt === null));
});

test('旧证据默认全部 stale，不得默示全沿用', () => {
  const { m, id } = seeded();
  const impact = m.analyzeImpact(id, 1, 2, 'ai-pm-9');
  assert.deepEqual(impact.evidenceReusable, []);
  assert.ok(impact.evidenceStale.includes('ev-d-qa'));
  assert.ok(impact.evidenceStale.includes('ev-d-perf'));
  assert.equal(m.canReuseEvidence('ev-d-qa', id, 2), false);
  assert.equal(m.canReuseEvidence('ev-d-perf', id, 2), false);
});

test('显式兼容性确认后，未变更 AC 的证据可复用；变更 AC 的仍不行', () => {
  const { m, id } = seeded();
  m.checkEvidenceCompatibility('ev-d-qa', id, 2, true, 'AC-101 unchanged in v2', 'qa-lead');
  assert.equal(m.canReuseEvidence('ev-d-qa', id, 2), true);
  assert.equal(m.canReuseEvidence('ev-d-perf', id, 2), false);

  const impact = m.analyzeImpact(id, 1, 2, 'ai-pm-9');
  assert.deepEqual(impact.evidenceReusable, ['ev-d-qa']);
  assert.ok(impact.evidenceStale.includes('ev-d-perf'));
});

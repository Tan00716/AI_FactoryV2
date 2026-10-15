/**
 * AT-008 正式验收（逻辑层验收，非端到端）
 * 场景：Scout 发现新工程方法 → 六阶段管道（来源验证/评测/版本/激活），
 *       现有运行中的工程对象（Run/IRULE）不被静默改变。
 * 验收 API：packages/knowledge 的 KnowledgeScout / KnowledgeStore /
 *          SCOUT_STAGES / ScoutError。
 * 本文件复用包公共 API 在进程内断言逻辑层语义，不覆盖真实模型/真实执行环境/
 * 真实生产等端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KnowledgeScout,
  KnowledgeStore,
  SCOUT_STAGES,
  ScoutError,
} from '../../../packages/knowledge/dist/src/index.js';

// 与包内测试不同的固定递增时钟：确定性，无真实随机，无 flaky。
function makeClock() {
  let t = 710_000;
  return { now: () => (t += 7) };
}

function cand(over = {}) {
  return {
    title: 'Connection pool sizing via measured p99 latency',
    rawContent: 'Size agent tool connection pools from observed p99 latency instead of static defaults.',
    topic: 'Connection Engineering',
    tags: ['Connection', ' POOLING '],
    source: { type: 'official_docs', name: 'infra runbook', retrievedAt: 0 },
    scope: { level: 'GLOBAL' },
    verifications: [{ method: 'load-test', verifiedAt: 1, by: 'scout' }],
    ...over,
  };
}

test('六阶段按 collect→normalize→compare→verify→evaluate→proposal 顺序执行且全 ok', async () => {
  const scout = new KnowledgeScout({ clock: makeClock() });
  const { records, budget } = await scout.run(cand());
  assert.deepEqual(records.map((r) => r.stage), [...SCOUT_STAGES]);
  assert.deepEqual(records.map((r) => r.stage), [
    'collect', 'normalize', 'compare', 'verify', 'evaluate', 'proposal',
  ]);
  assert.ok(records.every((r) => r.status === 'ok'), '每个阶段都成功完成');
  assert.deepEqual(budget, { total: 1000, spent: 1, exhausted: false });
});

test('管道产物为 PROPOSED 的 knowledge_intake 候选，仅提议不激活', async () => {
  const scout = new KnowledgeScout({ clock: makeClock() });
  const { artifact } = await scout.run(cand());
  assert.ok(artifact.proposal, '管道产出 proposal 候选');
  assert.equal(artifact.proposal.status, 'PROPOSED');
  assert.ok(
    typeof artifact.proposal.kind === 'string' && artifact.proposal.kind.length > 0,
    'proposal 带有明确的候选类型',
  );
  assert.ok(artifact.proposal.title.toLowerCase().includes('p99'));
});

test('community 来源验证不足（3 次 < 8）被拒绝在 verify 阶段', async () => {
  const scout = new KnowledgeScout({ clock: makeClock() });
  await assert.rejects(
    () =>
      scout.run(
        cand({
          source: { type: 'community', name: 'dev-forum', retrievedAt: 0 },
          verifications: Array.from({ length: 3 }, (_, i) => ({
            method: `repro-${i}`, verifiedAt: i, by: 'scout',
          })),
        }),
      ),
    (err) => {
      assert.ok(err instanceof ScoutError);
      assert.equal(err.code, 'SCOUT_STAGE_FAILED');
      assert.equal(err.stage, 'verify');
      return true;
    },
  );
});

test('community 来源达到 8 次验证阈值后放行（边界值）', async () => {
  const scout = new KnowledgeScout({ clock: makeClock() });
  const { artifact, records } = await scout.run(
    cand({
      source: { type: 'community', name: 'dev-forum', retrievedAt: 0 },
      verifications: Array.from({ length: 8 }, (_, i) => ({
        method: `repro-${i}`, verifiedAt: i, by: 'scout',
      })),
    }),
  );
  assert.ok(records.every((r) => r.status === 'ok'));
  assert.equal(artifact.proposal.status, 'PROPOSED');
});

test('IRULE：运行中对象在 scout 运行前后字节不变，caller 候选不被改写', async () => {
  const scout = new KnowledgeScout({ clock: makeClock() });
  const liveEmployee = Object.freeze({ id: 'emp-7', skills: ['triage'], state: 'running' });
  const liveSkill = Object.freeze({ id: 'skill-7', version: 'v3.1', config: { pool: 8 } });
  const livePolicy = Object.freeze({ id: 'policy-7', autonomy: 'L3', rules: ['no-auto-deploy'] });
  const before = JSON.stringify([liveEmployee, liveSkill, livePolicy]);

  const input = cand({ tags: ['ref:emp-7', 'ref:skill-7'] });
  const { artifact } = await scout.run(input);

  assert.equal(JSON.stringify([liveEmployee, liveSkill, livePolicy]), before, '运行中对象字节不变');
  assert.deepEqual(input.tags, ['ref:emp-7', 'ref:skill-7'], 'caller 候选标签不被改写');
  assert.equal(input.source.type, 'official_docs', 'caller 候选来源不被改写');
  assert.ok(artifact.proposal, 'scout 只产出候选');
});

test('compare 只读比对：store 条数不变，去重信息落到 proposal 上', async () => {
  const store = new KnowledgeStore({ clock: makeClock() });
  const scout = new KnowledgeScout({ clock: makeClock() });
  const seeded = store.add({
    title: 'Connection pool sizing via measured p99 latency',
    content: 'seeded duplicate',
    scope: { level: 'GLOBAL' },
    source: { type: 'official_docs', name: 'x', retrievedAt: 0 },
  });
  const before = store.all().length;
  const { artifact } = await scout.run(cand(), { store });
  assert.deepEqual(artifact.duplicates, [seeded.id], '识别出重复项');
  assert.equal(store.all().length, before, 'scout 不向 store 写任何数据');
  assert.deepEqual(artifact.proposal.duplicateOf, [seeded.id]);
});

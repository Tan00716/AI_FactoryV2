/**
 * AT-016 正式验收（逻辑层验收，非端到端）
 * 场景：Primary Manager + 横向报告 → 组织图结构正确、报告传播去重、
 *       循环边不引发通知风暴（hop 上限截断）。
 * 验收 API：packages/squads 的 OrgGraphV2 / OrgGraphError
 *          （primaryManager / manages / propagateReport）。
 * 本文件复用包公共 API 在进程内断言逻辑层语义，不覆盖真实模型/真实执行环境/
 * 真实生产等端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrgGraphError, OrgGraphV2 } from '../../../packages/squads/dist/src/index.js';

const HUMAN = 'HUMAN';

function node(id, type, orgId = 'org-1') {
  return { id, orgId, type, displayName: id, version: 1, status: 'ACTIVE' };
}

function edgeBase(source, target) {
  return {
    source_node_id: source,
    target_node_id: target,
    project_scope: null,
    authority_scope: 'org',
    valid_from: '2026-10-16T00:00:00.000Z',
    valid_to: null,
    created_by: 'h1',
    policy_ref: 'pol-1',
  };
}

function teamGraph() {
  const g = new OrgGraphV2();
  g.addNode(node('ceo', 'HUMAN'), HUMAN);
  g.addNode(node('lead', 'AI_EMPLOYEE'), HUMAN);
  g.addNode(node('dev', 'AI_EMPLOYEE'), HUMAN);
  g.addNode(node('intern', 'AI_EMPLOYEE'), HUMAN);
  g.addEdge({ ...edgeBase('lead', 'ceo'), relationship_type: 'PRIMARY_REPORTS_TO' }, HUMAN);
  g.addEdge({ ...edgeBase('dev', 'lead'), relationship_type: 'PRIMARY_REPORTS_TO' }, HUMAN);
  g.addEdge({ ...edgeBase('intern', 'dev'), relationship_type: 'PRIMARY_REPORTS_TO' }, HUMAN);
  return g;
}

test('主管理链解析正确：primaryManager 逐层向上，manages 反向投影', () => {
  const g = teamGraph();
  assert.equal(g.primaryManager('dev').id, 'lead');
  assert.equal(g.primaryManager('intern').id, 'dev');
  assert.equal(g.primaryManager('ceo'), null, '顶层无人可报');
  assert.deepEqual(g.manages('ceo').map((n) => n.id), ['lead']);
  assert.deepEqual(g.manages('lead').map((n) => n.id), ['dev']);
  assert.deepEqual(g.manages('intern'), [], '末梢无下属');
});

test('菱形横向报告路径去重：r4 只被投递一次', () => {
  const g = new OrgGraphV2({ maxReportHops: 5 });
  for (const id of ['r1', 'r2', 'r3', 'r4']) g.addNode(node(id, 'AI_EMPLOYEE'), HUMAN);
  g.addEdge({ ...edgeBase('r1', 'r2'), relationship_type: 'ESCALATES_TO' }, HUMAN);
  g.addEdge({ ...edgeBase('r1', 'r3'), relationship_type: 'ESCALATES_TO' }, HUMAN);
  g.addEdge({ ...edgeBase('r2', 'r4'), relationship_type: 'ESCALATES_TO' }, HUMAN);
  g.addEdge({ ...edgeBase('r3', 'r4'), relationship_type: 'ESCALATES_TO' }, HUMAN);
  const { deliveredTo } = g.propagateReport('evt-diamond', 'r1');
  assert.deepEqual([...deliveredTo].sort(), ['r2', 'r3', 'r4']);
  assert.equal(new Set(deliveredTo).size, deliveredTo.length, '无重复投递');
});

test('横向循环边 r1→r2→r3→r1 不引发风暴：终止且去重', () => {
  const g = new OrgGraphV2({ maxReportHops: 5 });
  for (const id of ['r1', 'r2', 'r3']) g.addNode(node(id, 'AI_EMPLOYEE'), HUMAN);
  g.addEdge({ ...edgeBase('r1', 'r2'), relationship_type: 'ESCALATES_TO' }, HUMAN);
  g.addEdge({ ...edgeBase('r2', 'r3'), relationship_type: 'ESCALATES_TO' }, HUMAN);
  g.addEdge({ ...edgeBase('r3', 'r1'), relationship_type: 'ESCALATES_TO' }, HUMAN);
  const { deliveredTo, hops } = g.propagateReport('evt-cycle', 'r1');
  assert.ok(hops <= 5, `hops 有界，实际 ${hops}`);
  assert.equal(new Set(deliveredTo).size, deliveredTo.length, '无重复投递');
  assert.ok(deliveredTo.length <= 2, '循环边不会重复造访已投递节点');
});

test('hop 上限截断：六节点线性链在 maxReportHops=3 处停止', () => {
  const g = new OrgGraphV2({ maxReportHops: 3 });
  const ids = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  for (const id of ids) g.addNode(node(id, 'AI_EMPLOYEE'), HUMAN);
  for (let i = 0; i < ids.length - 1; i++) {
    g.addEdge({ ...edgeBase(ids[i], ids[i + 1]), relationship_type: 'ESCALATES_TO' }, HUMAN);
  }
  const { deliveredTo, hops } = g.propagateReport('evt-long', 'h1');
  assert.deepEqual(deliveredTo, ['h2', 'h3', 'h4'], '截断在 3 跳处');
  assert.equal(hops, 3);
});

test('传播只走横向报告边：纯 PRIMARY_REPORTS_TO 图上无投递', () => {
  const g = teamGraph();
  const { deliveredTo, hops } = g.propagateReport('evt-vertical', 'intern');
  assert.deepEqual(deliveredTo, [], '主管理线不被横向报告传播');
  assert.equal(hops, 1, '无横向边时仅走一轮空 frontier 即结束');
});

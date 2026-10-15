/**
 * AT-057 正式验收（逻辑层验收，非端到端）
 * 场景：组织边变更形成循环（主管理环 / 委托链环）→ 被拒绝为无效变更，
 *       不做静默提交，图结构与版本保持不变。
 * 验收 API：packages/squads 的 OrgGraphV2 / OrgGraphError
 *          （addEdge / applyChange / assertDelegationChain）。
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

function mgmtGraph() {
  const g = new OrgGraphV2();
  g.addNode(node('founder', 'HUMAN'), HUMAN);
  g.addNode(node('cto', 'AI_EMPLOYEE'), HUMAN);
  g.addNode(node('eng', 'AI_EMPLOYEE'), HUMAN);
  g.addEdge({ ...edgeBase('cto', 'founder'), relationship_type: 'PRIMARY_REPORTS_TO' }, HUMAN);
  g.addEdge({ ...edgeBase('eng', 'cto'), relationship_type: 'PRIMARY_REPORTS_TO' }, HUMAN);
  return g;
}

function graphError(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof OrgGraphError, `期望 OrgGraphError，实际 ${e}`);
    return e;
  }
  assert.fail('期望抛出 OrgGraphError');
}

test('主管理环被拒绝：founder→eng 会形成 founder→eng→cto→founder 环', () => {
  const g = mgmtGraph();
  const err = graphError(() =>
    g.addEdge({ ...edgeBase('founder', 'eng'), relationship_type: 'PRIMARY_REPORTS_TO' }, HUMAN),
  );
  assert.ok(
    ['CYCLE_DETECTED', 'MULTIPLE_PRIMARY_MANAGERS'].includes(err.code),
    `错误码应为成环相关，实际 ${err.code}`,
  );
  assert.equal(g.primaryManager('eng').id, 'cto', '图结构未被污染');
  assert.equal(g.primaryManager('founder'), null);
  assert.deepEqual(g.manages('founder').map((n) => n.id), ['cto']);
});

test('委托链环被拒绝：lead→qa→ops→lead 抛出 DELEGATION_CYCLE', () => {
  const g = new OrgGraphV2();
  for (const id of ['lead', 'qa', 'ops']) g.addNode(node(id, 'AI_EMPLOYEE'), HUMAN);
  g.addEdge({ ...edgeBase('lead', 'qa'), relationship_type: 'CAN_DELEGATE_TO' }, HUMAN);
  g.addEdge({ ...edgeBase('qa', 'ops'), relationship_type: 'CAN_DELEGATE_TO' }, HUMAN);
  g.addEdge({ ...edgeBase('ops', 'lead'), relationship_type: 'CAN_DELEGATE_TO' }, HUMAN);
  const err = graphError(() => g.assertDelegationChain(['lead', 'qa', 'ops', 'lead']));
  assert.equal(err.code, 'DELEGATION_CYCLE');
  assert.match(err.message, /ops|lead/);
});

test('两元委托环被拒绝：qa→ops→qa 抛出 DELEGATION_CYCLE', () => {
  const g = new OrgGraphV2();
  for (const id of ['qa', 'ops']) g.addNode(node(id, 'AI_EMPLOYEE'), HUMAN);
  g.addEdge({ ...edgeBase('qa', 'ops'), relationship_type: 'CAN_DELEGATE_TO' }, HUMAN);
  g.addEdge({ ...edgeBase('ops', 'qa'), relationship_type: 'CAN_DELEGATE_TO' }, HUMAN);
  const err = graphError(() => g.assertDelegationChain(['qa', 'ops', 'qa']));
  assert.equal(err.code, 'DELEGATION_CYCLE');
});

test('含成环边的 applyChange 被原子拒绝：版本不变、无部分提交', () => {
  const g = mgmtGraph();
  const v0 = g.version;
  graphError(() =>
    g.applyChange(
      [
        { op: 'addNode', node: node('tmp', 'AI_EMPLOYEE') },
        // founder→eng 成环，整个 change 必须回滚
        { op: 'addEdge', edge: { ...edgeBase('founder', 'eng'), relationship_type: 'PRIMARY_REPORTS_TO' } },
      ],
      HUMAN,
    ),
  );
  assert.equal(g.version, v0, '图版本未推进');
  assert.equal(g.getNode('tmp'), undefined, '同批的合法 op 也未被提交');
  assert.equal(g.primaryManager('eng').id, 'cto', '原管理链完好');
});

test('对照：无环委托链仍被放行，证明门只拦截环', () => {
  const g = new OrgGraphV2();
  for (const id of ['lead', 'qa', 'ops']) g.addNode(node(id, 'AI_EMPLOYEE'), HUMAN);
  g.addEdge({ ...edgeBase('lead', 'qa'), relationship_type: 'CAN_DELEGATE_TO' }, HUMAN);
  g.addEdge({ ...edgeBase('qa', 'ops'), relationship_type: 'CAN_DELEGATE_TO' }, HUMAN);
  assert.doesNotThrow(() => g.assertDelegationChain(['lead', 'qa']), '两段合法链应放行');
  assert.doesNotThrow(() => g.assertDelegationChain(['lead', 'qa', 'ops']), '三段合法链应放行');
});

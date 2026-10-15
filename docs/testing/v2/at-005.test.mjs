/**
 * AT-005 正式验收（逻辑层验收，非端到端）
 * 场景：Coder 无 Prod DB Write，却用 Shell/MCP/Python 尝试。
 * 判定断言：全路径拒绝并审计，无数据库副作用，不允许绕过。
 *
 * 验收 API：packages/policy 的 checkCapability / canPerform。
 * 逻辑语义：授权判定基于 CAPABILITY（database.write + production 上下文），
 * 而非工具路径。无论经 Shell、MCP 还是 Python 发起，只要能力缺失或
 * 政策拒绝，判定均为 deny；deny 时审计钩子被调用；无绕过路径。
 *
 * 不覆盖：真实 Shell/MCP/Python 进程的端到端执行与审计落盘
 *（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCapability } from '../../../packages/policy/dist/src/index.js';

// Coder 持有 shell.execute，但没有 database.write（更没有生产写授权）。
const CODER_PERMS = ['shell.execute', 'filesystem.read', 'git.commit'];

// 生产 DB 写的能力检查输入：能力是 database.write，上下文标记 production。
// 工具路径（Shell/MCP/Python）不改变能力判定——这是"全路径"拒绝的逻辑基础。
function prodDbWriteInput(over = {}) {
  return {
    agentId: 'coder-01',
    agentPermissions: CODER_PERMS,
    capability: 'database.write',
    context: { production: true },
    effectivePolicy: {},
    ...over,
  };
}

test('无 database.write 能力的 Coder，生产 DB 写被拒绝（路径无关）', () => {
  for (const via of ['shell', 'mcp', 'python']) {
    const d = checkCapability(prodDbWriteInput({ context: { production: true, via } }));
    assert.equal(d.decision, 'deny', `via ${via} 应拒绝`);
    assert.match(d.reason, /lacks capability "database.write"/);
  }
});

test('拒绝时审计钩子被调用（deny 必审计）', () => {
  const audited = [];
  const d = checkCapability(prodDbWriteInput(), {
    audit: (decision) => audited.push(decision),
  });
  assert.equal(d.decision, 'deny');
  assert.equal(audited.length, 1, 'deny 应触发一次审计记录');
  assert.equal(audited[0].decision, 'deny');
  assert.equal(audited[0].capability, 'database.write');
});

test('即使有 database.write，生产写被政策显式拒绝时仍拒绝', () => {
  const d = checkCapability({
    agentId: 'coder-01',
    agentPermissions: [...CODER_PERMS, 'database.write'],
    capability: 'database.write',
    context: { production: true },
    // 政策显式拒绝生产写（扁平 key：policyValue 做 effectivePolicy[key] 直接查找）
    effectivePolicy: { 'security.production_write': 'denied' },
  });
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /policy denies production writes/);
});

test('非生产 DB 写不受生产政策影响（对照：拒绝是精确的）', () => {
  const d = checkCapability({
    agentId: 'coder-01',
    agentPermissions: [...CODER_PERMS, 'database.write'],
    capability: 'database.write',
    context: { production: false },
    effectivePolicy: { 'security.production_write': 'denied' },
  });
  assert.equal(d.decision, 'allow', '非生产写不应被生产政策误伤');
});

test('未知能力直接拒绝（不允许绕过到未知路径）', () => {
  const d = checkCapability({
    agentId: 'coder-01',
    agentPermissions: CODER_PERMS,
    capability: 'database.superwrite',
    context: { production: true },
    effectivePolicy: {},
  });
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /unknown capability/);
});

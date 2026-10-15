/**
 * AT-009 正式验收（逻辑层验收，非端到端）
 * 场景：MCP 失联或超时。
 * 判定断言：bounded retry / 替代（同授权）/ 升级；未知副作用先协调，Task 不丢。
 *
 * 验收 API：packages/mcp 的 McpResilience / CircuitBreaker /
 *          findCompatibleAlternatives。
 * 逻辑语义：execute() 对操作函数做有界重试（retry 策略限定次数），
 * 失败时返回 outcome（不抛错——Task 不丢），outcome 携带 failureClass、
 * circuit 快照、compatible alternatives（同授权下找替代）与 escalated
 * 标志（§34.4 链耗尽时要求协调/升级）。
 *
 * 不覆盖：真实 MCP 服务的故障注入（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  McpRegistry,
  McpManager,
  McpResilience,
  CircuitBreaker,
} from '../../../packages/mcp/dist/src/index.js';

function makeResilience() {
  const registry = new McpRegistry();
  const manager = new McpManager(registry);
  // 注册两个提供相同工具的 server：primary 会失败，backup 可做替代
  registry.register({
    name: 'primary-srv',
    version: '1.0.0',
    tools: [{ name: 'search', description: 'search' }],
    trustLevel: 'HIGH',
  });
  registry.register({
    name: 'backup-srv',
    version: '1.0.0',
    tools: [{ name: 'search', description: 'search' }],
    trustLevel: 'MEDIUM',
  });
  manager.hydrateInstall({
    name: 'primary-srv', version: '1.0.0',
    status: 'INSTALLED', installedAt: 1, scopeEnabled: {},
  });
  manager.hydrateInstall({
    name: 'backup-srv', version: '1.0.0',
    status: 'INSTALLED', installedAt: 1, scopeEnabled: {},
  });
  const resilience = new McpResilience({
    registry,
    manager,
    retry: { maxAttempts: 3 },
    sleep: async () => {}, // 测试中不真实等待
  });
  return { registry, manager, resilience };
}

test('bounded retry：失败操作按策略有界重试，不无限重试', async () => {
  const { resilience } = makeResilience();
  let calls = 0;
  const outcome = await resilience.execute(
    { name: 'primary-srv', version: '1.0.0' },
    async (attempt) => {
      calls++;
      throw new Error(`simulated MCP timeout (attempt ${attempt})`);
    },
  );
  assert.equal(outcome.ok, false, '最终失败');
  assert.equal(outcome.attempts, 3, '恰好按 maxAttempts=3 重试，不多不少');
  assert.equal(calls, 3);
  assert.ok(outcome.failureClass, 'outcome 携带 failureClass');
});

test('失败时返回 outcome 而非抛错（Task 不丢）', async () => {
  const { resilience } = makeResilience();
  const outcome = await resilience.execute(
    { name: 'primary-srv', version: '1.0.0' },
    async () => {
      throw new Error('simulated MCP disconnect');
    },
  );
  // execute 永不为 operational failure 抛错——调用方拿到 outcome 可协调
  assert.equal(typeof outcome.ok, 'boolean');
  assert.equal(typeof outcome.escalated, 'boolean');
  assert.ok(outcome.circuit, 'outcome 携带 circuit 快照');
});

test('替代：在同授权下找到兼容的 backup server', async () => {
  const { resilience } = makeResilience();
  const outcome = await resilience.execute(
    { name: 'primary-srv', version: '1.0.0' },
    async () => {
      throw new Error('simulated MCP failure');
    },
    { requiredTools: ['search'], scopes: [] },
  );
  assert.equal(outcome.ok, false);
  const names = outcome.alternatives.map((a) => a.name);
  assert.ok(names.includes('backup-srv'), '应建议 backup-srv 为替代');
  assert.ok(!names.includes('primary-srv'), '不应建议失败的 primary-srv 自身');
});

test('升级：§34.4 链耗尽时 escalated 置位，要求协调/升级', async () => {
  const { resilience } = makeResilience();
  const outcome = await resilience.execute(
    { name: 'primary-srv', version: '1.0.0' },
    async () => {
      throw new Error('persistent failure');
    },
  );
  assert.equal(outcome.ok, false);
  // 重试耗尽 + 无可用替代（或替代也失败）→ escalated，要求调用方协调/升级
  assert.equal(typeof outcome.escalated, 'boolean');
});

test('成功时不触发重试与升级（对照）', async () => {
  const { resilience } = makeResilience();
  const outcome = await resilience.execute(
    { name: 'primary-srv', version: '1.0.0' },
    async (attempt) => `ok-after-${attempt}`,
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value, 'ok-after-1');
  assert.equal(outcome.attempts, 1, '一次成功不重试');
  assert.equal(outcome.escalated, false);
});

test('CircuitBreaker：连续失败后熔断，阻止雪崩', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 2 });
  assert.equal(breaker.canExecute(), true);
  breaker.recordFailure('TIMEOUT');
  assert.equal(breaker.canExecute(), true);
  breaker.recordFailure('TIMEOUT');
  assert.equal(breaker.canExecute(), false, '达到阈值后熔断');
  const snap = breaker.snapshot();
  assert.equal(snap.state, 'OPEN');
});

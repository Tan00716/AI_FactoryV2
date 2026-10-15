/**
 * AT-033 正式验收（逻辑层验收，非端到端）
 * 场景：限额事件触发时三策略各自成立（Compatible Fallback / Strict Provider /
 * Global Pause），且路由层的 fallback 在耗尽/隐私约束下生效。
 * 验收 API：packages/model-router 的 route（注入 fallbackChecker），
 * packages/quota 的 decideQuotaPolicy / checkFallbackCompatibility。
 * 本文件复用包公共 API 在进程内断言逻辑层语义，不覆盖真实模型/真实执行环境/
 * 真实生产等端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../../../packages/model-router/dist/src/index.js';
import {
  checkFallbackCompatibility,
  decideQuotaPolicy,
} from '../../../packages/quota/dist/src/index.js';

const AT_033_NOW = '2026-10-16T00:00:00.000Z'; // 与包内测试不同的固定时间戳

function quotaEvent(kind) {
  return {
    kind,
    bucket: {
      providerAccountId: 'acct-at033',
      workspaceId: 'ws-at033',
      limitBucket: 'codex:standard',
      authState: 'ok',
      collectedAt: AT_033_NOW,
      freshness: 'fresh',
    },
    observedAt: AT_033_NOW,
  };
}

function routeRequest(over = {}) {
  return {
    taskType: 'review',
    complexity: 2,
    requiredTools: [],
    latencyPref: 'low',
    costPref: 'low',
    privacy: 'public',
    needsReasoning: false,
    contextNeeded: 'small',
    needsVision: false,
    currentUsage: { usedPct: 12 },
    ...over,
  };
}

// ---- fallback 路由：耗尽 / 隐私约束下生效 ----

test('AT-033-1 共享池耗尽时 primary/fallback 退向本地：无静默假 fallback', () => {
  const d = route(routeRequest({ currentUsage: { usedPct: 100 } }));
  assert.equal(d.primary.model, 'local-private');
  assert.match(d.reason, /pool exhausted/);
  assert.match(d.reason, /shared across agents/);
  assert.ok(d.fallback, 'fallback 必须存在，不能静默缺席');
  assert.ok(
    d.fallback.model === 'local-private' || d.fallback.model === 'fast-classifier',
    `fallback 应为本地兜底，实际 ${d.fallback.model}`,
  );
});

test('AT-033-2 隐私约束：checker 拒绝非 local fallback → fallback 为 null 且具名', () => {
  const denyNonLocal = (_primary, candidate) =>
    candidate.model === 'local-private'
      ? { compatible: true, reasons: [] }
      : { compatible: false, reasons: [`${candidate.model} may not see restricted data`] };
  const d = route(
    routeRequest({ taskType: 'research', complexity: 3, fallbackChecker: denyNonLocal }),
  );
  assert.equal(d.fallback.model, 'local-private');
  // 全部拒绝时：宁可无 fallback 也不静默选一个不兼容的
  const denyAll = () => ({ compatible: false, reasons: ['blocked by privacy gate'] });
  const d2 = route(
    routeRequest({ taskType: 'research', complexity: 3, fallbackChecker: denyAll }),
  );
  assert.equal(d2.fallback, null);
  assert.match(d2.reason, /none compatible/);
  assert.match(d2.reason, /rejected \d+/);
});

test('AT-033-3 fallback 兼容检查：能力+隐私+预算+许可四维皆通过才算可用', () => {
  const good = checkFallbackCompatibility(
    {
      capabilities: ['tools'],
      dataClasses: ['internal'],
      budgetNeeded: 40,
      permissionCeiling: ['shell.execute'],
    },
    {
      providerAccountId: 'acct-at033-b',
      limitBucket: 'b-at033',
      capabilities: ['tools', 'vision'],
      allowedDataClasses: ['internal', 'public'],
      budgetRemaining: 200,
    },
  );
  assert.deepEqual(good.reasons, []);
  assert.ok(good.capabilityOk && good.privacyOk && good.budgetOk && good.permissionOk);

  // 隐私维度不满足：任务含 sensitive，fallback 只允许 public
  const privacyBad = checkFallbackCompatibility(
    { capabilities: ['tools'], dataClasses: ['sensitive'], budgetNeeded: 10, permissionCeiling: [] },
    {
      providerAccountId: 'acct-at033-b',
      limitBucket: 'b-at033',
      capabilities: ['tools'],
      allowedDataClasses: ['public'],
      budgetRemaining: 200,
    },
  );
  assert.equal(privacyBad.privacyOk, false);
  assert.ok(privacyBad.reasons.length > 0);
});

// ---- 三策略各成立 ----

test('AT-033-4 STRICT_PROVIDER：未知 reset → 停车等待，resetAt=null 如实声明', () => {
  const d = decideQuotaPolicy('STRICT_PROVIDER', quotaEvent('CREDITS_EXHAUSTED'), ['run-at033-1']);
  assert.equal(d.action, 'WAIT_FOR_RESET');
  assert.equal(d.resetAt, null);
  assert.match(d.note, /unknown/);
});

test('AT-033-5 STRICT_PROVIDER：已知 reset → 等待到该时间，不编造', () => {
  const event = quotaEvent('RATE_LIMITED_429');
  event.bucket.resetAt = '2026-10-16T08:00:00.000Z';
  const d = decideQuotaPolicy('STRICT_PROVIDER', event, ['run-at033-2']);
  assert.equal(d.action, 'WAIT_FOR_RESET');
  assert.equal(d.resetAt, '2026-10-16T08:00:00.000Z');
});

test('AT-033-6 ALLOW_COMPATIBLE_FALLBACK：并发限流事件 → FALLBACK_HANDOFF 迁移', () => {
  const d = decideQuotaPolicy('ALLOW_COMPATIBLE_FALLBACK', quotaEvent('CONCURRENCY_LIMIT'), [
    'run-at033-3',
  ]);
  assert.equal(d.action, 'FALLBACK_HANDOFF');
  assert.match(d.note, /capability\/privacy\/budget\/permission/);
});

test('AT-033-7 GLOBAL_PAUSE_ON_PRIMARY_LIMIT：主供应商受限 → 暂停开发域、安全域继续', () => {
  const d = decideQuotaPolicy('GLOBAL_PAUSE_ON_PRIMARY_LIMIT', quotaEvent('PROVIDER_OUTAGE'), [
    'run-at033-4',
  ]);
  assert.equal(d.action, 'PAUSE_DEV_DOMAIN');
  assert.match(d.note, /safety/i);
});

/**
 * AT-034 正式验收（逻辑层验收，非端到端）
 * 场景：Provider 未提供余额/reset 时 UI 层只能显示 unknown/stale，绝不编造百分比。
 * 验收 API：packages/quota 的 describeUsage / UnknownQuotaData。
 * 本文件复用包公共 API 在进程内断言逻辑层语义，不覆盖真实模型/真实执行环境/
 * 真实生产等端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeUsage,
  UnknownQuotaData,
} from '../../../packages/quota/dist/src/index.js';

const AT_034_NOW = '2026-10-16T01:00:00.000Z'; // 与包内测试不同的固定时间戳

function bucket(partial = {}) {
  return {
    providerAccountId: 'acct-at034',
    workspaceId: 'ws-at034',
    limitBucket: 'codex:standard',
    authState: 'ok',
    collectedAt: AT_034_NOW,
    freshness: 'fresh',
    ...partial,
  };
}

const NO_PCT = /\d+%/;

test('AT-034-1 provider 沉默（freshness=unknown）→ unknown，不编造百分比', () => {
  const s = describeUsage(bucket({ freshness: 'unknown' }));
  assert.match(s, /unknown/);
  assert.ok(!NO_PCT.test(s), `不得出现百分比数字：${s}`);
});

test('AT-034-2 数据过期（freshness=stale）且无数字 → unknown/stale，不编造', () => {
  const s = describeUsage(bucket({ freshness: 'stale' }));
  assert.ok(/unknown|stale/i.test(s), `应如实声明 unknown/stale：${s}`);
  assert.ok(!NO_PCT.test(s), `不得出现百分比数字：${s}`);
});

test('AT-034-3 provider 只给一半（缺 limit）→ unknown，不按半边数据推算', () => {
  const s = describeUsage(bucket({ used: 77 })); // 只有 used，没有 limit
  assert.match(s, /unknown/);
  assert.ok(!NO_PCT.test(s), `不得出现百分比数字：${s}`);
});

test('AT-034-4 provider 给了 used+limit → 允许显示真实百分比（反例对照）', () => {
  const s = describeUsage(bucket({ used: 45, limit: 90, windowStart: 'w0', windowEnd: 'w1' }));
  assert.ok(s.includes('45/90'), `应显示 45/90：${s}`);
  assert.ok(s.includes('50% used'), `应显示真实 50%：${s}`);
});

test('AT-034-5 UnknownQuotaData 拒绝为缺失的 reset 编造值', () => {
  assert.throws(() => {
    throw new UnknownQuotaData('reset timestamp');
  }, /refusing to fabricate/);
});

test('AT-034-6 UnknownQuotaData 携带 UNKNOWN_QUOTA_DATA 错误码，可被上游识别', () => {
  const err = new UnknownQuotaData('balance');
  assert.equal(err.code, 'UNKNOWN_QUOTA_DATA');
  assert.match(err.message, /balance/);
  assert.ok(err instanceof Error);
});

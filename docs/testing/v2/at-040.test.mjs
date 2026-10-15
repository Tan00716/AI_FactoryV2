/**
 * AT-040 正式验收（逻辑层验收，非端到端）
 *
 * 判定点：同一 Branch / Prod Env 上的并发写必须被锁/Lease 序列化 —
 * 锁互斥（同一时刻只有一名持有者）、冲突请求排队（不静默覆盖）、
 * 释放后按 FIFO 顺序自动授予等待者。
 *
 * 本文件复用 @ai-factory/coordination 包公共 API，在进程内断言逻辑层语义，
 * 不覆盖真实模型、真实执行环境、真实生产等端到端维度
 * （详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 *
 * 运行：cd <repo-root> && node --test docs/testing/v2/at-040.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LockManager } from '../../../packages/coordination/dist/src/index.js';

// 与包内自测刻意使用不同的锁主体/键/TTL，证明是独立验收而非复制。
const BRANCH = 'refs/heads/release-2.4';
const PROD_ENV = 'prod-eu-west';
const HOLDERS = ['writer-alpha', 'writer-beta', 'writer-gamma'];

function makeClock(start = 7_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('AT-040：同一 Branch 并发写被锁互斥', () => {
  it('两名并发写者同一 branch：先到获锁，后到被拒绝并排队', () => {
    const lm = new LockManager();
    const first = lm.acquire('branch', BRANCH, HOLDERS[0], 120_000);
    assert.equal(first.granted, true);
    assert.ok(first.token, 'granted lock must carry a token');

    const second = lm.acquire('branch', BRANCH, HOLDERS[1], 120_000);
    assert.equal(second.granted, false, 'concurrent write must NOT be granted');
    assert.equal(second.queued, true, 'rejected writer must be queued, not silently dropped');
    assert.equal(second.heldBy, HOLDERS[0], 'rejected writer sees the current holder');
    assert.deepEqual(lm.pendingWaiters('branch', BRANCH), [HOLDERS[1]]);
  });

  it('释放后排队者按 FIFO 自动获得锁', () => {
    const lm = new LockManager();
    const t0 = lm.acquire('branch', BRANCH, HOLDERS[0], 120_000).token;
    lm.acquire('branch', BRANCH, HOLDERS[1], 120_000);
    lm.acquire('branch', BRANCH, HOLDERS[2], 120_000);
    assert.deepEqual(lm.pendingWaiters('branch', BRANCH), [HOLDERS[1], HOLDERS[2]]);

    assert.equal(lm.release(t0), true);
    assert.equal(lm.isHeldBy('branch', BRANCH, HOLDERS[1]), true, 'FIFO: first waiter auto-granted');
    assert.deepEqual(lm.pendingWaiters('branch', BRANCH), [HOLDERS[2]]);
    assert.equal(lm.isHeldBy('branch', BRANCH, HOLDERS[2]), false, 'later waiter must still wait');
  });
});

describe('AT-040：Prod Env 并发写序列化 + Lease 到期', () => {
  it('同一 prod env 上锁只允许一名持有者，其余排队', () => {
    const lm = new LockManager();
    const holder = lm.acquire('environment', PROD_ENV, HOLDERS[0], 300_000);
    assert.equal(holder.granted, true);
    for (const h of [HOLDERS[1], HOLDERS[2]]) {
      const r = lm.acquire('environment', PROD_ENV, h, 300_000);
      assert.equal(r.granted, false);
      assert.equal(r.queued, true);
    }
    assert.deepEqual(lm.pendingWaiters('environment', PROD_ENV), [HOLDERS[1], HOLDERS[2]]);
  });

  it('lease TTL 到期后（注入时钟），新写者可获得序列化后的锁', () => {
    const clock = makeClock();
    const lm = new LockManager({ clock });
    const first = lm.acquire('environment', PROD_ENV, HOLDERS[0], 2_000);
    assert.equal(first.granted, true);
    clock.advance(2_001); // lease expired — no manual release needed
    const second = lm.acquire('environment', PROD_ENV, HOLDERS[1], 2_000);
    assert.equal(second.granted, true, 'expired lease must free the lock for the next writer');
    assert.equal(lm.isHeldBy('environment', PROD_ENV, HOLDERS[1]), true);
  });

  it('锁是按 key 隔离的：prod 被占时 staging 仍可并发写入', () => {
    const lm = new LockManager();
    const prod = lm.acquire('deployment', 'prod', 'release-bot-a', 300_000);
    assert.equal(prod.granted, true);
    const staging = lm.acquire('deployment', 'staging', 'release-bot-b', 60_000);
    assert.equal(staging.granted, true, 'different key must not be blocked by the prod lock');
    assert.equal(lm.isHeldBy('deployment', 'prod', 'release-bot-a'), true);
    assert.equal(lm.isHeldBy('deployment', 'staging', 'release-bot-b'), true);
  });

  it('prod deployment 只允许一个活跃持有者：第二个部署被拒绝并排队', () => {
    const lm = new LockManager();
    const first = lm.acquire('deployment', 'prod', 'release-bot-a', 300_000);
    assert.equal(first.granted, true);
    const second = lm.acquire('deployment', 'prod', 'release-bot-b', 300_000);
    assert.equal(second.granted, false, 'only one active PROD deployment holder');
    assert.equal(second.queued, true);
    lm.release(first.token);
    assert.equal(lm.isHeldBy('deployment', 'prod', 'release-bot-b'), true);
  });
});

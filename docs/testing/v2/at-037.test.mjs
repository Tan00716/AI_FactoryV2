/**
 * AT-037 正式验收（逻辑层验收，非端到端）
 * 场景：Worker A 的 lease 过期后 B 接管，A 迟到完成 → A 的写入被拒绝。
 * 验收 API：packages/leases 的 LeaseManager / StaleOwnerError / LeaseConflictError。
 * 本文件复用包公共 API 在进程内断言逻辑层语义，不覆盖真实模型/真实执行环境/
 * 真实生产等端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LeaseConflictError,
  LeaseManager,
  StaleOwnerError,
} from '../../../packages/leases/dist/src/index.js';

function harness() {
  let now = 1_731_000_000_000; // 与包内测试不同的固定时钟
  const mgr = new LeaseManager({ now: () => now });
  const advance = (ms) => { now += ms; };
  return { mgr, advance };
}

test('AT-037-1 acquire 给出单 writer：generation=1，fencing_token=1', () => {
  const { mgr } = harness();
  const l = mgr.acquire('ws:at037', 'run-A', 60_000);
  assert.equal(l.generation, 1);
  assert.equal(l.fencing_token, 1);
  assert.equal(l.owner_run_id, 'run-A');
});

test('AT-037-2 租约持有期间第二个 acquire 冲突：B 不能抢写', () => {
  const { mgr } = harness();
  mgr.acquire('ws:at037', 'run-A', 60_000);
  assert.throws(() => mgr.acquire('ws:at037', 'run-B', 60_000), LeaseConflictError);
});

test('AT-037-3 lease 过期 → A 的 token 变 STALE_OWNER，资源可被 B 接管', () => {
  const { mgr, advance } = harness();
  const la = mgr.acquire('ws:at037', 'run-A', 1_000);
  advance(2_000); // 过期
  assert.throws(
    () => mgr.validate('ws:at037', la.fencing_token),
    (err) => err instanceof StaleOwnerError && err.reasonCode === 'STALE_OWNER',
  );
  const lb = mgr.acquire('ws:at037', 'run-B', 60_000);
  assert.equal(lb.owner_run_id, 'run-B');
});

test('AT-037-4 A 迟到完成：B 接管后 A 用旧 token 的写入被拒绝（fencing 生效）', () => {
  const { mgr } = harness();
  const la = mgr.acquire('ws:at037', 'run-A', 60_000);
  const lb = mgr.reassign('ws:at037', 'run-B', 60_000); // B 接管，token 递增
  // A 此时才"完成"并尝试写入 —— 旧 token 已被 fencing 淘汰，必须被拒绝
  assert.throws(
    () => mgr.validate('ws:at037', la.fencing_token),
    (err) => err instanceof StaleOwnerError && err.reasonCode === 'STALE_OWNER',
  );
  assert.equal(mgr.validate('ws:at037', lb.fencing_token).owner_run_id, 'run-B');
});

test('AT-037-5 reassign 递增 fencing_token：旧 token 失效，新 owner 可写', () => {
  const { mgr } = harness();
  const l1 = mgr.acquire('ws:at037', 'run-A', 60_000);
  const l2 = mgr.reassign('ws:at037', 'run-B', 60_000);
  assert.equal(l2.fencing_token, l1.fencing_token + 1);
  assert.throws(
    () => mgr.validate('ws:at037', l1.fencing_token),
    (err) => err instanceof StaleOwnerError && err.reasonCode === 'STALE_OWNER',
  );
  assert.equal(mgr.validate('ws:at037', l2.fencing_token).owner_run_id, 'run-B');
});

test('AT-037-6 fencing 单调递增：多轮接管后只有最新 token 有效', () => {
  const { mgr } = harness();
  mgr.acquire('ws:at037', 'run-A', 60_000);
  const tokens = ['run-B', 'run-C'].map((o) => mgr.reassign('ws:at037', o, 60_000).fencing_token);
  assert.deepEqual(tokens, [2, 3]);
  assert.throws(() => mgr.validate('ws:at037', 1), StaleOwnerError);
  assert.throws(() => mgr.validate('ws:at037', 2), StaleOwnerError);
  assert.equal(mgr.validate('ws:at037', 3).owner_run_id, 'run-C');
});

test('AT-037-7 续约用错 token → StaleOwnerError：伪造续约不可行', () => {
  const { mgr } = harness();
  const l = mgr.acquire('ws:at037', 'run-A', 1_000);
  assert.throws(() => mgr.renew(l.id, 424242, 60_000), StaleOwnerError);
});

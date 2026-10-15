/**
 * AT-035 正式验收（逻辑层验收，非端到端）
 * 场景：长测/等审批/断心跳/真死循环的 Watchdog 分类：
 * WAITING / HEALTHY / SUSPECTED_STALL / STALLED / loop-stagnation。
 * 验收 API：packages/watchdog 的 Watchdog / DEFAULT_HEARTBEAT_CONFIG。
 * 本文件复用包公共 API 在进程内断言逻辑层语义，不覆盖真实模型/真实执行环境/
 * 真实生产等端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HEARTBEAT_CONFIG,
  Watchdog,
} from '../../../packages/watchdog/dist/src/index.js';

function harness() {
  let now = 1_731_000_000_000; // 与包内测试不同的固定时钟起点
  const w = new Watchdog([], { now: () => now });
  const advance = (ms) => { now += ms; };
  return { w, advance };
}

test('AT-035-1 心跳阈值工程默认值：5s 间隔 / 3 次缺失 / 60s 判定', () => {
  assert.equal(DEFAULT_HEARTBEAT_CONFIG.intervalMs, 5_000);
  assert.equal(DEFAULT_HEARTBEAT_CONFIG.missLimit, 3);
  assert.equal(DEFAULT_HEARTBEAT_CONFIG.stallAfterMs, 60_000);
});

test('AT-035-2 3 次连续心跳缺失 → SUSPECTED_STALL（疑似停滞，非直接判死）', () => {
  const { w, advance } = harness();
  w.registerWorker('at035-suspect');
  w.heartbeat('at035-suspect');
  advance(16_000); // 超过 3 个 5s 周期
  w.tick();
  const s = w.getStatus('at035-suspect');
  assert.equal(s.consecutiveMisses, 3);
  assert.equal(s.health, 'SUSPECTED_STALL');
});

test('AT-035-3 断心跳但可重连：60s 静默 → 仍是 SUSPECTED_STALL 而非 STALLED', () => {
  const { w, advance } = harness();
  w.registerWorker('at035-reconnectable');
  w.heartbeat('at035-reconnectable');
  // 默认 reconnectable：断心跳 61s 也不能判死
  advance(61_000);
  w.tick();
  assert.equal(w.getStatus('at035-reconnectable').health, 'SUSPECTED_STALL');
});

test('AT-035-4 真死：60s 静默 + 不可重连 → STALLED，诊断 worker-lost', () => {
  const { w, advance } = harness();
  w.registerWorker('at035-dead');
  w.heartbeat('at035-dead');
  w.setReconnectable('at035-dead', false);
  advance(62_000);
  w.tick();
  const s = w.getStatus('at035-dead');
  assert.equal(s.health, 'STALLED');
  assert.equal(s.diagnosis, 'worker-lost');
});

test('AT-035-5 真死循环：loopStagnated 信号 → 诊断 loop-stagnation', () => {
  const { w } = harness();
  w.registerWorker('at035-loop');
  w.reportSignals('at035-loop', { loopStagnated: true });
  assert.equal(w.diagnose('at035-loop').diagnosis, 'loop-stagnation');
});

test('AT-035-6 等审批：approval-wait 120s 无心跳 → 保持 WAITING，不误判停滞', () => {
  const { w, advance } = harness();
  w.registerWorker('at035-approval');
  w.heartbeat('at035-approval');
  w.reportSignals('at035-approval', { approvalWait: true, explicitState: 'WAITING' });
  advance(120_000);
  w.tick();
  const s = w.getStatus('at035-approval');
  assert.equal(s.health, 'WAITING');
  assert.equal(s.diagnosis, 'approval-wait');
});

test('AT-035-7 suspected 期间收到心跳 → RECOVERING（给复活机会，不直接杀）', () => {
  const { w, advance } = harness();
  w.registerWorker('at035-recover');
  w.heartbeat('at035-recover');
  advance(16_000);
  w.tick();
  assert.equal(w.getStatus('at035-recover').health, 'SUSPECTED_STALL');
  w.heartbeat('at035-recover');
  assert.equal(w.getStatus('at035-recover').health, 'RECOVERING');
});

test('AT-035-8 正常心跳的 worker → HEALTHY（健康基准对照）', () => {
  const { w, advance } = harness();
  w.registerWorker('at035-healthy');
  w.heartbeat('at035-healthy');
  advance(4_000);
  w.tick();
  assert.equal(w.getStatus('at035-healthy').health, 'HEALTHY');
});

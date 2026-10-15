/**
 * AT-036 正式验收（逻辑层验收，非端到端）
 * 场景：Human Take Control 后旧 Worker 恢复 → 旧写入被 fence，无静默覆盖；
 * 人工修改带归属、基于快照基线，无静默覆盖。
 * 验收 API：packages/takeover 的 TakeoverManager，
 * packages/leases 的 LeaseManager。
 * 本文件复用包公共 API 在进程内断言逻辑层语义，不覆盖真实模型/真实执行环境/
 * 真实生产等端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeaseManager } from '../../../packages/leases/dist/src/index.js';
import {
  SilentOverwriteRefused,
  TakeoverError,
  TakeoverManager,
} from '../../../packages/takeover/dist/src/index.js';

function setup() {
  const leases = new LeaseManager({ now: () => 1_731_000_000_000 }); // 与包内测试不同的固定时钟
  const mgr = new TakeoverManager(leases, {
    quiesceWorker: async () => {},
    noUncontrolledWrites: async () => true,
    snapshot: async (runId) => `at036-snap:${runId}`,
    threeWayMerge: async (files) => files.map((f) => `${f}:merged`),
    revalidateEvidence: async (ids) => ids.map((id) => `${id}:revalidated`),
  });
  const aiLease = leases.acquire('ws:at036', 'run-at036-ai', 600_000);
  return { leases, mgr, aiLease };
}

test('AT-036-1 接管成功后显示 CONTROL_ACQUIRED，fenced generation 递增', async () => {
  const { mgr } = setup();
  const t0 = mgr.requestTakeover('run-at036-ai', 'ws:at036', 'human:tan');
  assert.equal(mgr.display(t0.id), 'TAKEOVER_PENDING');
  const t1 = await mgr.acquireControl(t0.id);
  assert.equal(t1.state, 'HUMAN_OWNED');
  assert.equal(mgr.display(t0.id), 'CONTROL_ACQUIRED');
  assert.equal(t1.fencedGeneration, 2); // generation 已越过 AI worker 的 1
});

test('AT-036-2 takeover 后旧 worker 的迟到写入被 fence：SilentOverwriteRefused', async () => {
  const { mgr, aiLease } = setup();
  const t0 = mgr.requestTakeover('run-at036-ai', 'ws:at036', 'human:tan');
  await mgr.acquireControl(t0.id);
  // 旧 AI 的 fencing token 已死：恢复后的写入必须被拒绝，无静默覆盖
  assert.throws(
    () => mgr.assertAiWriteAllowed('ws:at036', aiLease.fencing_token, 'src/app.ts'),
    SilentOverwriteRefused,
  );
});

test('AT-036-3 人工修改带 HUMAN 归属，基于快照基线成功落盘', async () => {
  const { mgr } = setup();
  const t0 = mgr.requestTakeover('run-at036-ai', 'ws:at036', 'human:tan');
  const t1 = await mgr.acquireControl(t0.id);
  const t2 = mgr.applyHumanEdit(t0.id, {
    authorId: 'human:tan',
    baseRevision: t1.snapshotRef,
    fileHashes: { 'src/app.ts': 'at036-hash' },
    diff: '+ fix race',
  });
  assert.equal(t2.humanEdits[0].authorType, 'HUMAN');
  assert.equal(t2.humanEdits[0].authorId, 'human:tan');
});

test('AT-036-4 未到 HUMAN_OWNED 状态的人工修改被拒绝（TakeoverError）', async () => {
  const { mgr } = setup();
  const t0 = mgr.requestTakeover('run-at036-ai', 'ws:at036', 'human:tan');
  assert.throws(
    () =>
      mgr.applyHumanEdit(t0.id, {
        authorId: 'human:tan',
        baseRevision: 'at036-snap:run-at036-ai',
        fileHashes: {},
        diff: '',
      }),
    TakeoverError,
  );
});

test('AT-036-5 基于过期快照基线的人工修改被拒绝：STALE_EDIT_BASE，无静默覆盖', async () => {
  const { mgr } = setup();
  const t0 = mgr.requestTakeover('run-at036-ai', 'ws:at036', 'human:tan');
  await mgr.acquireControl(t0.id);
  assert.throws(
    () =>
      mgr.applyHumanEdit(t0.id, {
        authorId: 'human:tan',
        baseRevision: 'stale-base-at036',
        fileHashes: {},
        diff: '',
      }),
    (err) => err.code === 'STALE_EDIT_BASE',
  );
});

test('AT-036-6 writer 未安静时绝不虚假显示已接管（display ≠ CONTROL_ACQUIRED）', async () => {
  const leases = new LeaseManager({ now: () => 1_731_000_000_000 });
  const mgr = new TakeoverManager(leases, {
    quiesceWorker: async () => {},
    noUncontrolledWrites: async () => false, // 仍有未受控写入
    snapshot: async (runId) => `at036-snap:${runId}`,
    threeWayMerge: async (files) => files,
    revalidateEvidence: async (ids) => ids,
  });
  leases.acquire('ws:at036', 'run-at036-ai', 600_000);
  const t0 = mgr.requestTakeover('run-at036-ai', 'ws:at036', 'human:tan');
  const t1 = await mgr.acquireControl(t0.id);
  assert.equal(t1.state, 'FAILED');
  assert.notEqual(mgr.display(t0.id), 'CONTROL_ACQUIRED');
});

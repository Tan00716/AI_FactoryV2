/**
 * AT-046 正式验收（逻辑层验收，非端到端）
 *
 * 判定点：审批通过后，若绑定的 Candidate/Artifact 内容变更（candidate_digest
 * 变化），旧审批必须失效（INVALIDATED），不能再产生可用的证据载荷。
 *
 * 本文件复用 @ai-factory/approvals 包公共 API，在进程内断言逻辑层语义：
 * 绑定上下文变更 → 旧审批失效。不覆盖真实模型、真实执行环境、真实生产等
 * 端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 *
 * 运行：cd <repo-root> && node --test docs/testing/v2/at-046.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalManager,
  ApprovalNotApprovedError,
  InMemoryApprovalStore,
} from '../../../packages/approvals/dist/src/index.js';

function makeManager() {
  const manager = new ApprovalManager(new InMemoryApprovalStore(), {
    policyVersion: 'at046-v2',
  });
  return manager;
}

// 与包内自测使用的数据刻意不同：不同的 action / digest / risk。
const BINDING = {
  candidate_digest: 'sha256:at046-artifact-v1',
  evidence_manifest_hash: 'sha256:at046-manifest-v1',
  policy_version: 'at046-v2',
  environment: 'canary',
  risk_level: 'CRITICAL',
  reversibility_ref: '',
};

function approvedDeploy(manager) {
  const a = manager.request({
    action: 'deploy.canary',
    requester: 'at046-agent',
    task_id: 'at046-task',
    candidate_digest: BINDING.candidate_digest,
    environment: BINDING.environment,
    evidence_manifest_hash: BINDING.evidence_manifest_hash,
    risk_level: 'CRITICAL',
  });
  const decided = manager.decide(a.approval_id, {
    approved: true,
    decided_by: 'human:at046',
    decision_reason: 'canary green, approve v1',
  });
  assert.equal(decided.status, 'APPROVED');
  return decided;
}

describe('AT-046：审批后修改 Candidate/Artifact → 旧审批失效', () => {
  it('candidate_digest 变更后旧审批 INVALIDATE', () => {
    const manager = makeManager();
    const decided = approvedDeploy(manager);
    const r = manager.invalidate(decided.approval_id, {
      ...BINDING,
      candidate_digest: 'sha256:at046-artifact-v2', // 工件被修改
    });
    assert.equal(r.invalidated, true);
    assert.deepEqual(r.changed, ['candidate_digest']);
    assert.equal(manager.get(decided.approval_id).status, 'INVALIDATED');
  });

  it('失效后旧审批不再产生证据载荷（不能用于放行执行）', () => {
    const manager = makeManager();
    const decided = approvedDeploy(manager);
    manager.invalidate(decided.approval_id, {
      ...BINDING,
      candidate_digest: 'sha256:at046-artifact-v2',
    });
    assert.throws(
      () => manager.approvalEvidencePayload(manager.get(decided.approval_id)),
      ApprovalNotApprovedError,
    );
    assert.equal(
      manager.isUsable(decided, { ...BINDING, candidate_digest: 'sha256:at046-artifact-v2' }),
      false,
    );
  });

  it('evidence_manifest_hash 变更同样独立触发失效', () => {
    const manager = makeManager();
    const decided = approvedDeploy(manager);
    const r = manager.invalidate(decided.approval_id, {
      ...BINDING,
      evidence_manifest_hash: 'sha256:at046-manifest-v2',
    });
    assert.equal(r.invalidated, true);
    assert.deepEqual(r.changed, ['evidence_manifest_hash']);
    assert.equal(manager.get(decided.approval_id).status, 'INVALIDATED');
  });

  it('绑定上下文未变更时审批保持可用（不误伤）', () => {
    const manager = makeManager();
    const decided = approvedDeploy(manager);
    const r = manager.invalidate(decided.approval_id, BINDING);
    assert.equal(r.invalidated, false);
    assert.deepEqual(r.changed, []);
    assert.equal(manager.get(decided.approval_id).status, 'APPROVED');
    assert.equal(manager.isUsable(decided, BINDING), true);
  });

  it('失效保留原审批决定历史（decision 仍为 APPROVED）', () => {
    const manager = makeManager();
    const decided = approvedDeploy(manager);
    manager.invalidate(decided.approval_id, {
      ...BINDING,
      candidate_digest: 'sha256:at046-artifact-v2',
    });
    const stored = manager.get(decided.approval_id);
    assert.equal(stored.status, 'INVALIDATED');
    assert.equal(stored.decision, 'APPROVED', '历史决定保留，但状态已不可用');
    assert.ok(stored.decided_by, 'decider 记录保留');
  });
});

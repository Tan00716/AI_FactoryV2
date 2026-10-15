/**
 * AT-023 正式验收（逻辑层验收，非端到端）
 * 场景：Agent 自由文本声称"100%通过"——无可信 Evidence 时 Quality Gate 不得通过。
 * 验收 API：packages/core 的 EvidenceV2Engine / InMemoryEvidenceV2Store / evaluateGateV2。
 * 本文件复用包公共 API 在进程内断言逻辑层语义，不覆盖真实模型/真实执行环境/
 * 真实生产等端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EvidenceV2Engine,
  GateEvaluatorForbiddenError,
  InMemoryEvidenceV2Store,
  evaluateGateV2,
} from '../../../packages/core/dist/src/index.js';

const NOW = 1_712_000_000_000; // 与包内测试不同的固定时钟
const SYS = { kind: 'SYSTEM', id: 'gate-evaluator' };
const AI = { kind: 'AI', id: 'agent-claiming-pass' };

function engine() {
  return new EvidenceV2Engine(new InMemoryEvidenceV2Store(), { now: () => NOW });
}

function baseInput(over = {}) {
  return {
    type: 'qa_result',
    requirement_version: 'REQ-AT023@1',
    ac_refs: ['AC-SUMMARY'],
    task_id: 'TASK-AT23',
    run_id: 'RUN-AT23',
    candidate_revision: 'cand-23',
    environment_fingerprint: 'env-dev-23',
    collector_identity: 'qa-runner-23',
    exit_code: 0,
    result_summary: {
      test_kind: 'test-result',
      total: 40, passed: 40, failed: 0, skipped: 0,
      ac_results: [{ ac_id: 'AC-SUMMARY', passed: true }],
    },
    ...over,
  };
}

function gateDef(over = {}) {
  return {
    gate_id: 'GATE-AT23',
    mandatory_ac_ids: ['AC-SUMMARY'],
    max_failed: 0,
    max_skipped: 0,
    require_independent_review: false,
    max_finding_severity: 'LOW',
    freshness_ms: null,
    ...over,
  };
}

test('trust 未声明时默认 UNVERIFIED：自述通过≠可信证据', () => {
  const e = engine();
  const r = e.create(baseInput({ trust_level: undefined }));
  assert.equal(r.trust_level, 'UNVERIFIED');
});

test('Agent 自由文本"100%通过"但没有证据记录 → Gate 不过', () => {
  const ev = evaluateGateV2(gateDef(), [], new Map(), SYS, NOW);
  assert.equal(ev.verdict, 'BLOCKED');
});

test('缺证据时 verdict=BLOCKED 且 reason_code=MISSING_EVIDENCE，并指名缺失的 AC', () => {
  const ev = evaluateGateV2(gateDef(), [], new Map(), SYS, NOW);
  assert.equal(ev.verdict, 'BLOCKED');
  assert.equal(ev.reason_code, 'MISSING_EVIDENCE');
  assert.deepEqual(ev.missing, ['AC-SUMMARY']);
});

test('Agent 不能自写裁决：自由文本永远写不出 PASSED verdict', () => {
  for (const caller of [AI, { kind: 'HUMAN', id: 'tan' }, { kind: 'SERVICE', id: 'svc' }]) {
    assert.throws(
      () => evaluateGateV2(gateDef(), [], new Map(), caller, NOW),
      GateEvaluatorForbiddenError,
    );
  }
});

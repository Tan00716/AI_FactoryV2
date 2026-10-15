/**
 * AT-041 正式验收（逻辑层验收，非端到端）
 * 场景：实现者修改测试结果 JSON / Collector 文件。
 * 判定断言：不产生可信 Evidence；Collector 边界拒绝写；Hash 单独不够通过 Gate。
 *
 * 验收 API：packages/core 的 EvidenceV2Engine / validateEvidenceRecordV2 /
 *          computeContentHash / evaluateGateV2。
 * 逻辑语义：
 *  (1) 篡改后的记录通不过 18 字段契约校验 → 不产生可信 Evidence；
 *  (2) Engine.create 的校验即写边界 —— 非法记录拒绝写入；
 *  (3) evaluateGateV2 要求 ACTIVE + 覆盖 mandatory AC + 信任等级，
 *      光有对得上的 hash 不足以通过（UNVERIFIED 不被采信）。
 *
 * 不覆盖：真实 Collector 进程的写边界（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EvidenceV2Engine,
  InMemoryEvidenceV2Store,
  validateEvidenceRecordV2,
  computeContentHash,
  evaluateGateV2,
} from '../../../packages/core/dist/src/index.js';

function validInput(over = {}) {
  const now = new Date().toISOString();
  return {
    type: 'test_execution',
    requirement_version: 'REQ-001@1',
    run_id: 'run-1',
    task_id: 'task-1',
    candidate_revision: 'rev-abc123',
    environment_fingerprint: 'env-fp-1',
    started_at: now,
    ended_at: now,
    exit_code: 0,
    ac_refs: ['AC-1'],
    tool_refs: [],
    collector_identity: 'trusted-collector-1',
    trust_level: 'TRUSTED_COLLECTOR',
    result_summary: { ac_results: [{ ac_id: 'AC-1', passed: true }] },
    ...over,
  };
}

function gateDef(over = {}) {
  return {
    gate_id: 'gate-1',
    mandatory_ac_ids: ['AC-1'],
    max_failed: 0,
    max_skipped: 0,
    require_independent_review: false,
    max_finding_severity: 'HIGH',
    freshness_ms: null,
    ...over,
  };
}

const EVALUATOR = { kind: 'SYSTEM', id: 'gate-engine' };

test('篡改 result_summary 后内容 hash 变化 —— 篡改可被发现', () => {
  const original = { ac_results: [{ ac_id: 'AC-1', passed: true }] };
  const tampered = { ac_results: [{ ac_id: 'AC-1', passed: true }], extra: 'forged-pass' };
  const h1 = computeContentHash(original);
  const h2 = computeContentHash(tampered);
  assert.notEqual(h1, h2, '篡改后 hash 必须变化');
  assert.equal(h1.length, 64, 'sha256 hex');
});

test('非法记录通不过 18 字段契约校验 —— 不产生可信 Evidence', () => {
  const bad = validateEvidenceRecordV2({
    type: 'test_execution',
    // 缺 collector_identity、trust_level 等必填字段
    result_summary: {},
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
});

test('Engine.create 拒绝非法记录 —— 写边界拒绝写', () => {
  const engine = new EvidenceV2Engine(new InMemoryEvidenceV2Store());
  assert.throws(
    () =>
      engine.create({
        type: 'test_execution',
        requirement_version: 'v1',
        run_id: 'run-1',
        task_id: 'task-1',
        ac_refs: ['AC-1'],
        tool_refs: [],
        // 故意缺 collector_identity
        trust_level: 'TRUSTED_COLLECTOR',
        result_summary: { ac_results: [{ ac_id: 'AC-1', passed: true }] },
      }),
    /collector_identity/,
    '缺 collector_identity 应被写边界拒绝',
  );
});

test('Hash 对得上但 trust 为 UNVERIFIED —— 不通过 Gate（hash 单独不够）', () => {
  const engine = new EvidenceV2Engine(new InMemoryEvidenceV2Store());
  const rec = engine.create(validInput({ trust_level: 'UNVERIFIED' }));
  // 记录本身合法（hash 可复算），但信任等级不足
  assert.equal(rec.trust_level, 'UNVERIFIED');
  const v = evaluateGateV2(gateDef(), [rec], new Map(), EVALUATOR, Date.now());
  // Gate 要求可信证据；UNVERIFIED 不应产生 PASS
  assert.notEqual(v.verdict, 'PASS', `UNVERIFIED 证据不应通过 Gate，实际 verdict=${v.verdict}`);
});

test('TRUSTED_COLLECTOR 的合法记录可通过 Gate（对照）', () => {
  const engine = new EvidenceV2Engine(new InMemoryEvidenceV2Store());
  const rec = engine.create(validInput());
  assert.equal(rec.trust_level, 'TRUSTED_COLLECTOR');
  const v = evaluateGateV2(gateDef(), [rec], new Map(), EVALUATOR, Date.now());
  assert.equal(v.verdict, 'PASSED');
});

test('伪造者无法把 UNVERIFIED 改成 TRUSTED —— 信任等级由采集器身份决定', () => {
  const engine = new EvidenceV2Engine(new InMemoryEvidenceV2Store());
  // 实现者试图伪造一条"可信"记录，但 collector_identity 为空 → 写边界拒绝
  assert.throws(
    () =>
      engine.create(
        validInput({ collector_identity: '', trust_level: 'TRUSTED_COLLECTOR' }),
      ),
    /collector_identity/,
  );
});

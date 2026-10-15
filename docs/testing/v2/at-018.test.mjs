/**
 * AT-018 正式验收（逻辑层验收，非端到端）
 * 场景：下属 Agent 发现 Manager 绕过 Security Gate → 越级上报人类，Manager 不能屏蔽该上报。
 * 验收 API：packages/autonomy 的 needsHuman / evaluateEscalation / isHumanNeedReason。
 * 本文件复用包公共 API 在进程内断言逻辑层语义，不覆盖真实模型/真实执行环境/
 * 真实生产等端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateEscalation,
  isHumanNeedReason,
  needsHuman,
} from '../../../packages/autonomy/dist/src/index.js';

const NOW = 1_731_000_000_000; // 与包内测试不同的固定时钟
const now = () => NOW;

test('下属上报 security-issue 触发器被标记为 critical', () => {
  const rec = needsHuman('security-issue', {
    now,
    detail: 'manager-2 deployed to prod bypassing security gate SG-7',
    context: { reporter: 'agent-subordinate-9', managerId: 'manager-2', gateId: 'SG-7' },
  });
  assert.equal(rec.reason, 'security-issue');
  assert.equal(rec.severity, 'critical');
});

test('生成完整的越级上报记录（id / 中文理由 / 时间戳 / 上下文可审计）', () => {
  const rec = needsHuman('security-issue', {
    now,
    detail: 'manager-2 绕过安全门 SG-7 直连生产部署',
    context: { reporter: 'agent-subordinate-9', evidenceRef: 'ev-deploy-log-552' },
  });
  assert.ok(typeof rec.id === 'string' && rec.id.length > 0);
  assert.ok(rec.reasonZh.length > 0);
  assert.equal(rec.detail, 'manager-2 绕过安全门 SG-7 直连生产部署');
  assert.deepEqual(rec.context, { reporter: 'agent-subordinate-9', evidenceRef: 'ev-deploy-log-552' });
  assert.equal(rec.detectedAt, new Date(NOW).toISOString());
});

test('security-issue 必然生成上报记录，Manager 无法通过改名/改写来屏蔽', () => {
  const rec = evaluateEscalation('security-issue', { now });
  assert.ok(rec !== null, 'known trigger must always produce a record');
  assert.equal(rec.reason, 'security-issue');
  assert.equal(rec.severity, 'critical');
  assert.equal(isHumanNeedReason('security-issue'), true);
});

test('未知理由不误报：不生成记录也不被误认为合法触发器', () => {
  // 试图把上报伪装成"经理已批准"之类的新理由——不被识别。
  assert.equal(evaluateEscalation('manager-approved-bypass', { now }), null);
  assert.equal(evaluateEscalation('bypass-security-gate', { now }), null);
  assert.equal(evaluateEscalation('', { now }), null);
  assert.equal(isHumanNeedReason('manager-approved-bypass'), false);
  assert.equal(isHumanNeedReason(''), false);
});

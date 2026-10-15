/**
 * AT-045 正式验收（逻辑层验收，非端到端）
 *
 * 判定点：从 UI / Error / Screenshot / Export 等输出面找凭证时，
 * 原始秘密永远不得出现在输出中 — SecretRef 只以引用形式存在，
 * 文本与对象载荷在对外前必须脱敏。
 *
 * 本文件复用 @ai-factory/security 与 @ai-factory/events 包公共 API，
 * 在进程内断言逻辑层语义，不覆盖真实模型、真实执行环境、
 * 真实生产等端到端维度（详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 *
 * 运行：cd <repo-root> && node --test docs/testing/v2/at-045.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SecretRef,
  redactDeep,
  redactSecrets as redactSecretText,
} from '../../../packages/security/dist/src/index.js';
import {
  REDACTED,
  redactSecrets as redactSecretObject,
  redactText,
} from '../../../packages/events/dist/src/index.js';

// 与包内自测刻意使用不同的秘密值/载荷形状，证明是独立验收而非复制。
const BEARER = 'eyJhdXQ6YXQwNDUtYmVhcmVyLXRva2Vu';
const DB_PASS = 'p-ss-at045-db-9x';
const API_KEY = 'sk-at045-live-9f8b7a6c5d4e';

describe('AT-045：凭证永不泄漏到输出', () => {
  it('SecretRef 不经 toString/模板插值泄漏原始值', () => {
    const s = SecretRef.create('at045-deploy-key');
    assert.equal(String(s), '***');
    assert.equal(`token=${s}`, 'token=***');
  });

  it('SecretRef 经 JSON.stringify 不泄漏：只有 secret:// 引用', () => {
    const s = SecretRef.create('at045-deploy-key');
    const raw = s.deref(() => 'at045-raw-secret-value');
    const json = JSON.stringify({ secret: s });
    assert.ok(!json.includes(raw), 'raw secret must never appear in serialized output');
    assert.ok(json.includes('secret://at045-deploy-key'), 'reference form is the safe shape');
  });

  it('文本脱敏：Bearer token 被替换，原始秘密不在输出', () => {
    const out = redactSecretText(`Authorization: Bearer ${BEARER}`);
    assert.equal(out, 'Authorization: Bearer ***');
    assert.ok(!out.includes(BEARER));
  });

  it('文本脱敏：password= 赋值与 URL 内嵌密码被替换', () => {
    const out1 = redactSecretText(`db password=${DB_PASS} ok`);
    assert.equal(out1, 'db password=*** ok');
    const out2 = redactSecretText(`https://ops:${DB_PASS}@db.internal/app`);
    assert.equal(out2, 'https://ops:***@db.internal/app');
    assert.ok(!out1.includes(DB_PASS) && !out2.includes(DB_PASS));
  });
});

describe('AT-045：事件/错误载荷脱敏后不含原始秘密', () => {
  it('对象脱敏：password/api_key（大小写不敏感、嵌套）→ REDACTED，非敏感字段保留', () => {
    const out = redactSecretObject({
      user: 'operator-7',
      password: DB_PASS,
      nested: { API_KEY: API_KEY, retries: 2 },
    });
    assert.equal(out.user, 'operator-7');
    assert.equal(out.password, REDACTED);
    assert.equal(out.nested.API_KEY, REDACTED);
    assert.equal(out.nested.retries, 2);
    assert.ok(!JSON.stringify(out).includes(DB_PASS));
    assert.ok(!JSON.stringify(out).includes(API_KEY));
  });

  it('对象脱敏不突变原始输入', () => {
    const input = { service: 'billing', Api_Token: 'tok-at045' };
    const out = redactSecretObject(input);
    assert.notEqual(out, input);
    assert.equal(input.Api_Token, 'tok-at045', 'input must be untouched');
    assert.equal(out.Api_Token, REDACTED);
  });

  it('redactText：key=value 形式的 api_key 被脱敏，原始值不在输出', () => {
    const out = redactText(`login failed for api_key=${API_KEY}; user=operator-7`);
    assert.ok(out.includes('api_key=' + REDACTED));
    assert.ok(out.includes('user=operator-7'));
    assert.ok(!out.includes(API_KEY));
  });

  it('模拟 UI 导出载荷（error + screenshot 元数据）经 redactDeep 后无原始秘密', () => {
    const exportPayload = {
      view: 'error-console',
      error: {
        message: `deploy rejected: Authorization: Bearer ${BEARER}`,
        stack: `at push (deploy.js:42) Bearer ${BEARER}`,
      },
      // 秘密以可脱敏的文本模式出现（URL 内嵌密码），而非裸值
      screenshot: { path: 'shots/at045-err.png', dsn: `https://ops:${DB_PASS}@db.internal/app` },
    };
    const cleaned = redactDeep(exportPayload);
    const serialized = JSON.stringify(cleaned);
    assert.ok(!serialized.includes(BEARER), 'bearer token must not survive in export');
    assert.ok(!serialized.includes(DB_PASS), 'db password must not survive in export');
    assert.equal(cleaned.view, 'error-console', 'non-sensitive business fields are preserved');
    assert.equal(cleaned.screenshot.path, 'shots/at045-err.png');
  });
});

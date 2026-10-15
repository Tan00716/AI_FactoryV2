/**
 * AT-053 正式验收（逻辑层验收，非端到端）
 *
 * 判定点：跨项目员工检索 Memory / 已撤销访问 —— Scope 过滤、无串项目。
 *   1. 无权跨项目检索被拒绝（条目绝不返回）；
 *   2. 分类过滤：请求者 clearance 看不到高于其密级的条目；
 *   3. 跨项目复用只发生在 crossProjectReusable 允许且授权的条目上。
 *
 * 本文件复用 @ai-factory/memory 包公共 API，在进程内断言逻辑层语义。不覆盖
 * 真实模型、真实执行环境、真实生产等端到端维度
 * （详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 *
 * 运行：cd <repo-root> && node --test docs/testing/v2/at-053.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryStore,
} from '../../../packages/memory/dist/src/index.js';

function makeStore() {
  let now = 2_000_000;
  return {
    store: new MemoryStore({ now: () => now }),
    advance: (ms) => { now += ms; },
  };
}

// 与包内自测的数据刻意不同：项目名 / 标题 / 来源全部换新。
function entry(partial = {}) {
  return {
    scope: 'project',
    scopeId: 'proj-gamma',
    type: 'Lesson',
    title: 'gamma deployment checklist',
    content: 'Release the canary before flipping traffic.',
    source: 'human:gamma-lead',
    confidence: 0.7,
    createdBy: 'gamma-01',
    evidenceIds: ['ev-gamma-1'],
    applicableScope: 'project:proj-gamma',
    expiresAt: null,
    ...partial,
  };
}

const gammaRequestor = { id: 'e-gamma', scopes: ['project:proj-gamma'], clearance: 'internal' };

describe('AT-053：跨项目检索 Scope 过滤、无串项目', () => {
  it('无权跨项目检索被拒绝，条目绝不返回', () => {
    const { store } = makeStore();
    store.write(entry({ title: 'gamma secret sauce' }));
    store.write(entry({ title: 'delta internals', scopeId: 'proj-delta' }));

    // gamma 员工直接点名查 proj-delta：拒绝。
    const denied = store.retrieve({ scope: 'project', scopeId: 'proj-delta' }, gammaRequestor);
    assert.deepEqual(denied, [], '未授权项目的条目绝不返回');

    // 无 scopeId 的全量检索也只返回自己项目的条目。
    const visible = store.retrieve({ scope: 'project' }, gammaRequestor);
    assert.deepEqual(visible.map((e) => e.title), ['gamma secret sauce']);
  });

  it('已撤销访问（scope 不再授权）后条目不可见', () => {
    const { store } = makeStore();
    store.write(entry({ title: 'gamma runbook' }));

    const revoked = { id: 'e-gamma', scopes: [], clearance: 'internal' };
    const visible = store.retrieve({ scope: 'project' }, revoked);
    assert.deepEqual(visible, [], '撤销项目访问后检索为空');
  });

  it('分类过滤：internal 请求者看不到 confidential 条目', () => {
    const { store } = makeStore();
    store.write(entry({ title: 'gamma public runbook', dataClassification: 'public' }));
    store.write(entry({ title: 'gamma confidential incident notes', dataClassification: 'confidential' }));

    const seen = store.retrieve({ scope: 'project' }, gammaRequestor).map((e) => e.title);
    assert.ok(seen.includes('gamma public runbook'));
    assert.ok(!seen.includes('gamma confidential incident notes'), '高于 clearance 的条目不返回');

    const cleared = { ...gammaRequestor, clearance: 'confidential' };
    const seenCleared = store.retrieve({ scope: 'project' }, cleared).map((e) => e.title);
    assert.ok(seenCleared.includes('gamma confidential incident notes'));
  });

  it('跨项目复用只放行 allowed=true 且授权的条目，不串项目', () => {
    const { store } = makeStore();
    store.write(
      entry({
        title: 'sanitized gamma pattern',
        accessScope: ['project:proj-gamma', 'project:proj-delta'],
        crossProjectReusable: { allowed: true, conditions: 'sanitized' },
      }),
    );
    store.write(
      entry({
        title: 'gamma private lesson',
        accessScope: ['project:proj-gamma', 'project:proj-delta'],
        crossProjectReusable: { allowed: false },
      }),
    );

    const deltaReq = { id: 'e-delta', scopes: ['project:proj-delta'], clearance: 'internal' };
    const seen = store.retrieve({ scope: 'project', scopeId: 'proj-delta' }, deltaReq);
    assert.deepEqual(
      seen.map((e) => e.title),
      ['sanitized gamma pattern'],
      '只有可复用的条目跨项目可见',
    );
  });
});

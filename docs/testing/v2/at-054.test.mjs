/**
 * AT-054 正式验收（逻辑层验收，非端到端）
 *
 * 判定点：旧 Memory 与新配置冲突 → STALE/CONTRADICTED，回权威来源。
 *   1. 旧配置记忆可标记 STALE；
 *   2. 冲突写入时：旧条目 → CONTRADICTED，新条目 → PROPOSED，并记录双向引用；
 *   3. 冲突以权威来源裁决：权威来源胜出，回 ACTIVE；失败者 RETIRED。
 *
 * 本文件复用 @ai-factory/memory 包公共 API，在进程内断言逻辑层语义。不覆盖
 * 真实模型、真实执行环境、真实生产等端到端维度
 * （详见 docs/testing/v2/ACCEPTANCE_INDEX.md）。
 *
 * 运行：cd <repo-root> && node --test docs/testing/v2/at-054.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryStore,
  sourceAuthorityScore,
} from '../../../packages/memory/dist/src/index.js';

function makeStore() {
  let now = 3_000_000;
  return {
    store: new MemoryStore({ now: () => now }),
    advance: (ms) => { now += ms; },
  };
}

// 与包内自测的数据刻意不同：换场景为“构建超时配置”。
function configEntry(partial = {}) {
  return {
    scope: 'project',
    scopeId: 'proj-build',
    type: 'Decision',
    title: 'Build timeout is 10 minutes',
    content: 'CI pipelines use a 10-minute timeout.',
    source: 'human:build-lead',
    confidence: 0.9,
    createdBy: 'build-01',
    evidenceIds: ['ev-build-1'],
    applicableScope: 'project:proj-build',
    expiresAt: null,
    ...partial,
  };
}

describe('AT-054：配置冲突 → STALE/CONTRADICTED，回权威来源', () => {
  it('过期的旧配置记忆可标记为 STALE', () => {
    const { store } = makeStore();
    const old = store.write(configEntry());
    assert.equal(old.status, 'ACTIVE');
    assert.equal(store.markStale(old.id)?.status, 'STALE');
    assert.equal(store.get(old.id)?.status, 'STALE');
  });

  it('冲突写入：旧条目 → CONTRADICTED，新条目 → PROPOSED 并双向引用', () => {
    const { store } = makeStore();
    const old = store.write(configEntry());
    const fresh = store.write(
      configEntry({
        title: 'Build timeout is 30 minutes',
        content: 'New infra allows a 30-minute timeout.',
        source: 'spec',
        confidence: 0.8,
        contradicts: [old.id],
      }),
    );
    assert.equal(fresh.status, 'PROPOSED', '冲突的新写入先以 PROPOSED 落地');
    assert.deepEqual(fresh.contradicts, [old.id]);

    const marked = store.get(old.id);
    assert.equal(marked.status, 'CONTRADICTED');
    assert.ok(marked.contradicts.includes(fresh.id), '旧条目记录回指');
  });

  it('verify 不消除 CONTRADICTED；PROPOSED 可验成 VALIDATED', () => {
    const { store } = makeStore();
    const old = store.write(configEntry());
    const fresh = store.write(configEntry({ title: 'Build timeout is 30 minutes', contradicts: [old.id] }));

    assert.equal(store.verify(old.id, 'human')?.status, 'CONTRADICTED', '矛盾状态不被验掉');
    assert.equal(store.verify(fresh.id, 'human')?.status, 'VALIDATED');
  });

  it('resolveContradiction：胜者 ACTIVE 并 supersedes，败者 RETIRED', () => {
    const { store } = makeStore();
    const old = store.write(configEntry());
    const fresh = store.write(configEntry({ title: 'Build timeout is 30 minutes', contradicts: [old.id] }));

    const { winner, losers } = store.resolveContradiction(fresh.id, [old.id], 'human:build-lead');
    assert.equal(winner.status, 'ACTIVE');
    assert.ok(winner.supersedes.includes(old.id));
    assert.equal(losers.length, 1);
    assert.equal(losers[0].status, 'RETIRED');
    assert.equal(store.get(old.id)?.status, 'RETIRED');
  });

  it('resolveBySourceAuthority：权威来源胜出（不以新旧/置信度为准）', () => {
    const { store, advance } = makeStore();
    const humanEntry = store.write(
      configEntry({ source: 'human:cto', confidence: 0.5, evidenceIds: ['ev-ctx'] }),
    );
    advance(1000);
    const agentEntry = store.write(
      configEntry({
        title: 'Build timeout is 60 minutes per agent claim',
        source: 'manager-claim:standup',
        confidence: 0.95,
        evidenceIds: ['ev-standup'],
        contradicts: [humanEntry.id],
      }),
    );

    assert.ok(
      sourceAuthorityScore('human:cto') > sourceAuthorityScore('manager-claim:standup'),
      '人类权威来源分数高于 manager-claim',
    );
    const { winnerId, winner, losers } = store.resolveBySourceAuthority(
      [humanEntry.id, agentEntry.id],
      'human:cto',
    );
    assert.equal(winnerId, humanEntry.id, '权威来源胜出，回到 ACTIVE');
    assert.equal(winner.status, 'ACTIVE');
    assert.equal(losers[0].id, agentEntry.id);
    assert.equal(losers[0].status, 'RETIRED');
  });
});

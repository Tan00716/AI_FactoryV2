import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeStore } from '../src/index';
import type { KnowledgeItem } from '../src/index';

function makeClock() {
  let t = 1000;
  return { now: () => (t += 100) };
}

function seed(store: KnowledgeStore): KnowledgeItem[] {
  const src = (type: 'official_docs' = 'official_docs') => ({
    type,
    name: 'vendor docs',
    retrievedAt: 0,
  });
  return [
    store.add({
      title: 'Global loop pattern',
      content: 'retry with backoff',
      tags: ['loop'],
      scope: { level: 'GLOBAL' },
      source: src(),
    }),
    store.add({
      title: 'Org deploy checklist',
      content: 'staging first',
      tags: ['deploy'],
      scope: { level: 'ORGANIZATION', organizationId: 'org1' },
      source: src(),
    }),
    store.add({
      title: 'Project memory format',
      content: 'jsonl lessons',
      tags: ['memory'],
      scope: { level: 'PROJECT', organizationId: 'org1', projectId: 'proj1' },
      source: src(),
    }),
    store.add({
      title: 'Task-specific trick',
      content: 'cache the AST',
      tags: ['perf'],
      scope: { level: 'TASK', organizationId: 'org1', projectId: 'proj1', employeeId: 'emp1', taskId: 'task1' },
      source: src(),
    }),
  ];
}

function activate(store: KnowledgeStore, items: KnowledgeItem[]): void {
  for (const item of items) {
    const ev = {
      verifications: [{ method: 'read', verifiedAt: 1, by: 'qa' }],
      evaluation: { score: 90, passed: true, evaluatedAt: 1, by: 'qa' },
      approval: { approved: true, by: 'cto', decidedAt: 1 },
    };
    let id = item.id;
    for (const to of ['UNVERIFIED', 'VALIDATED', 'EVALUATED', 'APPROVED'] as const) {
      id = store.transition(id, to, { actor: 'test', evidence: ev }).item.id;
    }
    store.transition(id, 'ACTIVE', {
      actor: 'test',
      evidence: { appliedProposalId: `prop_${id}` },
    });
  }
}

describe('hierarchy — scope fallback query [§50]', () => {
  it('returns the most specific scope hit first', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const items = activate(store, seed(store));
    void items;
    const hits = store.query({ organizationId: 'org1', projectId: 'proj1', employeeId: 'emp1', taskId: 'task1' });
    assert.equal(hits.length, 4);
    assert.equal(hits[0].matchedScope.level, 'TASK');
    assert.equal(hits[0].item.title, 'Task-specific trick');
    assert.equal(hits[3].matchedScope.level, 'GLOBAL');
  });

  it('falls back to broader scopes when the task has no item', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    activate(store, seed(store));
    const hits = store.query({ organizationId: 'org1', projectId: 'proj1', employeeId: 'emp1', taskId: 'taskX' });
    const levels = hits.map((h) => h.matchedScope.level);
    assert.deepEqual(levels, ['PROJECT', 'ORGANIZATION', 'GLOBAL']);
  });

  it('falls back all the way to GLOBAL for an unknown chain', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    activate(store, seed(store));
    const hits = store.query({ organizationId: 'other', projectId: 'other' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].matchedScope.level, 'GLOBAL');
  });

  it('never leaks another project/employee/task item into the query', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    const items = activate(store, seed(store));
    void items;
    const hits = store.query({ organizationId: 'org1', projectId: 'proj2', taskId: 'task1' });
    const titles = hits.map((h) => h.item.title);
    assert.ok(!titles.includes('Task-specific trick'), 'task item of another chain must not match');
    assert.ok(!titles.includes('Project memory format'), 'other project item must not match');
    assert.ok(titles.includes('Org deploy checklist'));
    assert.ok(titles.includes('Global loop pattern'));
  });

  it('only ACTIVE items are returned by default; non-active via states filter', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    seed(store); // all DISCOVERED
    const hits = store.query({ organizationId: 'org1' });
    assert.equal(hits.length, 0);
    const discovered = store.query({ organizationId: 'org1' }, { states: ['DISCOVERED'] });
    assert.ok(discovered.length > 0);
    for (const h of discovered) assert.equal(h.item.state, 'DISCOVERED');
  });

  it('each hit reports its source scope level', () => {
    const store = new KnowledgeStore({ clock: makeClock() });
    activate(store, seed(store));
    const hits = store.query({ organizationId: 'org1', projectId: 'proj1' });
    assert.ok(hits.every((h) => h.specificity >= 0));
    const org = hits.find((h) => h.item.title === 'Org deploy checklist');
    assert.equal(org?.matchedScope.level, 'ORGANIZATION');
  });
});

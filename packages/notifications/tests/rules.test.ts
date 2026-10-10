/** @ai-factory/notifications — rule engine tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRules, DEFAULT_RULES } from '../src/rules';

test('gate failure maps to HIGH priority', () => {
  const matched = matchRules({ type: 'GATE_FAILED', entity: { kind: 'review', id: 'r1', label: 'auth.ts' } });
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, 'gate-failed');
  const o = matched[0].build({ type: 'GATE_FAILED', entity: { kind: 'review', id: 'r1', label: 'auth.ts' }, detail: { reason: 'blocking findings' } });
  assert.equal(o.priority, 'HIGH');
  assert.match(o.title, /auth\.ts/);
  assert.match(o.body, /blocking findings/);
});

test('task blocked maps to HIGH priority', () => {
  const matched = matchRules({ type: 'TASK_BLOCKED', entity: { kind: 'task', id: 't1', label: 'Login flow' } });
  assert.equal(matched.length, 1);
  assert.equal(matched[0].build({ type: 'TASK_BLOCKED' }).priority, 'HIGH');
});

test('deployment completed maps to INFO', () => {
  const matched = matchRules({ type: 'DEPLOYMENT_COMPLETED' });
  assert.equal(matched.length, 1);
  assert.equal(matched[0].build({ type: 'DEPLOYMENT_COMPLETED' }).priority, 'INFO');
});

test('approval pending maps to MEDIUM', () => {
  const matched = matchRules({ type: 'APPROVAL_PENDING', entity: { kind: 'approval', id: 'a1', label: 'PROD deploy' }, detail: { riskLevel: 'HIGH' } });
  assert.equal(matched.length, 1);
  const o = matched[0].build({ type: 'APPROVAL_PENDING', entity: { kind: 'approval', id: 'a1', label: 'PROD deploy' }, detail: { riskLevel: 'HIGH' } });
  assert.equal(o.priority, 'MEDIUM');
  assert.match(o.body, /HIGH/);
});

test('unknown event falls back to INFO (never dropped)', () => {
  const matched = matchRules({ type: 'GENERIC' });
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, 'fallback');
  assert.equal(matched[0].build({ type: 'GENERIC' }).priority, 'INFO');
});

test('custom rules replace defaults; when-guard filters', () => {
  const matched = matchRules(
    { type: 'TASK_BLOCKED', detail: { silent: true } },
    [
      ...DEFAULT_RULES.filter((r) => r.id !== 'fallback'),
      { id: 'silent-skip', eventTypes: ['TASK_BLOCKED'], when: (e) => !(e.detail?.['silent'] === true), build: () => ({ title: 't', body: 'b', priority: 'LOW' }) },
    ],
  );
  assert.deepEqual(matched.map((r) => r.id), ['task-blocked']);
});

test('type override is respected in outcome', () => {
  const matched = matchRules(
    { type: 'GENERIC' },
    [{ id: 'x', eventTypes: ['GENERIC'], build: () => ({ title: 't', body: 'b', priority: 'INFO', type: 'CUSTOM_TYPE' }) }],
  );
  assert.equal(matched[0].build({ type: 'GENERIC' }).type, 'CUSTOM_TYPE');
});

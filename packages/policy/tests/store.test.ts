/**
 * Tests for PolicyStore — §43 7-layer merge with upper-wins override denial.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GLOBAL_SCOPE_ID, PolicyStore } from '../src/index';

describe('PolicyStore set/get', () => {
  it('stores and retrieves per-layer policies', () => {
    const store = new PolicyStore();
    store.set('global', GLOBAL_SCOPE_ID, { 'security.production_write': 'denied' });
    const doc = store.get('global', GLOBAL_SCOPE_ID);
    assert.equal(doc?.rules['security.production_write'].value, 'denied');
    assert.equal(doc?.rules['security.production_write'].locked, true);
  });

  it('stores bare values as locked by default, {value,locked} overrides', () => {
    const store = new PolicyStore();
    store.set('project', 'p1', {
      'a.b': 'x',
      'c.d': { value: 'y', locked: false },
    });
    const doc = store.get('project', 'p1');
    assert.equal(doc?.rules['a.b'].locked, true);
    assert.equal(doc?.rules['c.d'].locked, false);
  });
});

describe('resolveEffectivePolicy merge', () => {
  it('merges top-down: all 7 layers contribute distinct keys', () => {
    const store = new PolicyStore();
    const layers = ['global', 'organization', 'project', 'department', 'agent', 'task', 'tool'] as const;
    layers.forEach((layer, i) => {
      store.set(layer, layer === 'global' ? GLOBAL_SCOPE_ID : 's1', { [`k${i}`]: i });
    });
    const r = store.resolveEffectivePolicy({
      layer: 'tool',
      organization: 's1',
      project: 's1',
      department: 's1',
      agent: 's1',
      task: 's1',
      tool: 's1',
    });
    assert.deepEqual(r.policy, { k0: 0, k1: 1, k2: 2, k3: 3, k4: 4, k5: 5, k6: 6 });
    assert.equal(r.denials.length, 0);
  });

  it('upper layer wins: global beats project on the same key', () => {
    const store = new PolicyStore();
    store.set('global', GLOBAL_SCOPE_ID, { 'security.production_write': 'denied' });
    store.set('project', 'myapp', { 'security.production_write': 'allowed' });
    const r = store.resolveEffectivePolicy({ layer: 'project', project: 'myapp' });
    assert.equal(r.policy['security.production_write'], 'denied');
    assert.equal(r.denials.length, 1);
  });

  it('denies a locked-key override attempt: denial names key, layers, values', () => {
    const store = new PolicyStore();
    store.set('global', GLOBAL_SCOPE_ID, { 'security.production_write': 'denied' });
    store.set('project', 'myapp', { 'security.production_write': 'allowed' });
    const r = store.resolveEffectivePolicy({ layer: 'project', project: 'myapp' });
    const d = r.denials[0];
    assert.equal(d.key, 'security.production_write');
    assert.equal(d.attempted.layer, 'project');
    assert.equal(d.attempted.value, 'allowed');
    assert.equal(d.winner.layer, 'global');
    assert.equal(d.winner.value, 'denied');
    assert.equal(d.allowed, false);
  });

  it('never silently overrides: records an overrideDenied event', () => {
    const store = new PolicyStore();
    const seen: string[] = [];
    store.on('overrideDenied', (e) => seen.push(e.attempt.key));
    store.set('organization', 'acme', { 'capabilities': 'strict' });
    store.set('department', 'eng', { 'capabilities': 'loose' });
    store.resolveEffectivePolicy({ layer: 'department', organization: 'acme', department: 'eng' });
    assert.deepEqual(seen, ['capabilities']);
    assert.equal(store.events.length, 1);
    assert.equal(store.events[0].kind, 'overrideDenied');
  });

  it('an unlocked upper key may be overridden, but the attempt is still recorded', () => {
    const store = new PolicyStore();
    store.set('organization', 'acme', { 'deployment.auto_uat': { value: false, locked: false } });
    store.set('project', 'myapp', { 'deployment.auto_uat': true });
    const r = store.resolveEffectivePolicy({
      layer: 'project',
      organization: 'acme',
      project: 'myapp',
    });
    assert.equal(r.policy['deployment.auto_uat'], true);
    assert.equal(r.denials.length, 0);
    assert.equal(r.attempts.length, 1);
    assert.equal(r.attempts[0].allowed, true);
    assert.equal(store.events[0].kind, 'overrideAllowed');
  });

  it('identical values from lower layers are not conflicts', () => {
    const store = new PolicyStore();
    store.set('global', GLOBAL_SCOPE_ID, { 'a.b': 1 });
    store.set('project', 'myapp', { 'a.b': 1 });
    const r = store.resolveEffectivePolicy({ layer: 'project', project: 'myapp' });
    assert.equal(r.denials.length, 0);
    assert.equal(r.attempts.length, 0);
  });

  it('resolving at an upper layer ignores lower layers', () => {
    const store = new PolicyStore();
    store.set('global', GLOBAL_SCOPE_ID, { 'g': 1 });
    store.set('project', 'myapp', { 'p': 2 });
    const r = store.resolveEffectivePolicy({ layer: 'organization' });
    assert.deepEqual(r.policy, { g: 1 });
  });

  it('uses the correct scope id per layer', () => {
    const store = new PolicyStore();
    store.set('project', 'alpha', { 'x': 'alpha-x' });
    store.set('project', 'beta', { 'x': 'beta-x' });
    const ra = store.resolveEffectivePolicy({ layer: 'project', project: 'alpha' });
    const rb = store.resolveEffectivePolicy({ layer: 'project', project: 'beta' });
    assert.equal(ra.policy['x'], 'alpha-x');
    assert.equal(rb.policy['x'], 'beta-x');
  });
});

describe('§23.1 restrictive intersection merge', () => {
  it('deny-wins: a deny at any layer beats allows', () => {
    const store = new PolicyStore();
    store.set('global', GLOBAL_SCOPE_ID, {
      'net.egress': { value: 'allowed', locked: true, merge: 'deny-wins', denyValue: 'denied' },
    });
    store.set('project', 'myapp', { 'net.egress': 'allowed' });
    store.set('tool', 'browser', { 'net.egress': 'denied' });
    const r = store.resolveEffectivePolicy({
      layer: 'tool', project: 'myapp', tool: 'browser',
    });
    assert.equal(r.policy['net.egress'], 'denied');
    assert.equal(r.hits['net.egress'].strategy, 'deny-wins');
    assert.equal(r.hits['net.egress'].winner.layer, 'tool');
    assert.equal(r.denials.length, 0); // intersection, not an override attempt
  });

  it('deny-wins: no deny present falls back to upper-wins', () => {
    const store = new PolicyStore();
    store.set('global', GLOBAL_SCOPE_ID, {
      'net.egress': { value: 'allowed', locked: true, merge: 'deny-wins', denyValue: 'denied' },
    });
    store.set('project', 'myapp', { 'net.egress': 'allowed' });
    const r = store.resolveEffectivePolicy({ layer: 'project', project: 'myapp' });
    assert.equal(r.policy['net.egress'], 'allowed');
    assert.equal(r.attempts.length, 0); // identical values: no conflict
  });

  it('strictest-min: numeric ceiling resolves to the smallest value', () => {
    const store = new PolicyStore();
    store.set('global', GLOBAL_SCOPE_ID, {
      'budget.max_tokens': { value: 100000, locked: true, merge: 'strictest-min' },
    });
    store.set('organization', 'acme', { 'budget.max_tokens': 50000 });
    store.set('project', 'myapp', { 'budget.max_tokens': 200000 }); // looser: ignored
    const r = store.resolveEffectivePolicy({
      layer: 'project', organization: 'acme', project: 'myapp',
    });
    assert.equal(r.policy['budget.max_tokens'], 50000);
    assert.equal(r.hits['budget.max_tokens'].strategy, 'strictest-min');
    assert.equal(r.hits['budget.max_tokens'].winner.layer, 'organization');
    assert.equal(r.hits['budget.max_tokens'].contributing.length, 3);
  });

  it('strictest-max: numeric floor resolves to the largest value', () => {
    const store = new PolicyStore();
    store.set('global', GLOBAL_SCOPE_ID, {
      'sla.min_replicas': { value: 1, locked: true, merge: 'strictest-max' },
    });
    store.set('project', 'myapp', { 'sla.min_replicas': 3 });
    const r = store.resolveEffectivePolicy({ layer: 'project', project: 'myapp' });
    assert.equal(r.policy['sla.min_replicas'], 3);
    assert.equal(r.hits['sla.min_replicas'].strategy, 'strictest-max');
  });

  it('strictest merge with non-numeric values throws a clear error', () => {
    const store = new PolicyStore();
    store.set('global', GLOBAL_SCOPE_ID, {
      'budget.max_tokens': { value: 100000, locked: true, merge: 'strictest-min' },
    });
    store.set('project', 'myapp', { 'budget.max_tokens': 'unlimited' });
    assert.throws(
      () => store.resolveEffectivePolicy({ layer: 'project', project: 'myapp' }),
      /requires all numeric values/,
    );
  });

  it('policy_hash is stable for identical inputs and changes with any input', () => {
    const build = () => {
      const s = new PolicyStore();
      s.set('global', GLOBAL_SCOPE_ID, { 'a': 1 });
      s.set('project', 'p', { 'b': 2 });
      return s.resolveEffectivePolicy({ layer: 'project', project: 'p' });
    };
    const r1 = build();
    const r2 = build();
    assert.equal(r1.policy_hash, r2.policy_hash);
    assert.equal(r1.policy_hash.length, 64);
    const s3 = new PolicyStore();
    s3.set('global', GLOBAL_SCOPE_ID, { 'a': 1 });
    s3.set('project', 'p', { 'b': 3 }); // changed value
    const r3 = s3.resolveEffectivePolicy({ layer: 'project', project: 'p' });
    assert.notEqual(r1.policy_hash, r3.policy_hash);
  });

  it('resolution records evaluation inputs and per-key hits', () => {
    const store = new PolicyStore();
    store.set('global', GLOBAL_SCOPE_ID, { 'g': 1 });
    store.set('project', 'myapp', { 'p': 2 });
    const r = store.resolveEffectivePolicy({ layer: 'project', project: 'myapp' });
    assert.deepEqual(r.inputs.documents.map((d) => d.layer), ['global', 'organization', 'project']);
    assert.deepEqual(r.inputs.documents[0].keys, ['g']);
    assert.equal(r.hits['g'].winner.layer, 'global');
    assert.equal(r.hits['p'].winner.layer, 'project');
    assert.equal(r.hits['g'].strategy, 'upper-wins');
  });

  it('chained override: an allowed lower override becomes effective for deeper layers', () => {
    const store = new PolicyStore();
    store.set('organization', 'acme', { 'x': { value: 'org', locked: false } });
    store.set('project', 'myapp', { 'x': 'proj' }); // allowed; now effective
    store.set('task', 't1', { 'x': 'task' }); // vs project rule (locked by default) → denied
    const r = store.resolveEffectivePolicy({
      layer: 'task', organization: 'acme', project: 'myapp', task: 't1',
    });
    assert.equal(r.policy['x'], 'proj');
    assert.equal(r.attempts.length, 2);
    assert.equal(r.attempts[0].allowed, true);
    assert.equal(r.attempts[1].allowed, false);
    assert.equal(r.denials.length, 1);
    assert.equal(r.denials[0].winner.layer, 'project');
  });
});

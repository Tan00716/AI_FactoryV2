/**
 * Tests for the §23.1 PolicyStore.set() write gate: replacing a document
 * may not rewrite, delete or unlock an existing locked rule unless the
 * caller carries authority at that layer or higher. Denials are atomic
 * (store unchanged) and recorded as overrideDenied events; sets that do
 * not touch an existing locked rule need no caller at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GLOBAL_SCOPE_ID, PolicySetDeniedError, PolicyStore } from '../src/index';

/** Seed a store whose organization doc has one locked + one unlocked rule. */
function seeded(): PolicyStore {
  const store = new PolicyStore();
  store.set('organization', 'acme', {
    'security.production_write': 'denied', // bare value → locked
    'deployment.auto_uat': { value: false, locked: false },
  });
  return store;
}

describe('PolicyStore.set write gate (§23.1)', () => {
  it('first configuration needs no caller', () => {
    const store = new PolicyStore();
    store.set('global', GLOBAL_SCOPE_ID, { 'a.b': 1 });
    assert.equal(store.get('global', GLOBAL_SCOPE_ID)?.rules['a.b'].value, 1);
    assert.equal(store.events.length, 0);
  });

  it('rejects a caller-less overwrite of a locked rule; store unchanged, denial recorded', () => {
    const store = seeded();
    assert.throws(
      () =>
        store.set('organization', 'acme', {
          'security.production_write': 'allowed',
          'deployment.auto_uat': { value: false, locked: false },
        }),
      (e: unknown) => {
        assert.ok(e instanceof PolicySetDeniedError);
        assert.equal(e.layer, 'organization');
        assert.equal(e.scopeId, 'acme');
        assert.deepEqual(e.protectedKeys, ['security.production_write']);
        return true;
      },
    );
    const doc = store.get('organization', 'acme');
    assert.equal(doc?.rules['security.production_write'].value, 'denied');
    assert.equal(doc?.rules['security.production_write'].locked, true);
    const denials = store.events.filter((ev) => ev.kind === 'overrideDenied');
    assert.equal(denials.length, 1);
    assert.equal(denials[0].attempt.key, 'security.production_write');
    assert.equal(denials[0].attempt.attempted.layer, 'organization');
    assert.equal(denials[0].attempt.attempted.scopeId, 'acme');
    assert.equal(denials[0].attempt.actor, 'anonymous');
    assert.equal(denials[0].attempt.allowed, false);
    assert.equal(denials[0].attempt.winner.value, 'denied');
    assert.equal(denials[0].attempt.winnerLocked, true);
  });

  it('rejection is atomic: additions bundled with a locked overwrite are not stored', () => {
    const store = seeded();
    assert.throws(
      () =>
        store.set('organization', 'acme', {
          'security.production_write': 'allowed',
          'brand.new_key': 'x',
        }),
      PolicySetDeniedError,
    );
    const doc = store.get('organization', 'acme');
    assert.equal(doc?.rules['brand.new_key'], undefined);
    assert.equal(doc?.rules['deployment.auto_uat'].value, false); // old doc intact
  });

  it('rejects deleting a locked rule by omitting it from the replacement document', () => {
    const store = seeded();
    assert.throws(
      () => store.set('organization', 'acme', { 'deployment.auto_uat': true }),
      (e: unknown) => {
        assert.ok(e instanceof PolicySetDeniedError);
        assert.deepEqual(e.protectedKeys, ['security.production_write']);
        return true;
      },
    );
    assert.equal(store.get('organization', 'acme')?.rules['security.production_write'].value, 'denied');
  });

  it('rejects unlocking a locked rule (same value, locked:false) without authority', () => {
    const store = seeded();
    assert.throws(
      () =>
        store.set('organization', 'acme', {
          'security.production_write': { value: 'denied', locked: false },
          'deployment.auto_uat': { value: false, locked: false },
        }),
      PolicySetDeniedError,
    );
    assert.equal(store.get('organization', 'acme')?.rules['security.production_write'].locked, true);
  });

  it('protects every touched locked key, listed together in the error', () => {
    const store = new PolicyStore();
    store.set('global', GLOBAL_SCOPE_ID, { 'k.one': 1, 'k.two': 2, 'k.free': { value: 0, locked: false } });
    assert.throws(
      () => store.set('global', GLOBAL_SCOPE_ID, { 'k.one': 10, 'k.two': 20, 'k.free': 5 }),
      (e: unknown) => {
        assert.ok(e instanceof PolicySetDeniedError);
        assert.deepEqual([...e.protectedKeys].sort(), ['k.one', 'k.two']);
        return true;
      },
    );
  });

  it('rejects a caller whose authority is below the document layer', () => {
    const store = seeded();
    assert.throws(
      () =>
        store.set(
          'organization',
          'acme',
          { 'security.production_write': 'allowed' },
          { caller: { actor: 'agent:rogue', layer: 'project', scopeId: 'acme' } },
        ),
      PolicySetDeniedError,
    );
    assert.equal(store.get('organization', 'acme')?.rules['security.production_write'].value, 'denied');
    const denial = store.events.find((ev) => ev.kind === 'overrideDenied');
    assert.equal(denial?.attempt.actor, 'agent:rogue');
  });

  it('allows a same-layer caller to rewrite and unlock a locked rule, recorded as overrideAllowed', () => {
    const store = seeded();
    store.set(
      'organization',
      'acme',
      {
        'security.production_write': { value: 'allowed', locked: false },
        'deployment.auto_uat': { value: false, locked: false },
      },
      { caller: { actor: 'human:org-admin', layer: 'organization', scopeId: 'acme' } },
    );
    const doc = store.get('organization', 'acme');
    assert.equal(doc?.rules['security.production_write'].value, 'allowed');
    assert.equal(doc?.rules['security.production_write'].locked, false);
    const allowed = store.events.filter((ev) => ev.kind === 'overrideAllowed');
    assert.equal(allowed.length, 1);
    assert.equal(allowed[0].attempt.actor, 'human:org-admin');
    assert.equal(allowed[0].attempt.key, 'security.production_write');
    // Now unlocked: a later caller-less set may change it freely.
    store.set('organization', 'acme', { 'security.production_write': 'denied' });
    assert.equal(store.get('organization', 'acme')?.rules['security.production_write'].value, 'denied');
  });

  it('allows a higher-layer caller (global) to rewrite a lower layer locked rule', () => {
    const store = new PolicyStore();
    store.set('project', 'myapp', { 'budget.max_tokens': 1000 }); // locked
    store.set(
      'project',
      'myapp',
      { 'budget.max_tokens': 2000 },
      { authorizedBy: { actor: 'human:root', layer: 'global' } },
    );
    assert.equal(store.get('project', 'myapp')?.rules['budget.max_tokens'].value, 2000);
  });

  it('confines a same-layer caller to its own scope', () => {
    const store = new PolicyStore();
    store.set('project', 'mine', { 'x': 1 }); // locked
    assert.throws(
      () =>
        store.set('project', 'mine', { 'x': 2 }, { caller: { actor: 'agent:a', layer: 'project', scopeId: 'other' } }),
      PolicySetDeniedError,
    );
    store.set('project', 'mine', { 'x': 2 }, { caller: { actor: 'agent:a', layer: 'project', scopeId: 'mine' } });
    assert.equal(store.get('project', 'mine')?.rules['x'].value, 2);
  });

  it('changing only unlocked rules (or re-setting identical locked rules) needs no caller', () => {
    const store = seeded();
    store.set('organization', 'acme', {
      'security.production_write': 'denied', // identical locked rule, untouched
      'deployment.auto_uat': { value: true, locked: false }, // unlocked change
      'extra.key': 'new', // addition
    });
    const doc = store.get('organization', 'acme');
    assert.equal(doc?.rules['deployment.auto_uat'].value, true);
    assert.equal(doc?.rules['extra.key'].value, 'new');
    assert.equal(store.events.length, 0);
  });

  it('tightening an unlocked rule to locked needs no caller', () => {
    const store = seeded();
    store.set('organization', 'acme', {
      'security.production_write': 'denied',
      'deployment.auto_uat': { value: false, locked: true },
    });
    assert.equal(store.get('organization', 'acme')?.rules['deployment.auto_uat'].locked, true);
    assert.equal(store.events.length, 0);
  });
});

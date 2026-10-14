/**
 * Secret Broker tests (§46.2): resolution chain, leases, rotation
 * revocation, uniform not-found, and the no-value-in-audit invariant
 * (sentinel values are searched for in every serialized audit event).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemorySecretStore,
  SecretBroker,
  SecretLeaseExpiredError,
  SecretNotFoundError,
  SecretReadOnlyError,
  redactSecretValues,
  redactSecretValuesCounted,
  type SecretAuditEvent,
} from '../src/index';
import { EnvSecretStore } from '../src/index';

const SENTINEL = 'sentinel-value-9f27c1-do-not-leak';

function makeBroker() {
  const events: SecretAuditEvent[] = [];
  let now = 1_000_000;
  const clock = { now: () => now };
  const store = new MemorySecretStore(clock);
  const broker = new SecretBroker({
    stores: [store],
    clock,
    leaseTtlMs: 5_000,
    audit: (e) => events.push(e),
  });
  return { broker, store, events, advance: (ms: number) => { now += ms; } };
}

describe('SecretBroker resolution', () => {
  it('resolves by bare name and by secret:// ref', async () => {
    const { broker } = makeBroker();
    await broker.set('github-token', SENTINEL, { actor: 'admin' });
    assert.equal(await broker.resolve('github-token', { actor: 'exec' }), SENTINEL);
    assert.equal(await broker.resolve('secret://github-token', { actor: 'exec' }), SENTINEL);
  });

  it('first backend in the chain wins', async () => {
    const a = new MemorySecretStore();
    const b = new MemorySecretStore();
    await a.set('shared', 'from-a');
    await b.set('shared', 'from-b');
    const broker = new SecretBroker({ stores: [a, b] });
    assert.equal(await broker.resolve('shared', { actor: 't' }), 'from-a');
    const meta = await broker.describe('shared');
    assert.equal(meta.backend, 'memory');
    assert.equal(meta.exists, true);
  });

  it('rejects malformed refs as name errors, not misses', async () => {
    const { broker } = makeBroker();
    await assert.rejects(() => broker.resolve('http://evil', { actor: 't' }), /invalid secret name/);
    await assert.rejects(() => broker.resolve('secret://', { actor: 't' }), /invalid secret name/);
    await assert.rejects(() => broker.resolve('has space', { actor: 't' }), /invalid secret name/);
  });

  it('not-found is uniform: same error whether the store is empty or full', async () => {
    const { broker } = makeBroker();
    const emptyErr = await broker.resolve('ghost', { actor: 't' }).catch((e) => e);
    await broker.set('other-secret', SENTINEL, { actor: 'admin' });
    await broker.set('another-one', SENTINEL, { actor: 'admin' });
    const fullErr = await broker.resolve('ghost', { actor: 't' }).catch((e) => e);
    assert.ok(emptyErr instanceof SecretNotFoundError);
    assert.ok(fullErr instanceof SecretNotFoundError);
    assert.equal(emptyErr.message, fullErr.message);
    assert.equal(emptyErr.message, 'secret not found: secret://ghost');
    // The error names only what the caller asked for — no other refs.
    assert.ok(!fullErr.message.includes('other-secret'));
    assert.ok(!fullErr.message.includes('another-one'));
    assert.equal(fullErr.code, 'SECRET_NOT_FOUND');
  });
});

describe('SecretBroker audit hygiene', () => {
  it('no audit event ever contains a secret value', async () => {
    const { broker, events } = makeBroker();
    await broker.set('api-key', SENTINEL, { actor: 'admin', purpose: 'ci' });
    await broker.resolve('api-key', { actor: 'exec', purpose: 'exec env injection' });
    const lease = await broker.lease('api-key', { actor: 'exec' });
    assert.equal(lease.value, SENTINEL);
    await broker.set('api-key', SENTINEL + '-rotated', { actor: 'admin' });
    await broker.resolve('missing', { actor: 'exec' }).catch(() => {});
    await broker.delete('api-key', { actor: 'admin' });
    const blob = JSON.stringify(events);
    assert.ok(!blob.includes(SENTINEL), 'audit events must not contain the sentinel value');
    assert.ok(!blob.includes(SENTINEL + '-rotated'));
    const actions = events.map((e) => e.action);
    for (const expected of ['SECRET_SET', 'SECRET_RESOLVED', 'SECRET_LEASED', 'SECRET_LEASE_REVOKED', 'SECRET_NOT_FOUND', 'SECRET_DELETED']) {
      assert.ok(actions.includes(expected as never), `missing audit action ${expected}`);
    }
    // Rotation was flagged as rotation, deletion recorded — all by ref.
    const rotated = events.find((e) => e.action === 'SECRET_SET' && e.rotated);
    assert.ok(rotated);
    assert.equal(rotated.name, 'api-key');
  });
});

describe('SecretBroker leases (§46.2 short-term lease)', () => {
  it('value is readable inside the TTL and throws after expiry', async () => {
    const { broker, advance } = makeBroker();
    await broker.set('k', SENTINEL, { actor: 'admin' });
    const lease = await broker.lease('k', { actor: 'tool' });
    assert.equal(lease.value, SENTINEL);
    assert.equal(lease.active, true);
    advance(5_001);
    assert.equal(lease.active, false);
    assert.throws(() => lease.value, SecretLeaseExpiredError);
  });

  it('rotation revokes outstanding leases (§46.2: rotation invalidates)', async () => {
    const { broker } = makeBroker();
    await broker.set('k', SENTINEL, { actor: 'admin' });
    const lease = await broker.lease('k', { actor: 'tool' });
    await broker.set('k', 'new-value', { actor: 'admin' });
    assert.equal(lease.active, false);
    assert.throws(() => lease.value, SecretLeaseExpiredError);
    assert.equal(await broker.resolve('k', { actor: 'tool' }), 'new-value');
  });

  it('deletion revokes outstanding leases and removes the entry everywhere', async () => {
    const { broker } = makeBroker();
    await broker.set('k', SENTINEL, { actor: 'admin' });
    const lease = await broker.lease('k', { actor: 'tool' });
    assert.equal(await broker.delete('k', { actor: 'admin' }), true);
    assert.throws(() => lease.value, SecretLeaseExpiredError);
    assert.equal(await broker.delete('k', { actor: 'admin' }), false);
    await assert.rejects(() => broker.resolve('k', { actor: 'tool' }), SecretNotFoundError);
  });
});

describe('SecretBroker writes', () => {
  it('set on a read-only-only chain refuses and stores nothing', async () => {
    const broker = new SecretBroker({ stores: [new EnvSecretStore({})] });
    await assert.rejects(
      () => broker.set('k', SENTINEL, { actor: 'admin' }),
      (e: unknown) => e instanceof SecretReadOnlyError && !(e as Error).message.includes(SENTINEL),
    );
    assert.equal((await broker.describe('k')).exists, false);
  });

  it('list/describe expose metadata only', async () => {
    const { broker } = makeBroker();
    await broker.set('deploy-key', SENTINEL, { actor: 'admin', purpose: 'prod deploys' });
    const list = await broker.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'deploy-key');
    assert.equal(list[0].ref, 'secret://deploy-key');
    assert.equal(list[0].purpose, 'prod deploys');
    assert.ok(!JSON.stringify(list).includes(SENTINEL));
    const missing = await broker.describe('nope');
    assert.deepEqual(missing, {
      name: 'nope', ref: 'secret://nope', backend: null, exists: false, purpose: null, updatedAt: null,
    });
  });
});

describe('redactSecretValues', () => {
  it('replaces every exact occurrence, longest first', () => {
    const out = redactSecretValues(`a=${SENTINEL} b=${SENTINEL} again`, [SENTINEL]);
    assert.equal(out, 'a=*** b=*** again');
    const overlap = redactSecretValues('xxabcdefxx', ['abc', 'abcdef']);
    assert.equal(overlap, 'xx***xx');
  });

  it('skips empty values instead of nuking the text', () => {
    assert.equal(redactSecretValues('hello', ['']), 'hello');
  });
});

describe('redactSecretValuesCounted (Batch 42)', () => {
  it('returns the exact replacement count', () => {
    const r = redactSecretValuesCounted(`a=${SENTINEL} b=${SENTINEL} again`, [SENTINEL]);
    assert.equal(r.text, 'a=*** b=*** again');
    assert.equal(r.hits, 2);
  });

  it('counts longest-first without double counting overlaps', () => {
    const r = redactSecretValuesCounted('xxabcdefxx', ['abc', 'abcdef']);
    assert.equal(r.text, 'xx***xx');
    assert.equal(r.hits, 1);
  });

  it('sums hits across multiple values', () => {
    const r = redactSecretValuesCounted('k1=v1 k2=v2 k1=v1', ['v1', 'v2']);
    assert.equal(r.text, 'k1=*** k2=*** k1=***');
    assert.equal(r.hits, 3);
  });

  it('returns zero hits when nothing matches', () => {
    const r = redactSecretValuesCounted('hello world', [SENTINEL]);
    assert.equal(r.text, 'hello world');
    assert.equal(r.hits, 0);
  });

  it('skips empty values and counts nothing for them', () => {
    const r = redactSecretValuesCounted('hello', ['']);
    assert.equal(r.text, 'hello');
    assert.equal(r.hits, 0);
  });

  it('redactSecretValues stays byte-identical to the counted text', () => {
    const text = `x=${SENTINEL}y zzabcdefzz`;
    const values = [SENTINEL, 'abc', 'abcdef', ''];
    assert.equal(redactSecretValues(text, values), redactSecretValuesCounted(text, values).text);
  });
});

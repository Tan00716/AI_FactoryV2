/**
 * R7-#8 multi-connection metadata tests (dist).
 * Run: npm run build -w @ai-factory/dbbrowser && node --test packages/dbbrowser/dist/tests/multiconn.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRIVER_CATALOG, MultiConnectionManager, driverInfo, stripSecretFields } from '../src/index.js';

/** DbBlockedError carries the code as a property, not in the message. */
function assertCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code);
}

test('driver catalog: sqlite/postgres available, others honestly unavailable', () => {
  assert.equal(driverInfo('sqlite')?.available, true);
  assert.equal(driverInfo('postgres')?.available, true);
  for (const k of ['mysql', 'mariadb', 'mssql', 'oracle']) {
    const d = driverInfo(k);
    assert.equal(d?.available, false, k);
    assert.match(d?.note ?? '', /No .* driver bundled/);
  }
  assert.equal(driverInfo('nosuchdb'), null);
  assert.ok(DRIVER_CATALOG.length >= 7);
});

test('write gate: read passes, write refused by default, confirm enables', () => {
  const m = new MultiConnectionManager({ now: () => 1000 });
  const meta = m.register('shop', 'sqlite', 'dev', false);
  assert.equal(meta.writeMode, false);
  assertCode(() => m.assertWriteAllowed(meta, 'write'), 'WRITE_MODE_DISABLED');
  m.assertWriteAllowed(meta, 'read'); // reads never gated
  assertCode(() => m.setWriteMode('shop', true, false), 'CONFIRM_REQUIRED');
  assert.equal(m.setWriteMode('shop', true, true).writeMode, true);
  m.assertWriteAllowed(meta, 'write');
  assert.equal(m.setWriteMode('shop', false, false).writeMode, false);
  assertCode(() => m.assertWriteAllowed(meta, 'write'), 'WRITE_MODE_DISABLED');
});

test('write gate: prod and read-only can never enable write mode', () => {
  const m = new MultiConnectionManager();
  const prod = m.register('proddb', 'sqlite', 'prod', true);
  assertCode(() => m.setWriteMode('proddb', true, true), 'PROD_WRITE_NEVER');
  assertCode(() => m.assertWriteAllowed(prod, 'write'), 'PROD_WRITE_REFUSED');
  const ro = m.register('ro', 'sqlite', 'dev', true);
  assertCode(() => m.setWriteMode('ro', true, true), 'READONLY_CONNECTION');
  assertCode(() => m.assertWriteAllowed(ro, 'write'), 'READONLY_CONNECTION');
});

test('active connection: first registered wins, setActive switches, remove falls back', () => {
  const m = new MultiConnectionManager();
  assert.equal(m.active(), null);
  m.register('a', 'sqlite', 'dev', false);
  m.register('b', 'sqlite', 'dev', false);
  assert.equal(m.activeNameOnly(), 'a');
  m.setActive('b');
  assert.equal(m.activeNameOnly(), 'b');
  m.remove('b');
  assert.equal(m.activeNameOnly(), 'a');
  assertCode(() => m.setActive('nope'), 'UNKNOWN_CONNECTION');
  assertCode(() => m.register('bad name!', 'sqlite', 'dev', false), 'BAD_NAME');
});

test('stripSecretFields drops password-like keys at any depth', () => {
  const scrubbed = stripSecretFields({
    name: 'x',
    password: 'hunter2',
    nested: { api_key: 'k', host: 'h' },
    list: [{ token: 't', ok: 1 }],
  }) as Record<string, unknown>;
  assert.equal('password' in scrubbed, false);
  assert.equal((scrubbed['nested'] as Record<string, unknown>)['host'], 'h');
  assert.equal('api_key' in (scrubbed['nested'] as Record<string, unknown>), false);
  assert.equal('token' in ((scrubbed['list'] as unknown[])[0] as Record<string, unknown>), false);
  assert.equal(((scrubbed['list'] as unknown[])[0] as Record<string, unknown>)['ok'], 1);
});

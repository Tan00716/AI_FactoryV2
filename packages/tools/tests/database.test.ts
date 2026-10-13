/**
 * SPEC v2 §33 database environment identity tests:
 * explicit dev/staging/prod identity per connection, immutable env,
 * fail-closed prod-write gate, switch audits, no secret values.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_TOOLS,
  DatabaseEnvironmentRegistry,
  classifyStatement,
  isDbEnvironment,
  type DbAuditIntent,
} from '../src/index';

const NOW = 1_700_000_000_000;

function collector() {
  const intents: DbAuditIntent[] = [];
  return {
    intents,
    registry: new DatabaseEnvironmentRegistry({
      now: () => NOW,
      auditSink: (i) => intents.push(i),
    }),
  };
}

describe('database environment identity (§33)', () => {
  it('registration without environment defaults to dev, never prod', () => {
    const { registry, intents } = collector();
    const d = registry.registerConnection({ name: 'orders', credentialRefs: ['DB_PW'] });
    assert.equal(d.environment, 'dev');
    assert.deepEqual(d.credentialRefs, ['DB_PW']);
    assert.equal(d.registeredAt, new Date(NOW).toISOString());
    assert.equal(intents.length, 1);
    assert.equal(intents[0].type, 'DB_CONNECTION_REGISTERED');
    assert.equal(intents[0].environment, 'dev');
  });

  it('explicit staging and prod identities register', () => {
    const { registry } = collector();
    assert.equal(registry.registerConnection({ name: 's', environment: 'staging' }).environment, 'staging');
    assert.equal(registry.registerConnection({ name: 'p', environment: 'prod' }).environment, 'prod');
    assert.equal(registry.listConnections().length, 2);
  });

  it('environment identity is immutable: same name + different env throws', () => {
    const { registry } = collector();
    registry.registerConnection({ name: 'orders', environment: 'dev' });
    assert.throws(
      () => registry.registerConnection({ name: 'orders', environment: 'prod' }),
      /immutable/,
    );
    // The original identity is untouched.
    assert.equal(registry.getConnection('orders')?.environment, 'dev');
  });

  it('same name + same env re-registers (rotation-friendly) and re-audits', () => {
    const { registry, intents } = collector();
    registry.registerConnection({ name: 'orders', environment: 'staging', credentialRefs: ['OLD'] });
    const d = registry.registerConnection({ name: 'orders', environment: 'staging', credentialRefs: ['NEW'] });
    assert.deepEqual(d.credentialRefs, ['NEW']);
    assert.equal(intents.filter((i) => i.type === 'DB_CONNECTION_REGISTERED').length, 2);
  });

  it('invalid environment and invalid name are rejected', () => {
    const { registry } = collector();
    assert.throws(() => registry.registerConnection({ name: 'x', environment: 'production' as never }), /invalid environment/);
    assert.throws(() => registry.registerConnection({ name: '' }), /invalid connection name/);
  });

  it('deregister removes and audits; unknown name returns false silently', () => {
    const { registry, intents } = collector();
    registry.registerConnection({ name: 'orders', environment: 'prod' });
    assert.equal(registry.deregisterConnection('orders'), true);
    assert.equal(registry.getConnection('orders'), undefined);
    assert.equal(registry.deregisterConnection('orders'), false);
    assert.equal(intents.at(-1)?.type, 'DB_CONNECTION_DEREGISTERED');
  });

  it('returned descriptors are copies; stored credentialRefs cannot be mutated from outside', () => {
    const { registry } = collector();
    registry.registerConnection({ name: 'orders', credentialRefs: ['A'] });
    const d = registry.getConnection('orders')!;
    d.credentialRefs.push('EVIL');
    d.name = 'hacked';
    const again = registry.getConnection('orders')!;
    assert.deepEqual(again.credentialRefs, ['A']);
    assert.equal(again.name, 'orders');
  });
});

describe('classifyStatement (fail-closed)', () => {
  it('reads', () => {
    for (const sql of [
      'SELECT 1',
      'select * from t',
      '  -- a comment\nSELECT 1',
      '/* block */ WITH x AS (SELECT 1) SELECT * FROM x',
      'EXPLAIN SELECT 1',
      'SHOW TABLES',
      'DESCRIBE t',
    ]) {
      assert.equal(classifyStatement(sql), 'read', sql);
    }
  });

  it('writes, including PRAGMA and unknowns', () => {
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET a=1',
      'DELETE FROM t',
      'CREATE TABLE t (a)',
      'DROP TABLE t',
      'ALTER TABLE t ADD COLUMN b',
      'PRAGMA journal_mode=WAL',
      'VACUUM',
      'SOME_FUTURE_KEYWORD t',
      'SELECT 1; DROP TABLE t', // any write wins
    ]) {
      assert.equal(classifyStatement(sql), 'write', sql);
    }
  });
});

describe('authorizeQuery gate', () => {
  it('unknown connection is denied and audited; never guessed', () => {
    const { registry, intents } = collector();
    const r = registry.authorizeQuery({ connectionName: 'nope', sql: 'SELECT 1' });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'UNKNOWN_CONNECTION');
    assert.match(r.reason, /never guessed|must be registered/);
    assert.equal(intents.at(-1)?.type, 'DB_QUERY_DENIED');
  });

  it('empty statement is denied', () => {
    const { registry } = collector();
    registry.registerConnection({ name: 'd', environment: 'dev' });
    const r = registry.authorizeQuery({ connectionName: 'd', sql: '   ' });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'EMPTY_STATEMENT');
  });

  it('reads are authorized on every environment', () => {
    const { registry } = collector();
    registry.registerConnection({ name: 'd', environment: 'dev' });
    registry.registerConnection({ name: 's', environment: 'staging' });
    registry.registerConnection({ name: 'p', environment: 'prod' });
    for (const name of ['d', 's', 'p']) {
      const r = registry.authorizeQuery({ connectionName: name, sql: 'SELECT * FROM orders' });
      assert.equal(r.allowed, true, name);
      assert.equal(r.code, 'OK');
      assert.equal(r.statementKind, 'read');
    }
  });

  it('writes are authorized on dev and staging without confirmation', () => {
    const { registry } = collector();
    registry.registerConnection({ name: 'd', environment: 'dev' });
    registry.registerConnection({ name: 's', environment: 'staging' });
    for (const name of ['d', 's']) {
      const r = registry.authorizeQuery({ connectionName: name, sql: "INSERT INTO t VALUES (1)" });
      assert.equal(r.allowed, true, name);
      assert.equal(r.statementKind, 'write');
    }
  });

  it('prod write without confirmation is denied; ATTEMPT then DENIED audited', () => {
    const { registry, intents } = collector();
    registry.registerConnection({ name: 'p', environment: 'prod' });
    const before = intents.length;
    const r = registry.authorizeQuery({ connectionName: 'p', sql: 'DELETE FROM orders', actor: 'agent-1' });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'PROD_WRITE_REQUIRES_CONFIRMATION');
    assert.match(r.reason, /prodWriteConfirmed/);
    const seq = intents.slice(before).map((i) => i.type);
    assert.deepEqual(seq, ['DB_PROD_WRITE_ATTEMPT', 'DB_PROD_WRITE_DENIED']);
    assert.equal(intents.at(-1)?.actor, 'agent-1');
  });

  it('prod write with literal prodWriteConfirmed: true is authorized; ATTEMPT then CONFIRMED audited', () => {
    const { registry, intents } = collector();
    registry.registerConnection({ name: 'p', environment: 'prod' });
    const before = intents.length;
    const r = registry.authorizeQuery({
      connectionName: 'p',
      sql: 'UPDATE orders SET status=1',
      prodWriteConfirmed: true,
      actor: 'agent-1',
    });
    assert.equal(r.allowed, true);
    assert.equal(r.code, 'OK');
    assert.equal(r.environment, 'prod');
    const seq = intents.slice(before).map((i) => i.type);
    assert.deepEqual(seq, ['DB_PROD_WRITE_ATTEMPT', 'DB_PROD_WRITE_CONFIRMED']);
  });

  it("truthy non-true prodWriteConfirmed ('yes') does not count", () => {
    const { registry } = collector();
    registry.registerConnection({ name: 'p', environment: 'prod' });
    const r = registry.authorizeQuery({
      connectionName: 'p',
      sql: 'DELETE FROM orders',
      prodWriteConfirmed: 'yes' as unknown as boolean,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'PROD_WRITE_REQUIRES_CONFIRMATION');
  });
});

describe('switch auditing', () => {
  it('authorizeQuery with a different previousConnectionName emits DB_CONNECTION_SWITCHED', () => {
    const { registry, intents } = collector();
    registry.registerConnection({ name: 'd', environment: 'dev' });
    registry.registerConnection({ name: 'p', environment: 'prod' });
    registry.authorizeQuery({ connectionName: 'p', sql: 'SELECT 1', previousConnectionName: 'd', actor: 'a' });
    const sw = intents.find((i) => i.type === 'DB_CONNECTION_SWITCHED');
    assert.ok(sw);
    assert.equal(sw!.connectionName, 'p');
    assert.equal(sw!.environment, 'prod');
    assert.match(sw!.reason!, /"d" to "p"/);
  });

  it('same or missing previous connection emits no switch', () => {
    const { registry, intents } = collector();
    registry.registerConnection({ name: 'd', environment: 'dev' });
    registry.authorizeQuery({ connectionName: 'd', sql: 'SELECT 1', previousConnectionName: 'd' });
    registry.authorizeQuery({ connectionName: 'd', sql: 'SELECT 1' });
    assert.equal(intents.filter((i) => i.type === 'DB_CONNECTION_SWITCHED').length, 0);
  });

  it('auditSwitch is explicit and no-ops on equal names', () => {
    const { registry, intents } = collector();
    registry.registerConnection({ name: 'd', environment: 'dev' });
    registry.auditSwitch('d', 'd');
    registry.auditSwitch(undefined, 'd');
    assert.equal(intents.filter((i) => i.type === 'DB_CONNECTION_SWITCHED').length, 0);
  });
});

describe('db.query definition alignment', () => {
  it('definition carries the identity fields as optional inputs', () => {
    const def = BUILTIN_TOOLS.find((t) => t.id === 'db.query')!;
    assert.equal(def.implementationStatus, 'definition-only');
    assert.equal(def.inputSchema.sql.required, true);
    assert.equal(def.inputSchema.connectionName?.type, 'string');
    assert.equal(def.inputSchema.connectionName?.required, false);
    assert.equal(def.inputSchema.prodWriteConfirmed?.type, 'boolean');
    assert.equal(def.inputSchema.prodWriteConfirmed?.required, false);
  });

  it('isDbEnvironment accepts exactly the three identities', () => {
    assert.equal(isDbEnvironment('dev'), true);
    assert.equal(isDbEnvironment('staging'), true);
    assert.equal(isDbEnvironment('prod'), true);
    assert.equal(isDbEnvironment('production'), false);
    assert.equal(isDbEnvironment('uat'), false);
    assert.equal(isDbEnvironment(undefined), false);
  });
});

/**
 * SPEC v2 §33 least-privilege Broker/Runbook tests:
 * per-connection operation/table whitelists after the registry gate,
 * host-injected engines (no engine = loud refusal, never faked execution),
 * named runbook templates with exact scalar-only params, full audit chain.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DatabaseEnvironmentRegistry,
  DbBroker,
  checkPrivilege,
  extractOperations,
  extractTables,
  normalizeTableName,
  operationOfKeyword,
  type DbAuditIntent,
  type DbBrokerExecuteInput,
  type DbEngineExecuteInput,
  type DbQueryEngine,
} from '../src/index';

const NOW = 1_700_000_000_000;

function harness() {
  const intents: DbAuditIntent[] = [];
  const sink = (i: DbAuditIntent) => intents.push(i);
  const registry = new DatabaseEnvironmentRegistry({ now: () => NOW, auditSink: sink });
  const broker = new DbBroker(registry, { now: () => NOW, auditSink: sink });
  return { intents, registry, broker };
}

function fakeEngine(
  rows: Array<Record<string, unknown>> = [{ a: 1 }],
  opts: { fail?: string } = {},
): { engine: DbQueryEngine; calls: DbEngineExecuteInput[] } {
  const calls: DbEngineExecuteInput[] = [];
  const engine: DbQueryEngine = {
    async execute(input: DbEngineExecuteInput) {
      calls.push(input);
      if (opts.fail) throw new Error(opts.fail);
      return { rows, rowCount: rows.length, durationMs: 3 };
    },
  };
  return { engine, calls };
}

function readyBroker(env: 'dev' | 'staging' | 'prod' = 'dev') {
  const h = harness();
  h.registry.registerConnection({ name: 'c', environment: env, credentialRefs: ['DB_PW'] });
  return h;
}

describe('operationOfKeyword / extractOperations', () => {
  it('maps first keywords to least-privilege buckets', () => {
    assert.equal(operationOfKeyword('select'), 'read');
    assert.equal(operationOfKeyword('WITH'), 'read');
    assert.equal(operationOfKeyword('INSERT'), 'insert');
    assert.equal(operationOfKeyword('update'), 'update');
    assert.equal(operationOfKeyword('DELETE'), 'delete');
    assert.equal(operationOfKeyword('CREATE'), 'ddl');
    assert.equal(operationOfKeyword('alter'), 'ddl');
    assert.equal(operationOfKeyword('DROP'), 'ddl');
    assert.equal(operationOfKeyword('TRUNCATE'), 'ddl');
    assert.equal(operationOfKeyword('PRAGMA'), 'other');
    assert.equal(operationOfKeyword('VACUUM'), 'other');
    assert.equal(operationOfKeyword('SOME_FUTURE'), 'other');
  });

  it('extractOperations covers every statement in a multi-statement string', () => {
    assert.deepEqual(extractOperations('SELECT 1; DELETE FROM t'), ['read', 'delete']);
    assert.deepEqual(extractOperations('  -- only a comment'), []);
  });
});

describe('extractTables (best-effort, documented)', () => {
  it('FROM / JOIN / comma lists / subqueries / schema-qualified / quoted', () => {
    assert.deepEqual(extractTables('SELECT * FROM orders'), ['orders']);
    assert.deepEqual(extractTables('SELECT * FROM orders o JOIN users u ON o.uid=u.id'), ['orders', 'users']);
    assert.deepEqual(extractTables('SELECT * FROM a, b, c'), ['a', 'b', 'c']);
    assert.deepEqual(
      extractTables('SELECT * FROM (SELECT id FROM secret) x'),
      ['secret'],
    );
    assert.deepEqual(extractTables('SELECT * FROM sales.orders'), ['sales.orders']);
    assert.deepEqual(extractTables('SELECT * FROM "My Table"'), ['my table']);
    assert.deepEqual(extractTables('SELECT * FROM [dbo].[Users]'), ['dbo.users']);
    assert.deepEqual(extractTables("INSERT INTO t SELECT * FROM s WHERE x='FROM fake'"), ['t', 's']);    assert.deepEqual(extractTables('UPDATE t SET a=1'), ['t']);
    assert.deepEqual(extractTables('DELETE FROM t'), ['t']);
    assert.deepEqual(extractTables('CREATE TABLE t (a INT)'), ['t']);
    assert.deepEqual(extractTables('TRUNCATE t'), ['t']);
    assert.deepEqual(extractTables('-- FROM nowhere\nSELECT 1'), []);
    // Single-pass stripping: a quote inside a comment must not hide a real
    // table (that would be the unsafe direction for a whitelist).
    assert.deepEqual(extractTables("/* it's */ SELECT * FROM secret"), ['secret']);
    assert.deepEqual(extractTables("SELECT '/*' FROM secret"), ['secret']);
  });
});

describe('checkPrivilege', () => {
  const policy = { connectionName: 'c', operations: ['read' as const], tables: ['orders'] };

  it('passes when operation and tables are whitelisted', () => {
    const r = checkPrivilege('SELECT * FROM orders', policy);
    assert.equal(r.ok, true);
  });

  it('denies and names a non-whitelisted operation', () => {
    const r = checkPrivilege('INSERT INTO orders VALUES (1)', policy);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /'insert'/);
  });

  it('denies and names a non-whitelisted table', () => {
    const r = checkPrivilege('SELECT * FROM users', policy);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /"users"/);
  });

  it("'*' tables permits any table", () => {
    const r = checkPrivilege('SELECT * FROM anything_at_all', { ...policy, tables: ['*'] });
    assert.equal(r.ok, true);
  });

  it('write with no determinable target table is refused (fail-closed)', () => {
    const p = { connectionName: 'c', operations: ['other' as const], tables: ['*'] };
    const r = checkPrivilege('VACUUM', p);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /fail-closed/);
  });

  it('table-less read passes vacuously when reads are allowed', () => {
    const r = checkPrivilege('SELECT 1', policy);
    assert.equal(r.ok, true);
  });
});

describe('DbBroker: registration-time binding', () => {
  it('policy and engine require a registered connection', () => {
    const { broker } = harness();
    assert.throws(
      () => broker.setPrivilegePolicy({ connectionName: 'ghost', operations: ['read'], tables: [] }),
      /unknown database connection/,
    );
    assert.throws(
      () => broker.registerEngine('ghost', fakeEngine().engine),
      /unknown database connection/,
    );
  });

  it('invalid operation buckets are rejected at policy time', () => {
    const { broker, registry } = harness();
    registry.registerConnection({ name: 'c' });
    assert.throws(
      () => broker.setPrivilegePolicy({ connectionName: 'c', operations: ['everything' as never], tables: [] }),
      /invalid operation bucket/,
    );
  });

  it('engine must expose execute()', () => {
    const { broker, registry } = harness();
    registry.registerConnection({ name: 'c' });
    assert.throws(() => broker.registerEngine('c', {} as never), /async execute/);
  });

  it('policy round-trips as a copy; deregisterEngine returns false when absent', () => {
    const { broker, registry, intents } = harness();
    registry.registerConnection({ name: 'c' });
    const p = broker.setPrivilegePolicy({ connectionName: 'c', operations: ['read'], tables: ['orders'] }, 'op-1');
    p.tables.push('EVIL');
    assert.deepEqual(broker.getPrivilegePolicy('c')!.tables, ['orders']);
    assert.equal(broker.deregisterEngine('c'), false);
    assert.equal(
      intents.find((i) => i.type === 'DB_BROKER_POLICY_SET')?.actor,
      'op-1',
    );
  });
});

describe('DbBroker.execute: gate → whitelist → engine', () => {
  function wired(env: 'dev' | 'staging' | 'prod' = 'dev', policy = { operations: ['read' as const], tables: ['orders'] }) {
    const h = readyBroker(env);
    h.broker.setPrivilegePolicy({ connectionName: 'c', ...policy });
    const f = fakeEngine([{ id: 7 }]);
    h.broker.registerEngine('c', f.engine);
    return { ...h, calls: f.calls };
  }

  it('happy path: gates pass, engine runs, full audit', async () => {
    const { broker, intents, calls } = wired();
    const r = await broker.execute({ connectionName: 'c', sql: 'SELECT * FROM orders', actor: 'agent-9' });
    assert.equal(r.allowed, true);
    assert.equal(r.executed, true);
    assert.equal(r.code, 'OK');
    assert.deepEqual(r.rows, [{ id: 7 }]);
    assert.equal(r.rowCount, 1);
    const done = intents.find((i) => i.type === 'DB_BROKER_EXECUTED')!;
    assert.ok(done);
    assert.equal(done.actor, 'agent-9');
    assert.equal(done.sql, 'SELECT * FROM orders');
    assert.equal(done.allowed, true);
    assert.equal(done.rowCount, 1);
  });

  it('unknown connection: gate denies first, broker denial follows (chain pinned)', async () => {
    const { broker, intents } = harness();
    const r = await broker.execute({ connectionName: 'nope', sql: 'SELECT 1' });
    assert.equal(r.allowed, false);
    assert.equal(r.executed, false);
    assert.equal(r.code, 'UNKNOWN_CONNECTION');
    const seq = intents.map((i) => i.type);
    assert.deepEqual(seq, ['DB_QUERY_DENIED', 'DB_BROKER_DENIED']);
  });

  it('prod write without confirmation is stopped by the registry gate', async () => {
    const { broker, intents, calls } = wired('prod');
    const r = await broker.execute({ connectionName: 'c', sql: 'SELECT * FROM orders', actor: 'a' });
    assert.equal(r.allowed, true); // reads are fine on prod
    assert.equal(calls.length, 1);
    intents.length = 0;
    const w = await broker.execute({ connectionName: 'c', sql: 'DELETE FROM orders' });
    assert.equal(w.allowed, false);
    assert.equal(w.code, 'GATE_DENIED');
    const seq = intents.map((i) => i.type);
    assert.deepEqual(seq, ['DB_PROD_WRITE_ATTEMPT', 'DB_PROD_WRITE_DENIED', 'DB_BROKER_DENIED']);
  });

  it('prod write with confirmation still needs the whitelist', async () => {
    const { broker, calls } = wired('prod');
    const r = await broker.execute({
      connectionName: 'c',
      sql: 'DELETE FROM orders',
      prodWriteConfirmed: true,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'PRIVILEGE_DENIED');
    assert.match(r.reason, /'delete'/);
    assert.equal(calls.length, 0);
  });

  it('missing policy is a loud denial, not an open door', async () => {
    const h = readyBroker();
    const f = fakeEngine();
    h.broker.registerEngine('c', f.engine);
    const r = await h.broker.execute({ connectionName: 'c', sql: 'SELECT 1' });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'PRIVILEGE_DENIED');
    assert.match(r.reason, /no least-privilege policy/);
    assert.equal(f.calls.length, 0);
  });

  it('non-scalar params are refused before the engine sees them', async () => {
    const { broker, calls } = wired();
    const r = await broker.execute({
      connectionName: 'c',
      sql: 'SELECT 1',
      params: { x: { nested: true } },
    } as DbBrokerExecuteInput);
    assert.equal(r.code, 'INVALID_PARAMS');
    assert.equal(calls.length, 0);
  });

  it('no engine: loud refusal, never faked execution', async () => {
    const h = readyBroker();
    h.broker.setPrivilegePolicy({ connectionName: 'c', operations: ['read'], tables: ['*'] });
    const r = await h.broker.execute({ connectionName: 'c', sql: 'SELECT 1' });
    assert.equal(r.allowed, true); // authorization passed
    assert.equal(r.executed, false);
    assert.equal(r.code, 'NO_ENGINE');
    assert.match(r.reason, /refuses to pretend/);
    assert.equal(h.intents.at(-1)?.type, 'DB_BROKER_NO_ENGINE');
  });

  it('engine failure is reported honestly, not as a denial of permission', async () => {
    const h = readyBroker();
    h.broker.setPrivilegePolicy({ connectionName: 'c', operations: ['read'], tables: ['*'] });
    h.broker.registerEngine('c', fakeEngine([], { fail: 'boom' }).engine);
    const r = await h.broker.execute({ connectionName: 'c', sql: 'SELECT 1' });
    assert.equal(r.allowed, true);
    assert.equal(r.executed, false);
    assert.equal(r.code, 'EXECUTION_FAILED');
    assert.match(r.reason, /boom/);
    assert.equal(h.intents.at(-1)?.type, 'DB_BROKER_EXECUTION_FAILED');
  });
});

describe('Runbook: registration is the approval', () => {
  function withEngine(env: 'dev' | 'staging' | 'prod' = 'dev') {
    const h = readyBroker(env);
    const f = fakeEngine([{ n: 2 }]);
    h.broker.registerEngine('c', f.engine);
    return { ...h, calls: f.calls };
  }

  it('registers a template; placeholders and slots must match exactly', () => {
    const { broker, registry, intents } = harness();
    registry.registerConnection({ name: 'c' });
    const t = broker.registerRunbookTemplate({
      name: 'orders-by-id',
      connectionName: 'c',
      sqlTemplate: 'SELECT * FROM orders WHERE id = :id',
      slots: ['id'],
      actor: 'op-2',
    });
    assert.equal(t.statementKind, 'read');
    assert.deepEqual(t.slots, ['id']);
    const reg = intents.find((i) => i.type === 'DB_RUNBOOK_REGISTERED')!;
    assert.equal(reg.templateName, 'orders-by-id');
    assert.equal(reg.actor, 'op-2');
  });

  it('registration rejects: unknown connection, undeclared placeholder, unused slot, multi-statement, dupes, bad names', () => {
    const { broker, registry } = harness();
    registry.registerConnection({ name: 'c' });
    const base = { connectionName: 'c', sqlTemplate: 'SELECT :a', slots: ['a'] };
    assert.throws(() => broker.registerRunbookTemplate({ ...base, name: 'x', connectionName: 'ghost' }), /unknown database connection/);
    assert.throws(
      () => broker.registerRunbookTemplate({ ...base, name: 'x', sqlTemplate: 'SELECT :a, :hidden', slots: ['a'] }),
      /not a declared slot/,
    );
    assert.throws(
      () => broker.registerRunbookTemplate({ ...base, name: 'x', slots: ['a', 'unused'] }),
      /does not appear in the template/,
    );
    assert.throws(
      () => broker.registerRunbookTemplate({ ...base, name: 'x', sqlTemplate: 'SELECT :a; DELETE FROM t' }),
      /single statement/,
    );
    assert.throws(
      () => broker.registerRunbookTemplate({ ...base, name: 'x', slots: ['a', 'a'] }),
      /duplicate slot/,
    );
    assert.throws(() => broker.registerRunbookTemplate({ ...base, name: '' }), /invalid runbook template name/);
  });

  it('run: engine receives template text + params separately (never interpolated)', async () => {
    const { broker, calls } = withEngine();
    broker.registerRunbookTemplate({
      name: 'by-id',
      connectionName: 'c',
      sqlTemplate: 'SELECT * FROM orders WHERE id = :id',
      slots: ['id'],
    });
    const r = await broker.runRunbook({ templateName: 'by-id', params: { id: 42 }, actor: 'agent-3' });
    assert.equal(r.code, 'OK');
    assert.equal(r.executed, true);
    assert.equal(calls.length, 1);
    // The engine got the template VERBATIM (placeholder intact) and params apart.
    assert.equal(calls[0].sql, 'SELECT * FROM orders WHERE id = :id');
    assert.deepEqual(calls[0].params, { id: 42 });
    assert.ok(!calls[0].sql.includes('42'), 'value must not be interpolated into SQL');
  });

  it('run: params must match declared slots exactly', async () => {
    const { broker, calls } = withEngine();
    broker.registerRunbookTemplate({
      name: 'by-id',
      connectionName: 'c',
      sqlTemplate: 'SELECT * FROM orders WHERE id = :id',
      slots: ['id'],
    });
    const missing = await broker.runRunbook({ templateName: 'by-id', params: {} });
    assert.equal(missing.code, 'PARAM_MISMATCH');
    assert.match(missing.reason, /missing: id/);
    const extra = await broker.runRunbook({ templateName: 'by-id', params: { id: 1, sneaky: 2 } });
    assert.equal(extra.code, 'PARAM_MISMATCH');
    assert.match(extra.reason, /extra: sneaky/);
    assert.equal(calls.length, 0);
  });

  it('run: non-scalar params refused', async () => {
    const { broker, calls } = withEngine();
    broker.registerRunbookTemplate({
      name: 'by-id',
      connectionName: 'c',
      sqlTemplate: 'SELECT * FROM orders WHERE id = :id',
      slots: ['id'],
    });
    const r = await broker.runRunbook({ templateName: 'by-id', params: { id: [1, 2] } });
    assert.equal(r.code, 'INVALID_PARAMS');
    assert.equal(calls.length, 0);
  });

  it('run: unknown template is denied', async () => {
    const { broker, intents } = withEngine();
    const r = await broker.runRunbook({ templateName: 'nope', params: {} });
    assert.equal(r.code, 'UNKNOWN_TEMPLATE');
    assert.equal(intents.at(-1)?.type, 'DB_RUNBOOK_DENIED');
  });

  it('run: prod write template still needs confirmation (gate applies)', async () => {
    const { broker, calls } = withEngine('prod');
    broker.registerRunbookTemplate({
      name: 'close-order',
      connectionName: 'c',
      sqlTemplate: 'UPDATE orders SET status = :status WHERE id = :id',
      slots: ['status', 'id'],
    });
    const denied = await broker.runRunbook({ templateName: 'close-order', params: { status: 'x', id: 1 } });
    assert.equal(denied.code, 'GATE_DENIED');
    const ok = await broker.runRunbook({
      templateName: 'close-order',
      params: { status: 'x', id: 1 },
      prodWriteConfirmed: true,
    });
    assert.equal(ok.code, 'OK');
    assert.equal(calls.length, 1);
  });

  it('run: runbook skips the ad-hoc whitelist BY DESIGN (registration was the approval)', async () => {
    // Policy allows reads on `orders` only; the template reads `audit_log`.
    // This is the documented design: a registered template is pre-approved,
    // not ad-hoc SQL. The registry gate still applies.
    const { broker, calls } = withEngine();
    broker.setPrivilegePolicy({ connectionName: 'c', operations: ['read'], tables: ['orders'] });
    broker.registerRunbookTemplate({
      name: 'audit-tail',
      connectionName: 'c',
      sqlTemplate: 'SELECT * FROM audit_log LIMIT :n',
      slots: ['n'],
    });
    const r = await broker.runRunbook({ templateName: 'audit-tail', params: { n: 10 } });
    assert.equal(r.code, 'OK');
    assert.equal(calls.length, 1);
  });

  it('run: no engine means loud refusal; audit chain pinned', async () => {
    const h = readyBroker();
    h.broker.registerRunbookTemplate({
      name: 'by-id',
      connectionName: 'c',
      sqlTemplate: 'SELECT * FROM orders WHERE id = :id',
      slots: ['id'],
    });
    const r = await h.broker.runRunbook({ templateName: 'by-id', params: { id: 1 } });
    assert.equal(r.allowed, true);
    assert.equal(r.executed, false);
    assert.equal(r.code, 'NO_ENGINE');
    const done = h.intents.find((i) => i.type === 'DB_RUNBOOK_DENIED')!;
    assert.match(done.reason!, /refuses to pretend/);
  });

  it('run: full audit on success carries template name, sql, rowCount', async () => {
    const { broker, intents } = withEngine();
    broker.registerRunbookTemplate({
      name: 'by-id',
      connectionName: 'c',
      sqlTemplate: 'SELECT * FROM orders WHERE id = :id',
      slots: ['id'],
    });
    await broker.runRunbook({ templateName: 'by-id', params: { id: 1 }, actor: 'a1' });
    const done = intents.find((i) => i.type === 'DB_RUNBOOK_EXECUTED')!;
    assert.equal(done.templateName, 'by-id');
    assert.equal(done.sql, 'SELECT * FROM orders WHERE id = :id');
    assert.equal(done.allowed, true);
    assert.equal(done.rowCount, 1);
    assert.equal(done.actor, 'a1');
    // Bound VALUES are never audited: no intent carries a `params` field,
    // and the SQL keeps the placeholder (never the value).
    for (const i of intents) {
      assert.ok(!('params' in i), 'bound param values must never enter the audit trail');
    }
    assert.ok(done.sql!.includes(':id'));
  });

  it('deregister removes the template and audits', async () => {
    const { broker, intents } = withEngine();
    broker.registerRunbookTemplate({
      name: 't',
      connectionName: 'c',
      sqlTemplate: 'SELECT 1',
      slots: [],
    });
    assert.equal(broker.deregisterRunbookTemplate('t', 'op-x'), true);
    assert.equal(broker.deregisterRunbookTemplate('t'), false);
    const r = await broker.runRunbook({ templateName: 't', params: {} });
    assert.equal(r.code, 'UNKNOWN_TEMPLATE');
    assert.equal(intents.find((i) => i.type === 'DB_RUNBOOK_DEREGISTERED')?.actor, 'op-x');
  });

  it('template copies cannot mutate the registry', () => {
    const { broker, registry } = harness();
    registry.registerConnection({ name: 'c' });
    broker.registerRunbookTemplate({ name: 't', connectionName: 'c', sqlTemplate: 'SELECT 1', slots: [] });
    broker.getRunbookTemplate('t')!.slots.push('EVIL');
    assert.deepEqual(broker.getRunbookTemplate('t')!.slots, []);
  });
});

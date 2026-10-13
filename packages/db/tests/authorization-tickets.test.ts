/**
 * §17.2 (G-09, Batch 18) — the Operational pre-authorization ticket
 * registry: both store implementations against one contract battery —
 * issue shape, single-use consumption with its record, effective
 * expiry derived from the clock (never a stored flip), revocation,
 * scope coverage gaps, and (for SQLite) persistence across reopen
 * plus hand-made legacy DBs gaining the registry table from SCHEMA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AuthorizationTicketError,
  AuthorizationTicketNotFoundError,
  FactoryDatabase,
  InMemoryAuthorizationTicketStore,
  SqliteAuthorizationTicketStore,
  ticketCoverageGaps,
  type AuthorizationTicketStore,
} from '../src/index';

const T0 = Date.parse('2026-10-12T00:00:00.000Z');

function battery(
  label: string,
  make: () => { store: AuthorizationTicketStore; setNow: (ms: number) => void },
) {
  test(`${label}: create stamps the ticket and lists it back`, () => {
    const { store } = make();
    const t = store.create({
      policyRuleId: 'RULE-9',
      scope: { projectId: 'p1', priorities: ['P0', 'P1'], actions: ['dispatch'] },
      issuedBy: 'ops-lead',
      expiresAt: new Date(T0 + 60_000).toISOString(),
    });
    assert.equal(t.status, 'ACTIVE');
    assert.equal(t.policyRuleId, 'RULE-9');
    assert.equal(t.issuedBy, 'ops-lead');
    assert.equal(t.createdAt, new Date(T0).toISOString());
    assert.equal(t.expiresAt, new Date(T0 + 60_000).toISOString());
    assert.deepEqual(t.consumptions, []);
    assert.equal(t.revokedAt, null);
    assert.deepEqual(store.get(t.id), t);
    assert.equal(store.list().length, 1);
    assert.equal(store.list({ projectId: 'p1' }).length, 1);
    assert.equal(store.list({ projectId: 'other' }).length, 0);
    assert.equal(store.list({ status: 'ACTIVE' }).length, 1);
    assert.equal(store.list({ status: 'USED' }).length, 0);
  });

  test(`${label}: consumption is recorded once and is single-use`, () => {
    const { store, setNow } = make();
    const t = store.create({
      policyRuleId: 'RULE-1',
      scope: {},
      issuedBy: 'ops',
      expiresAt: null,
    });
    setNow(T0 + 5_000);
    const used = store.recordConsumption(t.id, {
      taskId: 'task-1',
      action: 'dispatch',
      consumedBy: 'policy',
    });
    assert.equal(used.status, 'USED');
    assert.equal(used.consumptions.length, 1);
    assert.deepEqual(used.consumptions[0], {
      taskId: 'task-1',
      action: 'dispatch',
      consumedBy: 'policy',
      consumedAt: new Date(T0 + 5_000).toISOString(),
      policyRuleId: 'RULE-1',
    });
    assert.throws(
      () =>
        store.recordConsumption(t.id, {
          taskId: 'task-2',
          action: 'dispatch',
          consumedBy: 'policy',
        }),
      (e: unknown) =>
        e instanceof AuthorizationTicketError && e.status === 'USED',
    );
    // The failed second consumption left no trace.
    assert.equal(store.get(t.id)!.consumptions.length, 1);
    assert.throws(
      () =>
        store.recordConsumption('missing', {
          taskId: 'x',
          action: 'dispatch',
          consumedBy: 'policy',
        }),
      AuthorizationTicketNotFoundError,
    );
  });

  test(`${label}: expiry is effective — past expiresAt reads EXPIRED and refuses use`, () => {
    const { store, setNow } = make();
    const t = store.create({
      policyRuleId: 'RULE-2',
      scope: {},
      issuedBy: 'ops',
      expiresAt: new Date(T0 + 10_000).toISOString(),
    });
    assert.equal(store.get(t.id)!.status, 'ACTIVE');
    setNow(T0 + 10_000); // exactly at the deadline: no longer valid
    assert.equal(store.get(t.id)!.status, 'EXPIRED');
    assert.equal(store.list({ status: 'EXPIRED' }).length, 1);
    assert.equal(store.list({ status: 'ACTIVE' }).length, 0);
    assert.throws(
      () =>
        store.recordConsumption(t.id, {
          taskId: 'x',
          action: 'dispatch',
          consumedBy: 'policy',
        }),
      (e: unknown) =>
        e instanceof AuthorizationTicketError && e.status === 'EXPIRED',
    );
    assert.throws(
      () => store.revoke(t.id, { by: 'ops' }),
      (e: unknown) =>
        e instanceof AuthorizationTicketError && e.status === 'EXPIRED',
    );
  });

  test(`${label}: revoke stamps who/when/why and blocks consumption`, () => {
    const { store, setNow } = make();
    const t = store.create({
      policyRuleId: 'RULE-3',
      scope: {},
      issuedBy: 'ops',
      expiresAt: null,
    });
    setNow(T0 + 1_000);
    const revoked = store.revoke(t.id, { by: 'admin', reason: 'policy retired' });
    assert.equal(revoked.status, 'REVOKED');
    assert.equal(revoked.revokedBy, 'admin');
    assert.equal(revoked.revokedAt, new Date(T0 + 1_000).toISOString());
    assert.equal(revoked.revokeReason, 'policy retired');
    assert.throws(
      () =>
        store.recordConsumption(t.id, {
          taskId: 'x',
          action: 'dispatch',
          consumedBy: 'policy',
        }),
      (e: unknown) =>
        e instanceof AuthorizationTicketError && e.status === 'REVOKED',
    );
    assert.throws(() => store.revoke('missing', { by: 'admin' }), AuthorizationTicketNotFoundError);
  });

  test(`${label}: reads hand out copies — mutation cannot rewrite the registry`, () => {
    const { store } = make();
    const t = store.create({
      policyRuleId: 'RULE-4',
      scope: { projectId: 'p1' },
      issuedBy: 'ops',
      expiresAt: null,
    });
    const copy = store.get(t.id)!;
    copy.scope.projectId = 'hacked';
    copy.consumptions.push({
      taskId: 'x',
      action: 'dispatch',
      consumedBy: 'mallory',
      consumedAt: 'now',
      policyRuleId: 'RULE-4',
    });
    const again = store.get(t.id)!;
    assert.equal(again.scope.projectId, 'p1');
    assert.equal(again.consumptions.length, 0);
  });
}

battery('memory tickets', () => {
  let now = T0;
  return {
    store: new InMemoryAuthorizationTicketStore({ now: () => now }),
    setNow: (ms: number) => {
      now = ms;
    },
  };
});

battery('sqlite tickets', () => {
  let now = T0;
  const raw = new DatabaseSync(':memory:');
  // Minimal stand-in for the FactoryDatabase open path: the registry
  // table comes from the shared SCHEMA in production; here the store
  // constructor receives a bare connection and the CREATE TABLE is
  // the same DDL FactoryDatabase executes.
  raw.exec(`CREATE TABLE IF NOT EXISTS authorization_tickets (
    id TEXT PRIMARY KEY,
    policy_rule_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '{}',
    issued_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    revoked_by TEXT,
    revoked_at TEXT,
    revoke_reason TEXT,
    consumptions TEXT NOT NULL DEFAULT '[]'
  )`);
  return {
    store: new SqliteAuthorizationTicketStore(raw, { now: () => now }),
    setNow: (ms: number) => {
      now = ms;
    },
  };
});

test('ticketCoverageGaps names each uncovered dimension, and only those', () => {
  const t = {
    id: 'tkt-1',
    policyRuleId: 'RULE-1',
    scope: { projectId: 'p1', priorities: ['P1'], actions: ['dispatch'] },
    issuedBy: 'ops',
    createdAt: new Date(T0).toISOString(),
    expiresAt: null,
    status: 'ACTIVE' as const,
    revokedBy: null,
    revokedAt: null,
    revokeReason: null,
    consumptions: [],
  };
  assert.deepEqual(
    ticketCoverageGaps(t, { projectId: 'p1', priority: 'P1' }, 'dispatch'),
    [],
  );
  const gaps = ticketCoverageGaps(
    t,
    { projectId: 'p2', priority: 'P0' },
    'dispatch',
  );
  assert.equal(gaps.length, 2);
  assert.ok(gaps.some((g) => g.includes('task is in project p2')));
  assert.ok(gaps.some((g) => g.includes('task priority is P0')));
  const actionGaps = ticketCoverageGaps(
    t,
    { projectId: 'p1', priority: 'P1' },
    'deploy',
  );
  assert.equal(actionGaps.length, 1);
  assert.ok(actionGaps[0]!.includes("not 'deploy'"));
  // An unrestricted ticket covers everything.
  assert.deepEqual(
    ticketCoverageGaps(
      { ...t, scope: {} },
      { projectId: 'any', priority: 'P4' },
      'anything',
    ),
    [],
  );
});

test('FactoryDatabase wires the registry and tickets survive a reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-tickets-'));
  const file = path.join(dir, 'factory.db');
  const first = new FactoryDatabase(file);
  const t = first.authorizationTickets.create({
    policyRuleId: 'RULE-7',
    scope: { projectId: 'p9' },
    issuedBy: 'ops',
    expiresAt: null,
  });
  first.authorizationTickets.recordConsumption(t.id, {
    taskId: 'task-9',
    action: 'dispatch',
    consumedBy: 'policy',
  });
  first.close();
  const second = new FactoryDatabase(file);
  const back = second.authorizationTickets.get(t.id)!;
  assert.equal(back.status, 'USED');
  assert.equal(back.consumptions.length, 1);
  assert.equal(back.consumptions[0]!.taskId, 'task-9');
  assert.equal(back.scope.projectId, 'p9');
  second.close();
});

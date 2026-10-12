/**
 * Tests for the §32 audit hash chain (packages/core/src/audit.ts):
 * chained append, tamper/reorder detection, reason/result fidelity,
 * external-mutation isolation, and legacy (pre-chaining) record semantics.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_CHAIN_GENESIS,
  AuditLog,
  AuditRecord,
  InMemoryAuditStore,
  verifyAuditChain,
} from '../src/index';

/** A record as written before §32 chaining existed: no hash/reason/result. */
function legacyRecord(id: string): AuditRecord {
  return {
    id,
    ts: '2026-01-01T00:00:00.000Z',
    actor: 'human',
    action: 'LEGACY_ACTION',
    entityType: 'task',
    entityId: id,
    details: { old: true },
  };
}

describe('audit hash chain (§32)', () => {
  it('chains consecutive records: genesis head, each prevHash links the prior summaryHash', () => {
    const log = new AuditLog();
    const a = log.record('human', 'AGENT_CREATED', 'agent', 'a1');
    const b = log.record('ai-pm', 'TASK_CREATED', 'task', 't1');
    const c = log.record('system', 'DEPLOYED', 'release', 'r1');

    assert.equal(a.prevHash, AUDIT_CHAIN_GENESIS);
    assert.equal(b.prevHash, a.summaryHash);
    assert.equal(c.prevHash, b.summaryHash);
    for (const r of [a, b, c]) assert.match(r.summaryHash!, /^[0-9a-f]{64}$/);

    const v = log.verify();
    assert.deepEqual(v, { ok: true, verifiedCount: 3, legacyCount: 0 });
  });

  it('detects tampering with a middle record\u2019s details at exactly that index', () => {
    const log = new AuditLog();
    log.record('human', 'A', 'task', 't1', { n: 1 });
    log.record('human', 'B', 'task', 't2', { n: 2 });
    log.record('human', 'C', 'task', 't3', { n: 3 });

    const tampered = log.list();
    tampered[1].details = { n: 999 };
    const v = verifyAuditChain(tampered);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 1);
    assert.equal(v.verifiedCount, 1);
  });

  it('detects tampering with actor/reason fields, not only details', () => {
    const log = new AuditLog();
    log.record('human', 'APPROVAL_DECIDED', 'task', 't1', {}, { reason: 'looks safe', result: 'APPROVED' });
    const tampered = log.list();
    tampered[0].actor = 'attacker';
    assert.equal(verifyAuditChain(tampered).brokenAt, 0);
    const tampered2 = log.list();
    tampered2[0].reason = 'forged justification';
    assert.equal(verifyAuditChain(tampered2).ok, false);
  });

  it('detects reordering of chained records', () => {
    const log = new AuditLog();
    log.record('human', 'A', 'task', 't1');
    log.record('human', 'B', 'task', 't2');
    log.record('human', 'C', 'task', 't3');
    const reordered = log.list();
    [reordered[0], reordered[2]] = [reordered[2], reordered[0]];
    const v = verifyAuditChain(reordered);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 0); // first record no longer links to genesis
  });

  it('detects deletion of a middle record (successor link breaks)', () => {
    const log = new AuditLog();
    log.record('human', 'A', 'task', 't1');
    log.record('human', 'B', 'task', 't2');
    log.record('human', 'C', 'task', 't3');
    const cut = log.list();
    cut.splice(1, 1);
    const v = verifyAuditChain(cut);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 1);
  });

  it('persists reason/result verbatim and leaves them absent when not supplied', () => {
    const log = new AuditLog();
    const withOpts = log.record('human', 'SECRET_ROTATED', 'credential', 'c1', {}, {
      reason: 'quarterly rotation',
      result: 'SUCCEEDED',
    });
    assert.equal(withOpts.reason, 'quarterly rotation');
    assert.equal(withOpts.result, 'SUCCEEDED');
    const plain = log.record('human', 'PLAIN', 'task', 't1');
    assert.equal(plain.reason, undefined);
    assert.equal(plain.result, undefined);
    // Round-trip through list(): fields survive storage unchanged.
    const stored = log.list();
    assert.equal(stored[0].reason, 'quarterly rotation');
    assert.equal(stored[0].result, 'SUCCEEDED');
    assert.equal(log.verify().ok, true);
  });

  it('isolates the stored chain from mutation of returned/listed objects', () => {
    const log = new AuditLog();
    const returned = log.record('human', 'A', 'task', 't1', { v: 1 });
    returned.details.v = 'hacked';
    returned.summaryHash = 'f'.repeat(64);
    const listed = log.list();
    listed[0].details.v = 'hacked again';
    listed[0].actor = 'mallory';
    assert.equal(log.list()[0].actor, 'human');
    assert.equal(log.list()[0].details.v, 1);
    assert.deepEqual(log.verify(), { ok: true, verifiedCount: 1, legacyCount: 0 });
  });

  it('treats hash-less legacy records as unverified, not corrupt (legacy prefix)', () => {
    const log = new AuditLog();
    const legacy = [legacyRecord('l1'), legacyRecord('l2')];
    const v = verifyAuditChain(legacy);
    assert.deepEqual(v, { ok: true, verifiedCount: 0, legacyCount: 2 });
  });

  it('verifies a mixed log: legacy prefix skipped, chained segment verified from genesis', () => {
    const log = new AuditLog();
    log.record('human', 'A', 'task', 't1');
    log.record('human', 'B', 'task', 't2');
    const mixed = [legacyRecord('l1'), ...log.list()];
    const v = verifyAuditChain(mixed);
    assert.deepEqual(v, { ok: true, verifiedCount: 2, legacyCount: 1 });
  });

  it('still detects tampering in the chained segment of a mixed log', () => {
    const log = new AuditLog();
    log.record('human', 'A', 'task', 't1', { v: 1 });
    log.record('human', 'B', 'task', 't2', { v: 2 });
    const mixed = [legacyRecord('l1'), ...log.list()];
    mixed[2].details = { v: 222 };
    const v = verifyAuditChain(mixed);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 2);
    assert.equal(v.legacyCount, 1);
  });

  it('extends one chain across two AuditLog instances sharing a store', () => {
    const shared = new InMemoryAuditStore();
    const logA = new AuditLog(shared);
    const logB = new AuditLog(shared);
    const a = logA.record('human', 'A', 'task', 't1');
    const b = logB.record('human', 'B', 'task', 't2');
    assert.equal(b.prevHash, a.summaryHash);
    assert.deepEqual(logB.verify(), { ok: true, verifiedCount: 2, legacyCount: 0 });
  });

  it('caller cannot forge chain fields through details or opts', () => {
    const log = new AuditLog();
    const r = log.record('mallory', 'FORGE_ATTEMPT', 'task', 't1', {
      summaryHash: 'forged',
      prevHash: 'forged',
    });
    assert.match(r.summaryHash!, /^[0-9a-f]{64}$/);
    assert.equal(r.prevHash, AUDIT_CHAIN_GENESIS);
    assert.notEqual(r.summaryHash, 'forged');
    assert.equal(log.verify().ok, true);
  });

  it('verify of an empty log is trivially ok', () => {
    assert.deepEqual(verifyAuditChain([]), { ok: true, verifiedCount: 0, legacyCount: 0 });
    assert.deepEqual(new AuditLog().verify(), { ok: true, verifiedCount: 0, legacyCount: 0 });
  });
});

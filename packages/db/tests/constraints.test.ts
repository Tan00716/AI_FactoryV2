/**
 * Tests for @ai-factory/db constraints — SPEC v2 §48.3.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAcyclicOnAdd,
  assertEndpointsInOrgScope,
  assertEvidenceBinding,
  assertNoCrossProjectLink,
  BudgetLedger,
  ConstraintViolation,
  RequirementVersionRegistry,
  sha256Hex,
  verifyArtifactManifest,
  WriterLeaseGuard,
} from '../src/index';

function violation(fn: () => unknown): ConstraintViolation {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ConstraintViolation, `expected ConstraintViolation, got ${e}`);
    return e as ConstraintViolation;
  }
  assert.fail('expected ConstraintViolation to be thrown');
}

describe('RequirementVersionRegistry (§48.3)', () => {
  it('registers (id, version) and rejects duplicates', () => {
    const r = new RequirementVersionRegistry();
    r.register('REQ-1', 1, { title: 'v1' });
    const v = violation(() => r.register('REQ-1', 1, { title: 'v1 again' }));
    assert.equal(v.code, 'REQUIREMENT_VERSION_DUPLICATE');
    r.register('REQ-1', 2, { title: 'v2' }); // new version is fine
    assert.deepEqual(r.get('REQ-1', 2), { title: 'v2' });
  });

  it('runs may only pin versions that exist', () => {
    const r = new RequirementVersionRegistry();
    r.register('REQ-1', 1, {});
    r.assertVersionExists('REQ-1', 1);
    const v = violation(() => r.assertVersionExists('REQ-1', 2));
    assert.equal(v.code, 'REQUIREMENT_VERSION_MISSING');
    const v2 = violation(() => r.assertVersionExists('REQ-9', 1));
    assert.equal(v2.code, 'REQUIREMENT_VERSION_MISSING');
  });

  it('rejects invalid ids and versions', () => {
    const r = new RequirementVersionRegistry();
    assert.equal(violation(() => r.register('', 1, {})).code, 'REQUIREMENT_ID_REQUIRED');
    assert.equal(violation(() => r.register('REQ-1', 0, {})).code, 'REQUIREMENT_VERSION_INVALID');
  });
});

describe('org/project scoping (§48.3)', () => {
  it('rejects relationship endpoints outside the org scope', () => {
    const edge = {
      source: { kind: 'node', id: 'n1', orgId: 'org-A' },
      target: { kind: 'node', id: 'n2', orgId: 'org-B' },
    };
    const v = violation(() => assertEndpointsInOrgScope(edge, 'org-A'));
    assert.equal(v.code, 'SCOPE_VIOLATION');
    assert.match(v.message, /org-B/);
  });

  it('accepts endpoints inside the scope', () => {
    assertEndpointsInOrgScope(
      {
        source: { kind: 'node', id: 'n1', orgId: 'org-A' },
        target: { kind: 'node', id: 'n2', orgId: 'org-A' },
      },
      'org-A',
    );
  });

  it('rejects authorization chains spanning projects', () => {
    const v = violation(() =>
      assertNoCrossProjectLink([
        { kind: 'root-authorization', id: 'ra1', orgId: 'o', projectId: 'proj-A' },
        { kind: 'delegation', id: 'd1', orgId: 'o', projectId: 'proj-B' },
      ]),
    );
    assert.equal(v.code, 'CROSS_PROJECT_LINK');
  });

  it('accepts single-project chains', () => {
    assertNoCrossProjectLink([
      { kind: 'root-authorization', id: 'ra1', orgId: 'o', projectId: 'proj-A' },
      { kind: 'capability', id: 'c1', orgId: 'o', projectId: 'proj-A' },
    ]);
  });
});

describe('cycle checks (§48.3)', () => {
  it('detects a would-be cycle before insert', () => {
    const existing: Array<readonly [string, string]> = [
      ['a', 'b'],
      ['b', 'c'],
    ];
    const v = violation(() => assertAcyclicOnAdd(existing, 'c', 'a', 'delegation-chain'));
    assert.equal(v.code, 'CYCLE_DETECTED');
  });

  it('allows acyclic additions and rejects self-links', () => {
    const existing: Array<readonly [string, string]> = [['a', 'b']];
    assertAcyclicOnAdd(existing, 'b', 'c', 'parent-task');
    assert.equal(violation(() => assertAcyclicOnAdd(existing, 'a', 'a', 'parent-task')).code, 'CYCLE_DETECTED');
  });
});

describe('writer lease guard (§48.3, §22.3)', () => {
  it('allows one writer; second acquire conflicts', () => {
    const g = new WriterLeaseGuard({ now: () => 1_000 });
    const lease = g.acquireWriter('ws-1', 'run-A', 60_000);
    assert.equal(typeof lease.fencing_token, 'number');
    assert.throws(() => g.acquireWriter('ws-1', 'run-B', 60_000), /already holds|conflict/i);
  });

  it('validates the fencing token at the final execution point', () => {
    const g = new WriterLeaseGuard({ now: () => 1_000 });
    const lease = g.acquireWriter('ws-1', 'run-A', 60_000);
    g.validateWriter('ws-1', lease.fencing_token); // ok
    assert.throws(() => g.validateWriter('ws-1', lease.fencing_token + 999), /STALE_OWNER|stale/i);
  });

  it('reassign bumps the fencing token; old token goes stale', () => {
    const g = new WriterLeaseGuard({ now: () => 1_000 });
    const old = g.acquireWriter('ws-1', 'run-A', 60_000);
    const next = g.reassignWriter('ws-1', 'run-B', 60_000);
    assert.notEqual(next.fencing_token, old.fencing_token);
    assert.throws(() => g.validateWriter('ws-1', old.fencing_token), /STALE_OWNER|stale/i);
    g.validateWriter('ws-1', next.fencing_token);
  });
});

describe('hash and evidence binding (§48.3)', () => {
  it('sha256Hex is stable', () => {
    assert.equal(sha256Hex('abc'), sha256Hex('abc'));
    assert.notEqual(sha256Hex('abc'), sha256Hex('abd'));
    assert.equal(sha256Hex('abc').length, 64);
  });

  it('rejects manifest mismatches', () => {
    const content = 'build artifact bytes';
    verifyArtifactManifest(content, { artifact_id: 'a1', content_hash: sha256Hex(content) });
    const v = violation(() =>
      verifyArtifactManifest(content, { artifact_id: 'a1', content_hash: '0'.repeat(64) }),
    );
    assert.equal(v.code, 'HASH_MISMATCH');
  });

  it('evidence must bind the current candidate and environment', () => {
    const ev = { id: 'e1', candidateDigest: 'cand-A', environmentFingerprint: 'env-1' };
    assertEvidenceBinding(ev, { candidateDigest: 'cand-A', environmentFingerprint: 'env-1' });
    assert.equal(
      violation(() => assertEvidenceBinding(ev, { candidateDigest: 'cand-B', environmentFingerprint: 'env-1' })).code,
      'STALE_EVIDENCE',
    );
    assert.equal(
      violation(() => assertEvidenceBinding(ev, { candidateDigest: 'cand-A', environmentFingerprint: 'env-2' })).code,
      'EVIDENCE_ENV_MISMATCH',
    );
  });
});

describe('BudgetLedger (§21.4, §48.3)', () => {
  it('reserves atomically and rejects oversell', () => {
    const l = new BudgetLedger({ env1: 100 });
    l.reserve('env1', 'r1', 60);
    const v = violation(() => l.reserve('env1', 'r2', 50));
    assert.equal(v.code, 'BUDGET_EXCEEDED');
    l.reserve('env1', 'r2', 40); // exactly at balance: ok
  });

  it('settlement is idempotent and never double-charges', () => {
    const l = new BudgetLedger({ env1: 100 });
    l.reserve('env1', 'r1', 60);
    l.settle('r1');
    assert.equal(l.balanceOf('env1'), 40);
    l.settle('r1'); // idempotent no-op
    assert.equal(l.balanceOf('env1'), 40);
    assert.equal(l.get('r1')!.state, 'SETTLED');
  });

  it('released reservations cannot be settled; unknown ids rejected', () => {
    const l = new BudgetLedger({ env1: 100 });
    l.reserve('env1', 'r1', 10);
    l.release('r1');
    assert.equal(violation(() => l.settle('r1')).code, 'RESERVATION_RELEASED');
    assert.equal(violation(() => l.settle('nope')).code, 'RESERVATION_NOT_FOUND');
    assert.equal(violation(() => l.reserve('env1', 'r1', 5)).code, 'RESERVATION_DUPLICATE');
  });

  it('rejects invalid amounts and balances', () => {
    const l = new BudgetLedger({ env1: 100 });
    assert.equal(violation(() => l.reserve('env1', 'r1', 0)).code, 'RESERVATION_AMOUNT_INVALID');
    assert.equal(violation(() => l.reserve('env1', 'r1', 1.5)).code, 'RESERVATION_AMOUNT_INVALID');
    assert.throws(() => new BudgetLedger({ e: -5 }), /non-negative integer/);
  });
});

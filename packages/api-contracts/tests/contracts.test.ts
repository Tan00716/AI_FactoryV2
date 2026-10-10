/**
 * Tests for @ai-factory/api-contracts (SPEC v2 §49): each validator gets a
 * positive case and negative cases; reason codes are exactly the 16 unified
 * codes; applyServerActor overwrites any client-submitted actor.
 * Run: npx tsc -p tsconfig.json && node --test dist/tests/*.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_REASON_CODES,
  REASON_CODES,
  applyServerActor,
  reason,
  validateActor,
  validateCommandEnvelope,
  validateDelegationRequest,
  validateEvidenceRecord,
  validateRef,
  validateTransitionRequest,
} from '../src/index';

const REF = { id: 'task-1', version: 3, hash: 'sha256:abc' };

function validEnvelope(payload: unknown) {
  return {
    schemaVersion: '2.0',
    requestId: 'req-1',
    idempotencyKey: 'idem-1',
    organizationId: 'org-1',
    projectId: 'proj-1',
    actor: { id: 'agent-7', type: 'AI' },
    expectedVersion: 3,
    payload,
  };
}

function validTransition() {
  return {
    task: REF,
    requirement: { id: 'req-9', version: 1 },
    from: 'IN_PROGRESS',
    to: 'CODE_REVIEW',
    candidateDigest: 'sha256:candidate',
    evidenceManifestRef: { id: 'manifest-1', version: 1 },
    approvalRefs: [{ id: 'appr-1', version: 1 }],
  };
}

function validDelegation() {
  return {
    rootAuthorizationRef: REF,
    task: REF,
    delegatorId: 'pm-agent',
    delegateeId: 'coder-agent',
    scopeRef: { id: 'scope-1', version: 1 },
    acceptanceCriteriaRefs: [{ id: 'ac-1', version: 1 }],
    capabilityCeilingRef: { id: 'ceiling-1', version: 1 },
    budgetReservationId: 'budget-1',
    reportTo: ['pm-agent'],
  };
}

function validEvidence() {
  return {
    id: 'ev-1',
    schemaVersion: '2.0',
    taskId: 'task-1',
    runId: 'run-1',
    requirement: { id: 'req-9', version: 1 },
    candidateDigest: 'sha256:candidate',
    environmentFingerprint: 'linux-x64-node22',
    collectorIdentity: 'collector-1',
    artifactHashes: ['sha256:art1'],
    result: { passed: 10 },
    validity: 'ACTIVE',
    trust: 'TRUSTED_COLLECTOR',
  };
}

describe('validateRef', () => {
  it('accepts a full ref', () => {
    const r = validateRef(REF);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, REF);
  });

  it('accepts a ref without optional hash', () => {
    const r = validateRef({ id: 'x', version: 0 });
    assert.equal(r.ok, true);
  });

  it('rejects missing id / negative version / overlong id', () => {
    for (const bad of [
      { version: 1 },
      { id: 'x', version: -1 },
      { id: 'x', version: 1.5 },
      { id: 'x'.repeat(200), version: 1 },
      { id: 'x', version: 1, hash: 42 },
      'nope',
      null,
    ]) {
      const r = validateRef(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      if (!r.ok) assert.ok(r.issues.length > 0);
    }
  });
});

describe('validateActor', () => {
  it('accepts HUMAN/AI/SERVICE actors', () => {
    for (const type of ['HUMAN', 'AI', 'SERVICE'] as const) {
      const r = validateActor({ id: 'u1', type });
      assert.equal(r.ok, true);
    }
  });

  it('rejects unknown types and missing id', () => {
    for (const bad of [
      { id: 'u1', type: 'ADMIN' },
      { id: 'u1', type: 'human' },
      { id: '', type: 'HUMAN' },
      { type: 'HUMAN' },
    ]) {
      assert.equal(validateActor(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe('validateCommandEnvelope', () => {
  it('accepts a valid envelope with a valid payload', () => {
    const r = validateCommandEnvelope(validEnvelope(validTransition()), validateTransitionRequest);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.schemaVersion, '2.0');
      assert.equal(r.value.payload.to, 'CODE_REVIEW');
    }
  });

  it('rejects wrong schemaVersion and missing required fields', () => {
    const e1 = validEnvelope(validTransition());
    (e1 as Record<string, unknown>)['schemaVersion'] = '1.0';
    const r1 = validateCommandEnvelope(e1, validateTransitionRequest);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.ok(r1.issues.some((i) => i.path.endsWith('schemaVersion')));

    const e2 = validEnvelope(validTransition());
    delete (e2 as Record<string, unknown>)['idempotencyKey'];
    const r2 = validateCommandEnvelope(e2, validateTransitionRequest);
    assert.equal(r2.ok, false);

    const e3 = validEnvelope(validTransition());
    (e3 as Record<string, unknown>)['expectedVersion'] = -2;
    assert.equal(validateCommandEnvelope(e3, validateTransitionRequest).ok, false);
  });

  it('propagates payload issues with paths', () => {
    const bad = validTransition();
    delete (bad as Record<string, unknown>)['candidateDigest'];
    const r = validateCommandEnvelope(validEnvelope(bad), validateTransitionRequest);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.issues.some((i) => i.path.includes('candidateDigest')));
    }
  });

  it('applyServerActor overwrites a forged client actor', () => {
    const forged = validEnvelope(validTransition());
    forged.actor = { id: 'mallory', type: 'HUMAN' }; // client claims HUMAN
    const checked = validateCommandEnvelope(forged, validateTransitionRequest);
    assert.equal(checked.ok, true); // shape is fine…
    if (checked.ok) {
      // …but the server never uses it:
      const serverSide = applyServerActor(checked.value, { id: 'agent-7', type: 'AI' });
      assert.deepEqual(serverSide.actor, { id: 'agent-7', type: 'AI' });
      assert.notEqual(serverSide.actor.id, 'mallory');
    }
  });
});

describe('validateTransitionRequest', () => {
  it('accepts a valid transition payload', () => {
    assert.equal(validateTransitionRequest(validTransition()).ok, true);
  });

  it('rejects missing refs, empty states, bad approvalRefs', () => {
    const cases: unknown[] = [
      { ...validTransition(), task: { id: '', version: 1 } },
      { ...validTransition(), to: '' },
      { ...validTransition(), approvalRefs: [{ id: 'a', version: -1 }] },
      { ...validTransition(), approvalRefs: 'not-an-array' },
      { ...validTransition(), from: 'x'.repeat(100) },
    ];
    for (const bad of cases) {
      assert.equal(validateTransitionRequest(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe('validateDelegationRequest', () => {
  it('accepts a valid delegation payload (optional fields omitted)', () => {
    assert.equal(validateDelegationRequest(validDelegation()).ok, true);
  });

  it('accepts optional parentDelegationRef and deadline', () => {
    const d = {
      ...validDelegation(),
      parentDelegationRef: { id: 'del-0', version: 1 },
      deadline: '2026-12-31T00:00:00.000Z',
    };
    assert.equal(validateDelegationRequest(d).ok, true);
  });

  it('rejects missing root authorization, empty ids, bad reportTo', () => {
    const d1 = validDelegation();
    delete (d1 as Record<string, unknown>)['rootAuthorizationRef'];
    assert.equal(validateDelegationRequest(d1).ok, false);

    assert.equal(
      validateDelegationRequest({ ...validDelegation(), delegateeId: '' }).ok,
      false,
    );
    assert.equal(
      validateDelegationRequest({ ...validDelegation(), reportTo: ['ok', 42] }).ok,
      false,
    );
    assert.equal(
      validateDelegationRequest({ ...validDelegation(), budgetReservationId: 'x'.repeat(200) }).ok,
      false,
    );
  });
});

describe('validateEvidenceRecord', () => {
  it('accepts a valid evidence record with optional fields', () => {
    const r = validateEvidenceRecord({ ...validEvidence(), testDefinitionHash: 'sha256:td', exitCode: 0 });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.exitCode, 0);
  });

  it('rejects bad enums, non-object result, bad artifactHashes', () => {
    assert.equal(
      validateEvidenceRecord({ ...validEvidence(), validity: 'FRESH' }).ok,
      false,
    );
    assert.equal(
      validateEvidenceRecord({ ...validEvidence(), trust: 'PINKY_SWEAR' }).ok,
      false,
    );
    assert.equal(
      validateEvidenceRecord({ ...validEvidence(), result: 'passed' }).ok,
      false,
    );
    assert.equal(
      validateEvidenceRecord({ ...validEvidence(), artifactHashes: ['ok', 7] }).ok,
      false,
    );
    assert.equal(
      validateEvidenceRecord({ ...validEvidence(), schemaVersion: '1.0' }).ok,
      false,
    );
  });
});

describe('reason codes', () => {
  it('exports exactly the 16 unified reason codes', () => {
    const expected = [
      'UNAUTHORIZED', 'POLICY_DENIED', 'SCOPE_VIOLATION', 'AUTHORIZATION_EXPIRED',
      'VERSION_CONFLICT', 'STALE_OWNER', 'MISSING_EVIDENCE', 'STALE_EVIDENCE',
      'INDEPENDENCE_REQUIRED', 'DEPENDENCY_NOT_READY', 'BUDGET_EXCEEDED', 'QUOTA_LIMITED',
      'CONFINEMENT_UNAVAILABLE', 'APPROVAL_REQUIRED', 'UNKNOWN_SIDE_EFFECT',
      'UNSUPPORTED_CAPABILITY',
    ];
    assert.deepEqual(ALL_REASON_CODES, expected);
    assert.equal(Object.keys(REASON_CODES).length, 16);
  });

  it('reason() builds a machine-readable denial body', () => {
    const r = reason('POLICY_DENIED', { key: 'net.egress' });
    assert.equal(r.code, 'POLICY_DENIED');
    assert.ok(r.message.length > 0);
    assert.deepEqual(r.details, { key: 'net.egress' });
  });
});

/**
 * Tests for the v2 evidence contract (SPEC_V2 §39): eighteen-field records,
 * trust/validity, append-only invalidation, code-executed gate evaluation and
 * the DISPUTED escalation path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DisputeVoteForbiddenError,
  EvidenceV2Engine,
  EvidenceV2ExistsError,
  EvidenceV2ValidationError,
  GateDefinitionV2,
  GateEvaluatorForbiddenError,
  InMemoryEvidenceV2Store,
  InvalidationRecord,
  computeContentHash,
  evaluateGateV2,
  raiseDispute,
  resolveDispute,
  resolveDisputeByVote,
  validateEvidenceRecordV2,
  type CreateEvidenceV2Input,
  type EvaluatorIdentity,
  type EvidenceRecordV2,
} from '../src/index';

const FIXED = 1_700_000_000_000;
const SYS: EvaluatorIdentity = { kind: 'SYSTEM', id: 'gate-evaluator' };
const AI: EvaluatorIdentity = { kind: 'AI', id: 'agent-007' };

function baseInput(over: Partial<CreateEvidenceV2Input> = {}): CreateEvidenceV2Input {
  return {
    type: 'qa_result',
    requirement_version: 'REQ-001@1',
    ac_refs: ['AC-1'],
    task_id: 'TASK-1',
    run_id: 'RUN-1',
    candidate_revision: 'cand-abc',
    environment_fingerprint: 'env-dev-1',
    collector_identity: 'qa-runner-1',
    exit_code: 0,
    result_summary: {
      test_kind: 'test-result',
      total: 10,
      passed: 10,
      failed: 0,
      skipped: 0,
      ac_results: [{ ac_id: 'AC-1', passed: true }],
    },
    trust_level: 'TRUSTED_COLLECTOR',
    ...over,
  };
}

function engine() {
  return new EvidenceV2Engine(new InMemoryEvidenceV2Store(), { now: () => FIXED });
}

function gateDef(over: Partial<GateDefinitionV2> = {}): GateDefinitionV2 {
  return {
    gate_id: 'GATE-QA',
    mandatory_ac_ids: ['AC-1'],
    max_failed: 0,
    max_skipped: 0,
    require_independent_review: false,
    max_finding_severity: 'LOW',
    freshness_ms: null,
    ...over,
  };
}

function invMap(e: EvidenceV2Engine, rec: EvidenceRecordV2) {
  return new Map([[rec.evidence_id, e.listInvalidations(rec.evidence_id)]]);
}

describe('eighteen-field contract', () => {
  it('create fills all 18 fields with sane defaults', () => {
    const e = engine();
    const r = e.create(baseInput());
    const keys = Object.keys(r).sort();
    assert.deepEqual(keys, [
      'ac_refs', 'build_digest', 'candidate_revision', 'collector_identity',
      'content_hash', 'ended_at', 'environment_fingerprint', 'evidence_id',
      'exit_code', 'lineage', 'raw_artifact_refs', 'requirement_version',
      'result_summary', 'run_id', 'started_at', 'task_id', 'test_definition_hash',
      'trust_level', 'type', 'validity_state',
    ].sort());
    assert.equal(keys.length, 20); // 18 contract fields + started/ended split + task/run split
    assert.match(r.content_hash, /^[0-9a-f]{64}$/);
    assert.equal(r.validity_state, 'ACTIVE');
    assert.deepEqual(r.lineage, []);
  });

  it('trust defaults to UNVERIFIED when not stated', () => {
    const e = engine();
    const r = e.create(baseInput({ trust_level: undefined }));
    assert.equal(r.trust_level, 'UNVERIFIED');
  });

  it('validator rejects broken records', () => {
    assert.equal(validateEvidenceRecordV2(null).ok, false);
    const bad = { ...baseInput(), evidence_id: 'x', content_hash: 'zz' } as unknown;
    const v = validateEvidenceRecordV2(bad);
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.ok(v.errors.some((m) => m.startsWith('content_hash')));
    }
    const reversed = {
      evidence_id: 'e1', type: 't', requirement_version: 'REQ-1@1', ac_refs: [],
      task_id: 't', run_id: 'r', candidate_revision: 'c', build_digest: null,
      test_definition_hash: null, environment_fingerprint: 'e', collector_identity: 'c',
      started_at: '2026-10-10T02:00:00.000Z', ended_at: '2026-10-10T01:00:00.000Z',
      exit_code: null, result_summary: {}, raw_artifact_refs: [],
      content_hash: 'a'.repeat(64), trust_level: 'UNVERIFIED', validity_state: 'ACTIVE', lineage: [],
    };
    const v2 = validateEvidenceRecordV2(reversed);
    assert.equal(v2.ok, false);
    if (!v2.ok) assert.ok(v2.errors.some((m) => m.includes('ended_at')));
  });

  it('duplicate save is rejected — records are immutable', () => {
    const store = new InMemoryEvidenceV2Store();
    const e = new EvidenceV2Engine(store, { now: () => FIXED });
    const r = e.create(baseInput());
    assert.throws(() => store.save(r), EvidenceV2ExistsError);
  });

  it('hash proves bytes only: equal summaries hash equal, different differ', () => {
    const a = computeContentHash({ passed: 524, total: 524 });
    const b = computeContentHash({ passed: 524, total: 524 });
    const c = computeContentHash({ passed: 1, total: 524 });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe('append-only invalidation (§39.4)', () => {
  it('invalidation does not rewrite the original record', () => {
    const e = engine();
    const r = e.create(baseInput());
    const before = e.get(r.evidence_id);
    e.appendInvalidation(r.evidence_id, 'requirement changed', 'REQ-001@1→@2');
    const after = e.get(r.evidence_id);
    // Stored record untouched: same hash, still ACTIVE in storage.
    assert.equal(after.content_hash, before.content_hash);
    assert.equal(after.validity_state, 'ACTIVE');
    assert.deepEqual(after.lineage, []);
    // Effective validity comes from the append-only log.
    assert.equal(e.effectiveValidity(r.evidence_id), 'STALE');
    const invs: InvalidationRecord[] = e.listInvalidations(r.evidence_id);
    assert.equal(invs.length, 1);
    assert.equal(invs[0].change_ref, 'REQ-001@1→@2');
  });

  it('REVOKED invalidation wins over STALE', () => {
    const e = engine();
    const r = e.create(baseInput());
    e.appendInvalidation(r.evidence_id, 'candidate changed', 'cand-abc→cand-def');
    e.appendInvalidation(r.evidence_id, 'evidence forged', 'collector compromised', 'REVOKED');
    assert.equal(e.effectiveValidity(r.evidence_id), 'REVOKED');
  });

  it('reExecute creates a new lineage record; history stays queryable', () => {
    const e = engine();
    const old = e.create(baseInput());
    e.appendInvalidation(old.evidence_id, 'candidate changed', 'cand-abc→cand-def');
    const next = e.reExecute(old.evidence_id, baseInput({ candidate_revision: 'cand-def' }));
    assert.notEqual(next.evidence_id, old.evidence_id);
    assert.deepEqual(next.lineage, [old.evidence_id]);
    assert.equal(e.effectiveValidity(next.evidence_id), 'ACTIVE');
    // Old record still retrievable as history.
    assert.equal(e.get(old.evidence_id).candidate_revision, 'cand-abc');
  });

  it('appendInvalidation on unknown id throws', () => {
    const e = engine();
    assert.throws(() => e.appendInvalidation('nope', 'x', 'y'), /not found/);
  });
});

describe('gate evaluation is code-executed (§39.3)', () => {
  it('AI/HUMAN/SERVICE callers cannot write verdicts', () => {
    const e = engine();
    const r = e.create(baseInput());
    for (const caller of [AI, { kind: 'HUMAN', id: 'tan' } as EvaluatorIdentity, { kind: 'SERVICE', id: 'svc' } as EvaluatorIdentity]) {
      assert.throws(
        () => evaluateGateV2(gateDef(), [r], invMap(e, r), caller, FIXED),
        GateEvaluatorForbiddenError,
      );
    }
  });

  it('missing evidence blocks with MISSING_EVIDENCE and names the AC', () => {
    const e = engine();
    const ev = evaluateGateV2(gateDef(), [], new Map(), SYS, FIXED);
    assert.equal(ev.verdict, 'BLOCKED');
    assert.equal(ev.reason_code, 'MISSING_EVIDENCE');
    assert.deepEqual(ev.missing, ['AC-1']);
  });

  it('STALE evidence does not satisfy the gate', () => {
    const e = engine();
    const r = e.create(baseInput());
    e.appendInvalidation(r.evidence_id, 'requirement changed', 'REQ-001@1→@2');
    const ev = evaluateGateV2(gateDef(), [r], invMap(e, r), SYS, FIXED);
    assert.equal(ev.verdict, 'BLOCKED');
    assert.equal(ev.reason_code, 'MISSING_EVIDENCE');
  });

  it('failed tests fail the gate; skipped mandatory tests block it', () => {
    const e = engine();
    const failed = e.create(baseInput({
      result_summary: {
        test_kind: 'test-result', total: 10, passed: 8, failed: 2, skipped: 0,
        ac_results: [{ ac_id: 'AC-1', passed: true }],
      },
    }));
    let ev = evaluateGateV2(gateDef(), [failed], invMap(e, failed), SYS, FIXED);
    assert.equal(ev.verdict, 'FAILED');

    const skipped = e.create(baseInput({
      result_summary: {
        test_kind: 'test-result', total: 10, passed: 9, failed: 0, skipped: 1,
        ac_results: [{ ac_id: 'AC-1', passed: true }],
      },
    }));
    ev = evaluateGateV2(gateDef(), [skipped], invMap(e, skipped), SYS, FIXED);
    assert.equal(ev.verdict, 'BLOCKED');
  });

  it('self-review is rejected; independent review passes', () => {
    const e = engine();
    const selfReview = e.create(baseInput({
      type: 'code_review',
      result_summary: {
        review_kind: 'code-review', verdict: 'PASS',
        reviewer_id: 'coder-1', implementer_id: 'coder-1',
        ac_results: [{ ac_id: 'AC-1', passed: true }],
      },
    }));
    let ev = evaluateGateV2(
      gateDef({ require_independent_review: true }), [selfReview], invMap(e, selfReview), SYS, FIXED,
    );
    assert.equal(ev.verdict, 'BLOCKED');
    assert.equal(ev.reason_code, 'INDEPENDENCE_REQUIRED');

    const peerReview = e.create(baseInput({
      type: 'code_review',
      result_summary: {
        review_kind: 'code-review', verdict: 'PASS',
        reviewer_id: 'reviewer-9', implementer_id: 'coder-1',
        ac_results: [{ ac_id: 'AC-1', passed: true }],
      },
    }));
    ev = evaluateGateV2(
      gateDef({ require_independent_review: true }), [peerReview], invMap(e, peerReview), SYS, FIXED,
    );
    assert.equal(ev.verdict, 'PASSED');
  });

  it('risk findings above tolerance fail the gate', () => {
    const e = engine();
    const risky = e.create(baseInput({
      type: 'security_report',
      result_summary: {
        findings: [{ severity: 'HIGH', title: 'RCE in dep' }],
        ac_results: [{ ac_id: 'AC-1', passed: true }],
      },
    }));
    const ev = evaluateGateV2(
      gateDef({ max_finding_severity: 'LOW' }), [risky], invMap(e, risky), SYS, FIXED,
    );
    assert.equal(ev.verdict, 'FAILED');
  });

  it('stale-by-age evidence yields STALE verdict', () => {
    const e = engine();
    const r = e.create(baseInput({
      started_at: new Date(FIXED - 7200_000).toISOString(),
      ended_at: new Date(FIXED - 7100_000).toISOString(),
    }));
    const ev = evaluateGateV2(
      gateDef({ freshness_ms: 3600_000 }), [r], invMap(e, r), SYS, FIXED,
    );
    assert.equal(ev.verdict, 'STALE');
    assert.equal(ev.reason_code, 'STALE_EVIDENCE');
  });

  it('environment mismatch blocks the gate', () => {
    const e = engine();
    const r = e.create(baseInput());
    const ev = evaluateGateV2(
      gateDef({ required_environment: 'env-prod-1' }), [r], invMap(e, r), SYS, FIXED,
    );
    assert.equal(ev.verdict, 'BLOCKED');
    assert.equal(ev.reason_code, 'SCOPE_VIOLATION');
  });
});

describe('disputes (§15/§39)', () => {
  it('raiseDispute sets DISPUTED verdict and escalates', () => {
    const d = raiseDispute({
      gate_id: 'GATE-QA',
      raised_by: 'coder-1',
      summary: 'QA failed but test is flaky',
      positions: [
        { party: 'coder-1', claim: 'test is flaky', evidence_ref: 'E1' },
        { party: 'qa-2', claim: 'failure reproduces on clean env', evidence_ref: 'E2' },
      ],
      nowMs: FIXED,
    });
    assert.equal(d.gate_verdict, 'DISPUTED');
    assert.equal(d.escalated, true);
    assert.equal(d.status, 'DISPUTED');
  });

  it('a dispute needs at least two positions', () => {
    assert.throws(
      () => raiseDispute({ gate_id: 'G', raised_by: 'x', summary: 's', positions: [{ party: 'x', claim: 'c' }] }),
      /at least two positions/,
    );
  });

  it('votes never resolve a dispute', () => {
    assert.throws(() => resolveDisputeByVote(), DisputeVoteForbiddenError);
  });

  it('resolution needs independent trusted reproduction evidence', () => {
    const e = engine();
    const d = raiseDispute({
      gate_id: 'GATE-QA', raised_by: 'coder-1', summary: 's',
      positions: [
        { party: 'coder-1', claim: 'flaky' },
        { party: 'qa-2', claim: 'real' },
      ],
      nowMs: FIXED,
    });
    const unverified = e.create(baseInput({ trust_level: 'UNVERIFIED' }));
    assert.throws(
      () => resolveDispute(d, {
        by: 'qa-lead', reproduction_evidence: unverified,
        disputing_collectors: ['qa-runner-1'], outcome: 'UPHELD', nowMs: FIXED,
      }),
      /TRUSTED_COLLECTOR/,
    );
    const trusted = e.create(baseInput({ trust_level: 'TRUSTED_COLLECTOR' }));
    assert.throws(
      () => resolveDispute(d, {
        by: 'qa-lead', reproduction_evidence: trusted,
        disputing_collectors: ['qa-runner-1'], outcome: 'UPHELD', nowMs: FIXED,
      }),
      /independent/,
    );
    const independent = e.create(baseInput({
      trust_level: 'TRUSTED_COLLECTOR', collector_identity: 'repro-runner-3',
    }));
    const resolved = resolveDispute(d, {
      by: 'qa-lead', reproduction_evidence: independent,
      disputing_collectors: ['qa-runner-1'], outcome: 'OVERTURNED', nowMs: FIXED,
    });
    assert.equal(resolved.status, 'RESOLVED');
    assert.equal(resolved.resolution?.outcome, 'OVERTURNED');
  });
});

describe('contract validator', () => {
  it('create rejects input that breaks the contract', () => {
    const e = engine();
    assert.throws(
      () => e.create(baseInput({ requirement_version: '' })),
      EvidenceV2ValidationError,
    );
  });
});

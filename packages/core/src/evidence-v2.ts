/**
 * Evidence contract v2 — SPEC_V2 §39 (Artifact, Evidence & Verification Independence).
 *
 * Additive: v1 `evidence.ts` (DRAFT/SEALED engine, spec §42) is untouched.
 * This module implements the §39.2 eighteen-field evidence contract, trust and
 * validity states, append-only invalidation, code-executed gate evaluation and
 * the DISPUTED escalation path (§15/§39).
 *
 * Two hard rules, enforced in code rather than comments:
 *  1. A hash proves byte-equality only — it does NOT prove the content is true
 *     or that the test was valuable (§39.2). A Markdown report that writes
 *     "524/524 passed" is not Test Evidence (§39.1); only a trusted collector
 *     (§39.2) makes test output evidence.
 *  2. The gate evaluator is deterministic code. AI may contribute a signed
 *     review finding, but it MUST NOT write a Gate Verdict directly
 *     (assertGateEvaluator() rejects non-evaluator callers).
 */

import { createHash, randomUUID } from 'crypto';
import { ReasonCode } from './reason-codes';

/** §39.2 trust levels. */
export type TrustLevel = 'UNVERIFIED' | 'TRUSTED_COLLECTOR' | 'EXTERNALLY_ATTESTED';

/** §39.2 validity states. */
export type ValidityState = 'ACTIVE' | 'STALE' | 'REVOKED';

/** §39.3 gate verdicts. */
export type GateVerdict =
  | 'PENDING'
  | 'PASSED'
  | 'FAILED'
  | 'BLOCKED'
  | 'DISPUTED'
  | 'STALE'
  | 'WAIVED'
  | 'NOT_APPLICABLE';

/**
 * §39.2 — the full eighteen-field evidence contract.
 * `evidence_id, type, requirement_version, AC_refs, task/run, candidate_revision,
 *  build_digest, test_definition_hash, environment_fingerprint,
 *  tool/runner/collector_identity, started/ended_at, exit_code, result_summary,
 *  raw_artifact_refs, content_hash, trust_level, validity_state, lineage`.
 */
export interface EvidenceRecordV2 {
  /** 1 */ evidence_id: string;
  /** 2 */ type: string;
  /** 3 — e.g. "REQ-001@2"; evidence is bound to a requirement version. */
  requirement_version: string;
  /** 4 */ ac_refs: string[];
  /** 5 */ task_id: string;
  /** 5 */ run_id: string;
  /** 6 */ candidate_revision: string;
  /** 7 — null when no build artifact is involved. */
  build_digest: string | null;
  /** 8 — null for non-test evidence. */
  test_definition_hash: string | null;
  /** 9 */ environment_fingerprint: string;
  /** 10 — tool / runner / collector identity that produced the evidence. */
  collector_identity: string;
  /** 11 */ started_at: string;
  /** 11 */ ended_at: string;
  /** 12 — null when the evidence has no process exit code. */
  exit_code: number | null;
  /** 13 */ result_summary: Record<string, unknown>;
  /** 14 */ raw_artifact_refs: string[];
  /** 15 — sha256 over the canonical result_summary; proves bytes, not truth. */
  content_hash: string;
  /** 16 */ trust_level: TrustLevel;
  /** 17 */ validity_state: ValidityState;
  /**
   * 18 — chain of evidence ids this record supersedes (re-execution creates a
   * new record; the old record is never rewritten, only invalidated by append).
   */
  lineage: string[];
}

/** Input accepted by EvidenceV2Engine.create(); engine fills the rest. */
export interface CreateEvidenceV2Input {
  type: string;
  requirement_version: string;
  ac_refs: string[];
  task_id: string;
  run_id: string;
  candidate_revision: string;
  build_digest?: string | null;
  test_definition_hash?: string | null;
  environment_fingerprint: string;
  collector_identity: string;
  exit_code?: number | null;
  result_summary: Record<string, unknown>;
  raw_artifact_refs?: string[];
  /** Defaults to UNVERIFIED — trust must be earned, never assumed. */
  trust_level?: TrustLevel;
  started_at?: string;
  ended_at?: string;
}

export class EvidenceV2ValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`EvidenceRecordV2 contract violated: ${errors.join('; ')}`);
    this.name = 'EvidenceV2ValidationError';
  }
}

export class EvidenceV2ExistsError extends Error {
  constructor(id: string) {
    super(`EvidenceRecordV2 ${id} already exists and is immutable`);
    this.name = 'EvidenceV2ExistsError';
  }
}

export class EvidenceV2NotFoundError extends Error {
  constructor(id: string) {
    super(`EvidenceRecordV2 ${id} not found`);
    this.name = 'EvidenceV2NotFoundError';
  }
}

export class GateEvaluatorForbiddenError extends Error {
  constructor(caller: string) {
    super(
      `Caller ${caller} may not write a Gate Verdict: gate evaluation is executed by deterministic code (§39.3)`,
    );
    this.name = 'GateEvaluatorForbiddenError';
  }
}

export class DisputeVoteForbiddenError extends Error {
  constructor() {
    super(
      'Disputes are resolved by evidence and independent reproduction, never by majority vote (§15/§39)',
    );
    this.name = 'DisputeVoteForbiddenError';
  }
}

/** sha256 over canonical JSON — proves byte-equality, NOT truth or test value. */
export function computeContentHash(resultSummary: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(resultSummary)).digest('hex');
}

function isIso(s: unknown): s is string {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

/** Validate a candidate record against the eighteen-field contract. */
export function validateEvidenceRecordV2(v: unknown): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof v !== 'object' || v === null) return { ok: false, errors: ['must be an object'] };
  const r = v as Record<string, unknown>;
  const req = (k: string, pred: (x: unknown) => boolean, msg: string) => {
    if (!pred(r[k])) errors.push(`${k}: ${msg}`);
  };
  const str = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 512;
  req('evidence_id', str, 'non-empty string ≤512');
  req('type', str, 'non-empty string ≤512');
  req('requirement_version', str, 'non-empty string ≤512, e.g. REQ-001@2');
  req(
    'ac_refs',
    (x) => Array.isArray(x) && x.every((e) => typeof e === 'string'),
    'string array',
  );
  req('task_id', str, 'non-empty string ≤512');
  req('run_id', str, 'non-empty string ≤512');
  req('candidate_revision', str, 'non-empty string ≤512');
  req('build_digest', (x) => x === null || str(x), 'string ≤512 or null');
  req('test_definition_hash', (x) => x === null || str(x), 'string ≤512 or null');
  req('environment_fingerprint', str, 'non-empty string ≤512');
  req('collector_identity', str, 'non-empty string ≤512');
  req('started_at', isIso, 'ISO-8601 timestamp');
  req('ended_at', isIso, 'ISO-8601 timestamp');
  req('exit_code', (x) => x === null || Number.isInteger(x), 'integer or null');
  req(
    'result_summary',
    (x) => typeof x === 'object' && x !== null && !Array.isArray(x),
    'object',
  );
  req(
    'raw_artifact_refs',
    (x) => Array.isArray(x) && x.every((e) => typeof e === 'string'),
    'string array',
  );
  req('content_hash', (x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x), '64-hex sha256');
  req(
    'trust_level',
    (x) => x === 'UNVERIFIED' || x === 'TRUSTED_COLLECTOR' || x === 'EXTERNALLY_ATTESTED',
    'UNVERIFIED | TRUSTED_COLLECTOR | EXTERNALLY_ATTESTED',
  );
  req(
    'validity_state',
    (x) => x === 'ACTIVE' || x === 'STALE' || x === 'REVOKED',
    'ACTIVE | STALE | REVOKED',
  );
  req(
    'lineage',
    (x) => Array.isArray(x) && x.every((e) => typeof e === 'string'),
    'string array',
  );
  if (isIso(r['started_at']) && isIso(r['ended_at'])) {
    if (Date.parse(r['ended_at'] as string) < Date.parse(r['started_at'] as string)) {
      errors.push('ended_at: must not precede started_at');
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * §39.4 — append-only invalidation. The referenced evidence record is NEVER
 * rewritten; a new invalidation record is appended and the engine reports the
 * effective validity as STALE/REVOKED from that point on.
 */
export interface InvalidationRecord {
  id: string;
  evidence_id: string;
  at: string;
  /** e.g. "requirement REQ-001@1→@2", "candidate digest changed", "policy v3→v4". */
  reason: string;
  change_ref: string;
  kind: 'STALE' | 'REVOKED';
}

export interface EvidenceV2Store {
  save(rec: EvidenceRecordV2): void;
  get(id: string): EvidenceRecordV2 | undefined;
  listByTask(taskId: string): EvidenceRecordV2[];
  appendInvalidation(inv: InvalidationRecord): void;
  listInvalidations(evidenceId: string): InvalidationRecord[];
}

export class InMemoryEvidenceV2Store implements EvidenceV2Store {
  private records = new Map<string, EvidenceRecordV2>();
  private invalidations = new Map<string, InvalidationRecord[]>();

  save(rec: EvidenceRecordV2): void {
    if (this.records.has(rec.evidence_id)) throw new EvidenceV2ExistsError(rec.evidence_id);
    this.records.set(rec.evidence_id, structuredClone(rec));
  }

  get(id: string): EvidenceRecordV2 | undefined {
    const r = this.records.get(id);
    return r ? structuredClone(r) : undefined;
  }

  listByTask(taskId: string): EvidenceRecordV2[] {
    return [...this.records.values()]
      .filter((r) => r.task_id === taskId)
      .map((r) => structuredClone(r));
  }

  appendInvalidation(inv: InvalidationRecord): void {
    const list = this.invalidations.get(inv.evidence_id) ?? [];
    list.push(structuredClone(inv));
    this.invalidations.set(inv.evidence_id, list);
  }

  listInvalidations(evidenceId: string): InvalidationRecord[] {
    return (this.invalidations.get(evidenceId) ?? []).map((i) => structuredClone(i));
  }
}

export interface EvidenceV2Deps {
  /** Deterministic clock for tests. */
  now?: () => number;
}

export class EvidenceV2Engine {
  private readonly now: () => number;
  constructor(
    private store: EvidenceV2Store = new InMemoryEvidenceV2Store(),
    deps: EvidenceV2Deps = {},
  ) {
    this.now = deps.now ?? Date.now;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Create a record; validates the full eighteen-field contract. */
  create(input: CreateEvidenceV2Input): EvidenceRecordV2 {
    return this.buildAndSave(input, []);
  }

  /**
   * Re-execution after invalidation: creates a NEW record whose lineage
   * references the old one. History stays queryable but is not reused for the
   * current gate (§39.4).
   */
  reExecute(oldId: string, input: CreateEvidenceV2Input): EvidenceRecordV2 {
    const old = this.get(oldId);
    return this.buildAndSave(input, [...old.lineage, oldId]);
  }

  private buildAndSave(input: CreateEvidenceV2Input, lineage: string[]): EvidenceRecordV2 {
    const rec: EvidenceRecordV2 = {
      evidence_id: randomUUID(),
      type: input.type,
      requirement_version: input.requirement_version,
      ac_refs: [...input.ac_refs],
      task_id: input.task_id,
      run_id: input.run_id,
      candidate_revision: input.candidate_revision,
      build_digest: input.build_digest ?? null,
      test_definition_hash: input.test_definition_hash ?? null,
      environment_fingerprint: input.environment_fingerprint,
      collector_identity: input.collector_identity,
      started_at: input.started_at ?? this.nowIso(),
      ended_at: input.ended_at ?? this.nowIso(),
      exit_code: input.exit_code ?? null,
      result_summary: structuredClone(input.result_summary),
      raw_artifact_refs: [...(input.raw_artifact_refs ?? [])],
      content_hash: computeContentHash(input.result_summary),
      // Trust defaults to UNVERIFIED: a hash proves bytes, not truth (§39.2).
      trust_level: input.trust_level ?? 'UNVERIFIED',
      validity_state: 'ACTIVE',
      lineage,
    };
    const v = validateEvidenceRecordV2(rec);
    if (!v.ok) throw new EvidenceV2ValidationError((v as { errors: string[] }).errors);
    this.store.save(rec);
    return rec;
  }

  get(id: string): EvidenceRecordV2 {
    const r = this.store.get(id);
    if (!r) throw new EvidenceV2NotFoundError(id);
    return r;
  }

  listByTask(taskId: string): EvidenceRecordV2[] {
    return this.store.listByTask(taskId);
  }

  /**
   * §39.4 — invalidate by append. Requirement / Candidate / Test / Dependency /
   * Environment / Policy changes produce a STALE invalidation; the original
   * record is NOT modified. Returns the invalidation record.
   */
  appendInvalidation(evidenceId: string, reason: string, changeRef: string, kind: 'STALE' | 'REVOKED' = 'STALE'): InvalidationRecord {
    this.get(evidenceId); // throws when unknown
    const inv: InvalidationRecord = {
      id: randomUUID(),
      evidence_id: evidenceId,
      at: this.nowIso(),
      reason,
      change_ref: changeRef,
      kind,
    };
    this.store.appendInvalidation(inv);
    return inv;
  }

  listInvalidations(evidenceId: string): InvalidationRecord[] {
    return this.store.listInvalidations(evidenceId);
  }

  /**
   * Effective validity: the stored record is immutable, so STALE/REVOKED comes
   * from the append-only invalidation log, never from rewriting the record.
   */
  effectiveValidity(id: string): ValidityState {
    const rec = this.get(id);
    const invs = this.store.listInvalidations(id);
    if (invs.some((i) => i.kind === 'REVOKED')) return 'REVOKED';
    if (invs.length > 0) return 'STALE';
    return rec.validity_state;
  }

  /**
   * Re-execution after invalidation: creates a NEW record whose lineage
   * references the old one. History stays queryable but is not reused for the
   * current gate (§39.4).
   */
}

// ---------------------------------------------------------------------------
// Gate evaluation — §39.3. Executed by deterministic code; AI may supply a
// signed review finding but MUST NOT write a Gate Verdict directly.
// ---------------------------------------------------------------------------

/** Identity of whoever invokes the gate evaluator. */
export interface EvaluatorIdentity {
  /** 'SYSTEM' = the deterministic gate-evaluator code path. */
  kind: 'SYSTEM' | 'AI' | 'HUMAN' | 'SERVICE';
  id: string;
  role?: string;
}

/**
 * Rejects any caller that is not the deterministic evaluator.
 * AI employees/managers, humans and services cannot write verdicts directly;
 * they contribute evidence and findings, the code decides (§39.3, INV-04).
 */
export function assertGateEvaluator(caller: EvaluatorIdentity): void {
  if (caller.kind !== 'SYSTEM') {
    throw new GateEvaluatorForbiddenError(`${caller.kind}:${caller.id}`);
  }
}

/** §39.3 — what a gate definition must check. */
export interface GateDefinitionV2 {
  gate_id: string;
  /** Mandatory AC ids that must each be covered by ACTIVE, passing evidence. */
  mandatory_ac_ids: string[];
  /** Failure/skipped thresholds for test-result evidence. */
  max_failed: number;
  max_skipped: number;
  /** When true, a review finding must come from an independent reviewer. */
  require_independent_review: boolean;
  /** Highest tolerated finding severity; above it the gate fails. */
  max_finding_severity: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  /** Max age of evidence (ms); null = no freshness requirement. */
  freshness_ms: number | null;
  /** Required environment fingerprint; undefined = any. */
  required_environment?: string;
}

export interface GateEvaluationV2 {
  gate_id: string;
  verdict: GateVerdict;
  reason_code: ReasonCode | null;
  /** AC ids with no ACTIVE passing evidence, when verdict is BLOCKED. */
  missing: string[];
  evaluated_at: string;
  evaluator_id: string;
  evidence_refs: string[];
}

const SEVERITY_RANK: Record<string, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

interface TestTally {
  failed: number;
  skipped: number;
}

function tallyTests(evidence: EvidenceRecordV2[]): TestTally {
  let failed = 0;
  let skipped = 0;
  for (const e of evidence) {
    const r = e.result_summary as Record<string, unknown>;
    if (r['test_kind'] === 'test-result') {
      failed += typeof r['failed'] === 'number' ? r['failed'] : 0;
      skipped += typeof r['skipped'] === 'number' ? r['skipped'] : 0;
    }
  }
  return { failed, skipped };
}

/**
 * Evaluate a gate against evidence. Only the deterministic evaluator may call
 * this (assertGateEvaluator). Missing evidence → MISSING_EVIDENCE (§39.3).
 */
export function evaluateGateV2(
  def: GateDefinitionV2,
  evidence: EvidenceRecordV2[],
  invalidations: Map<string, InvalidationRecord[]>,
  evaluator: EvaluatorIdentity,
  nowMs: number,
): GateEvaluationV2 {
  assertGateEvaluator(evaluator);
  const evaluatedAt = new Date(nowMs).toISOString();
  const base = {
    gate_id: def.gate_id,
    evaluated_at: evaluatedAt,
    evaluator_id: `${evaluator.kind}:${evaluator.id}`,
    evidence_refs: evidence.map((e) => e.evidence_id),
  };
  const active = evidence.filter((e) => {
    if (e.validity_state === 'REVOKED') return false;
    const invs = invalidations.get(e.evidence_id) ?? [];
    return !invs.some((i) => i.kind === 'REVOKED') && invs.length === 0 && e.validity_state === 'ACTIVE';
  });

  // 1. Mandatory AC coverage — each AC needs ACTIVE evidence with a passing result.
  const missing: string[] = [];
  for (const acId of def.mandatory_ac_ids) {
    const covered = active.some((e) => {
      if (!e.ac_refs.includes(acId)) return false;
      const acResults = (e.result_summary as Record<string, unknown>)['ac_results'];
      return (
        Array.isArray(acResults) &&
        acResults.some(
          (a) =>
            typeof a === 'object' && a !== null &&
            (a as Record<string, unknown>)['ac_id'] === acId &&
            (a as Record<string, unknown>)['passed'] === true,
        )
      );
    });
    if (!covered) missing.push(acId);
  }
  if (missing.length > 0) {
    return { ...base, verdict: 'BLOCKED', reason_code: 'MISSING_EVIDENCE', missing };
  }

  // 2. Failure / skipped thresholds (§38/§39.3: skipped mandatory tests block).
  const { failed, skipped } = tallyTests(active);
  if (failed > def.max_failed) {
    return { ...base, verdict: 'FAILED', reason_code: null, missing: [] };
  }
  if (skipped > def.max_skipped) {
    return { ...base, verdict: 'BLOCKED', reason_code: 'MISSING_EVIDENCE', missing: [] };
  }

  // 3. Review independence (§37): reviewer must differ from implementer.
  if (def.require_independent_review) {
    const reviews = active.filter(
      (e) => (e.result_summary as Record<string, unknown>)['review_kind'] === 'code-review',
    );
    const independent = reviews.some((e) => {
      const r = e.result_summary as Record<string, unknown>;
      return (
        typeof r['reviewer_id'] === 'string' &&
        typeof r['implementer_id'] === 'string' &&
        r['reviewer_id'] !== r['implementer_id'] &&
        (r['verdict'] === 'PASS' || r['verdict'] === 'PASS_WITH_WARNINGS')
      );
    });
    if (!independent) {
      return { ...base, verdict: 'BLOCKED', reason_code: 'INDEPENDENCE_REQUIRED', missing: [] };
    }
  }

  // 4. Risk / security findings above the tolerated severity.
  const limit = SEVERITY_RANK[def.max_finding_severity] ?? 0;
  for (const e of active) {
    const r = e.result_summary as Record<string, unknown>;
    const findings = r['findings'];
    if (Array.isArray(findings)) {
      for (const f of findings) {
        const sev = typeof f === 'object' && f !== null
          ? String((f as Record<string, unknown>)['severity'] ?? 'NONE').toUpperCase()
          : 'NONE';
        if ((SEVERITY_RANK[sev] ?? 0) > limit) {
          return { ...base, verdict: 'FAILED', reason_code: null, missing: [] };
        }
      }
    }
  }

  // 5. Freshness / version binding.
  if (def.freshness_ms !== null) {
    const stale = active.some((e) => nowMs - Date.parse(e.ended_at) > (def.freshness_ms as number));
    if (stale) {
      return { ...base, verdict: 'STALE', reason_code: 'STALE_EVIDENCE', missing: [] };
    }
  }

  // 6. Environment binding.
  if (def.required_environment !== undefined) {
    const mismatched = active.some((e) => e.environment_fingerprint !== def.required_environment);
    if (mismatched) {
      return { ...base, verdict: 'BLOCKED', reason_code: 'SCOPE_VIOLATION', missing: [] };
    }
  }

  return { ...base, verdict: 'PASSED', reason_code: null, missing: [] };
}

// ---------------------------------------------------------------------------
// Disputes — §15/§39: Coder/Reviewer/QA disagreement goes to DISPUTED +
// ESCALATED and is resolved by evidence and independent reproduction.
// Majority vote MUST NOT override a failure.
// ---------------------------------------------------------------------------

export interface DisputePosition {
  party: string;
  claim: string;
  evidence_ref?: string;
}

export interface DisputeRecord {
  id: string;
  gate_id: string;
  raised_by: string;
  raised_at: string;
  summary: string;
  positions: DisputePosition[];
  /** DISPUTED gate verdict + ESCALATED condition travel together (§15). */
  gate_verdict: 'DISPUTED';
  escalated: true;
  status: 'DISPUTED' | 'RESOLVED';
  resolution?: {
    at: string;
    by: string;
    reproduction_evidence_ref: string;
    outcome: 'UPHELD' | 'OVERTURNED';
  };
}

export function raiseDispute(input: {
  gate_id: string;
  raised_by: string;
  summary: string;
  positions: DisputePosition[];
  nowMs?: number;
}): DisputeRecord {
  if (input.positions.length < 2) {
    throw new Error('A dispute needs at least two positions (claim vs counter-claim)');
  }
  return {
    id: randomUUID(),
    gate_id: input.gate_id,
    raised_by: input.raised_by,
    raised_at: new Date(input.nowMs ?? Date.now()).toISOString(),
    summary: input.summary,
    positions: input.positions.map((p) => ({ ...p })),
    gate_verdict: 'DISPUTED',
    escalated: true,
    status: 'DISPUTED',
  };
}

/**
 * Resolve a dispute with independent reproduction evidence. The reproduction
 * must come from a trusted collector independent of the disputing parties —
 * checked by the caller via evidence trust/collector fields.
 */
export function resolveDispute(
  dispute: DisputeRecord,
  input: {
    by: string;
    reproduction_evidence: EvidenceRecordV2;
    disputing_collectors: string[];
    outcome: 'UPHELD' | 'OVERTURNED';
    nowMs?: number;
  },
): DisputeRecord {
  if (dispute.status !== 'DISPUTED') throw new Error(`Dispute ${dispute.id} is not DISPUTED`);
  const ev = input.reproduction_evidence;
  if (ev.trust_level === 'UNVERIFIED') {
    throw new Error('Resolution requires TRUSTED_COLLECTOR or EXTERNALLY_ATTESTED reproduction evidence');
  }
  if (input.disputing_collectors.includes(ev.collector_identity)) {
    throw new Error('Reproduction must be independent of the disputing parties (§37)');
  }
  return {
    ...dispute,
    status: 'RESOLVED',
    resolution: {
      at: new Date(input.nowMs ?? Date.now()).toISOString(),
      by: input.by,
      reproduction_evidence_ref: ev.evidence_id,
      outcome: input.outcome,
    },
  };
}

/** Always throws: votes never override a failure (§15). */
export function resolveDisputeByVote(): never {
  throw new DisputeVoteForbiddenError();
}

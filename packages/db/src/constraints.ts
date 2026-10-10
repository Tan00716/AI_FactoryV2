/**
 * Mandatory storage constraints — SPEC v2 §48.3.
 *
 * These validators enforce the constraints that the data model MUST hold
 * regardless of which store backs them (SQLite DDL where possible, plus
 * these runtime checks at the write path). Each violation throws
 * ConstraintViolation with a stable machine-readable code.
 *
 * Covered constraints:
 *  - requirement (id, version) uniqueness; Run-referenced versions must exist
 *  - relationship endpoints must sit inside the legal organization scope
 *    (prevents cross-org / cross-project mis-linking = IDOR class)
 *  - primary management / hard dependency / parent task / delegation chain
 *    are cycle-checked before insert
 *  - at most one valid writer lease per resource (delegates to
 *    @ai-factory/leases single-writer semantics)
 *  - artifact/evidence hash + manifest verification; evidence binds the
 *    current candidate revision and environment
 *  - root authorization / child delegation / capabilities cannot be
 *    mis-linked across projects
 *  - budget reserve checks the balance inside the reservation step;
 *    settlement is idempotent; one reservation is never charged twice
 */

import { createHash } from 'node:crypto';
import {
  LeaseConflictError,
  LeaseManager,
  StaleOwnerError,
  type Lease,
  type LeaseManagerOptions,
} from '@ai-factory/leases';

export class ConstraintViolation extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConstraintViolation';
    this.code = code;
  }
}

/** sha256 hex digest — the canonical content hash for artifacts/evidence. */
export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// ------------------------------------------------- requirement versions ---

/**
 * Registry of immutable requirement versions.
 * §48.3: (requirement_id, version) is unique; versions referenced by a Run
 * MUST exist.
 */
export class RequirementVersionRegistry {
  private readonly versions = new Map<string, Map<number, unknown>>();

  register(requirementId: string, version: number, record: unknown): void {
    if (!requirementId?.trim()) {
      throw new ConstraintViolation('REQUIREMENT_ID_REQUIRED', 'requirement id is required');
    }
    if (!Number.isInteger(version) || version < 1) {
      throw new ConstraintViolation('REQUIREMENT_VERSION_INVALID', `version must be a positive integer, got ${version}`);
    }
    let byVersion = this.versions.get(requirementId);
    if (!byVersion) {
      byVersion = new Map();
      this.versions.set(requirementId, byVersion);
    }
    if (byVersion.has(version)) {
      throw new ConstraintViolation(
        'REQUIREMENT_VERSION_DUPLICATE',
        `requirement ${requirementId}@${version} already registered — versions are immutable`,
      );
    }
    byVersion.set(version, record);
  }

  /** A Run may only pin a version that exists. */
  assertVersionExists(requirementId: string, version: number): void {
    const byVersion = this.versions.get(requirementId);
    if (!byVersion?.has(version)) {
      throw new ConstraintViolation(
        'REQUIREMENT_VERSION_MISSING',
        `run references ${requirementId}@${version} which does not exist`,
      );
    }
  }

  get(requirementId: string, version: number): unknown {
    this.assertVersionExists(requirementId, version);
    return this.versions.get(requirementId)!.get(version);
  }
}

// ------------------------------------------------- org/project scoping ---

export interface ScopedRef {
  kind: string;
  id: string;
  orgId: string;
  projectId?: string;
}

/**
 * Relationship endpoints must live inside the legal organization scope.
 * §48.3: prevents IDOR-style mis-linking (e.g. an edge from org-A pointing
 * at a node that belongs to org-B).
 */
export function assertEndpointsInOrgScope(
  edge: { source: ScopedRef; target: ScopedRef },
  expectedOrgId: string,
): void {
  for (const end of [edge.source, edge.target] as const) {
    if (end.orgId !== expectedOrgId) {
      throw new ConstraintViolation(
        'SCOPE_VIOLATION',
        `${end.kind} ${end.id} belongs to org ${end.orgId}, not ${expectedOrgId}`,
      );
    }
  }
}

/**
 * Root authorization, child delegations and capabilities must all stay
 * inside ONE project — they can never be mis-linked across projects.
 * §48.3: "must not be mis-linked to other projects via foreign keys".
 */
export function assertNoCrossProjectLink(refs: ScopedRef[]): void {
  const projects = new Set(refs.map((r) => r.projectId ?? ''));
  if (projects.size > 1) {
    const detail = refs.map((r) => `${r.kind}:${r.id}@${r.projectId}`).join(', ');
    throw new ConstraintViolation(
      'CROSS_PROJECT_LINK',
      `authorization chain spans multiple projects: ${detail}`,
    );
  }
}

// ------------------------------------------------------------- cycles ---

/**
 * Generic cycle check used before inserting primary-management edges,
 * hard dependencies, parent-task links and delegation-chain links.
 * §48.3: ring check happens BEFORE the row is stored.
 */
export function assertAcyclicOnAdd(
  existing: ReadonlyArray<readonly [string, string]>,
  from: string,
  to: string,
  relationKind: string,
): void {
  if (from === to) {
    throw new ConstraintViolation('CYCLE_DETECTED', `${relationKind}: ${from} cannot link to itself`);
  }
  // Would adding from→to create a cycle? I.e. is `from` reachable from `to`?
  const adj = new Map<string, string[]>();
  for (const [a, b] of existing) {
    const list = adj.get(a) ?? [];
    list.push(b);
    adj.set(a, list);
  }
  const stack = [to];
  const seen = new Set<string>([to]);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === from) {
      throw new ConstraintViolation(
        'CYCLE_DETECTED',
        `${relationKind}: adding ${from}→${to} would create a cycle`,
      );
    }
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
}

// ------------------------------------------------- writer lease guard ---

/**
 * "At most one valid writer per resource" (§48.3), enforced through the
 * @ai-factory/leases single-writer manager. The fencing token it returns
 * MUST be presented at the final execution point (see transactions.ts).
 */
export class WriterLeaseGuard {
  private readonly manager: LeaseManager;

  constructor(opts: LeaseManagerOptions = {}) {
    this.manager = new LeaseManager(opts);
  }

  /** Acquire the single writer lease; throws LeaseConflictError if held. */
  acquireWriter(resourceId: string, runId: string, ttlMs: number): Lease {
    try {
      return this.manager.acquire(resourceId, runId, ttlMs);
    } catch (e) {
      if (e instanceof LeaseConflictError) throw e;
      throw new ConstraintViolation('WRITER_LEASE_CONFLICT', `resource ${resourceId}: ${(e as Error).message}`);
    }
  }

  /**
   * Final-execution-point check: a write carrying an old/foreign token is
   * rejected as STALE_OWNER (§22.3, §48.3).
   */
  validateWriter(resourceId: string, fencingToken: number): Lease {
    try {
      return this.manager.validate(resourceId, fencingToken);
    } catch (e) {
      if (e instanceof StaleOwnerError) throw e;
      throw new ConstraintViolation('STALE_OWNER', `resource ${resourceId}: ${(e as Error).message}`);
    }
  }

  reassignWriter(resourceId: string, newRunId: string, ttlMs: number): Lease {
    return this.manager.reassign(resourceId, newRunId, ttlMs);
  }
}

// ------------------------------------------------- hash & evidence binding ---

export interface ArtifactManifest {
  artifact_id: string;
  content_hash: string;
  byte_size?: number;
}

/**
 * Artifact/Evidence hash must verify against the manifest (§48.3).
 * A hash alone never proves content value — but a mismatch always
 * rejects the record.
 */
export function verifyArtifactManifest(content: string | Buffer, manifest: ArtifactManifest): void {
  const actual = sha256Hex(content);
  if (actual !== manifest.content_hash) {
    throw new ConstraintViolation(
      'HASH_MISMATCH',
      `artifact ${manifest.artifact_id}: manifest hash ${manifest.content_hash} != content hash ${actual}`,
    );
  }
  if (manifest.byte_size !== undefined) {
    const size = typeof content === 'string' ? Buffer.byteLength(content) : content.length;
    if (size !== manifest.byte_size) {
      throw new ConstraintViolation(
        'SIZE_MISMATCH',
        `artifact ${manifest.artifact_id}: manifest size ${manifest.byte_size} != content size ${size}`,
      );
    }
  }
}

export interface EvidenceBinding {
  candidateDigest: string;
  environmentFingerprint: string;
}

/**
 * Evidence must reference the CURRENT candidate and the applicable
 * environment (§48.3). Stale evidence never silently passes a gate.
 */
export function assertEvidenceBinding(
  evidence: { id: string; candidateDigest: string; environmentFingerprint: string },
  current: EvidenceBinding,
): void {
  if (evidence.candidateDigest !== current.candidateDigest) {
    throw new ConstraintViolation(
      'STALE_EVIDENCE',
      `evidence ${evidence.id} binds candidate ${evidence.candidateDigest}, current is ${current.candidateDigest}`,
    );
  }
  if (evidence.environmentFingerprint !== current.environmentFingerprint) {
    throw new ConstraintViolation(
      'EVIDENCE_ENV_MISMATCH',
      `evidence ${evidence.id} was collected in ${evidence.environmentFingerprint}, not ${current.environmentFingerprint}`,
    );
  }
}

// ------------------------------------------------- budget ledger ---

export type ReservationState = 'RESERVED' | 'SETTLED' | 'RELEASED';

export interface BudgetReservation {
  id: string;
  envelopeId: string;
  amountMinor: number;
  state: ReservationState;
}

/**
 * Budget ledger — SPEC v2 §21.4 / §48.3.
 * Amounts are integer minor units (no float money). Reserve checks the
 * balance atomically inside the reservation step; settlement is idempotent
 * and a reservation is never charged twice.
 */
export class BudgetLedger {
  private readonly balances = new Map<string, number>();
  private readonly reservations = new Map<string, BudgetReservation>();

  constructor(initialBalances: Record<string, number> = {}) {
    for (const [env, bal] of Object.entries(initialBalances)) {
      if (!Number.isInteger(bal) || bal < 0) {
        throw new ConstraintViolation('BUDGET_BALANCE_INVALID', `envelope ${env}: balance must be a non-negative integer`);
      }
      this.balances.set(env, bal);
    }
  }

  balanceOf(envelopeId: string): number {
    return this.balances.get(envelopeId) ?? 0;
  }

  /**
   * Atomic reserve: the balance check and the hold happen in one step —
   * concurrent reserves can never oversell the envelope.
   */
  reserve(envelopeId: string, reservationId: string, amountMinor: number): BudgetReservation {
    if (!reservationId?.trim()) {
      throw new ConstraintViolation('RESERVATION_ID_REQUIRED', 'reservation id is required');
    }
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new ConstraintViolation('RESERVATION_AMOUNT_INVALID', `amount must be a positive integer, got ${amountMinor}`);
    }
    if (this.reservations.has(reservationId)) {
      throw new ConstraintViolation(
        'RESERVATION_DUPLICATE',
        `reservation ${reservationId} already exists — retry the same logical action with the same key`,
      );
    }
    const balance = this.balanceOf(envelopeId);
    const held = [...this.reservations.values()]
      .filter((r) => r.envelopeId === envelopeId && r.state === 'RESERVED')
      .reduce((sum, r) => sum + r.amountMinor, 0);
    if (held + amountMinor > balance) {
      throw new ConstraintViolation(
        'BUDGET_EXCEEDED',
        `envelope ${envelopeId}: balance ${balance}, already held ${held}, requested ${amountMinor}`,
      );
    }
    const r: BudgetReservation = { id: reservationId, envelopeId, amountMinor, state: 'RESERVED' };
    this.reservations.set(reservationId, r);
    return { ...r };
  }

  /**
   * Idempotent settlement: settling twice is a no-op, never a double
   * charge. Settling a released reservation is rejected.
   */
  settle(reservationId: string): BudgetReservation {
    const r = this.reservations.get(reservationId);
    if (!r) throw new ConstraintViolation('RESERVATION_NOT_FOUND', `reservation ${reservationId} not found`);
    if (r.state === 'SETTLED') return { ...r }; // idempotent
    if (r.state === 'RELEASED') {
      throw new ConstraintViolation('RESERVATION_RELEASED', `reservation ${reservationId} was released and cannot be settled`);
    }
    const balance = this.balanceOf(r.envelopeId);
    this.balances.set(r.envelopeId, balance - r.amountMinor);
    r.state = 'SETTLED';
    return { ...r };
  }

  release(reservationId: string): BudgetReservation {
    const r = this.reservations.get(reservationId);
    if (!r) throw new ConstraintViolation('RESERVATION_NOT_FOUND', `reservation ${reservationId} not found`);
    if (r.state === 'RESERVED') r.state = 'RELEASED';
    return { ...r };
  }

  get(reservationId: string): BudgetReservation | undefined {
    const r = this.reservations.get(reservationId);
    return r ? { ...r } : undefined;
  }
}

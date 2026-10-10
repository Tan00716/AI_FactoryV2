/**
 * Flaky-test quarantine — SPEC v2 §38.2.
 *
 * Flaky tests may not be re-run into greenness. Every attempt is retained
 * (attempt history is append-only); quarantine requires an owner, an expiry,
 * and a policy reference. A quarantined MANDATORY test still blocks the gate
 * (see reportGateVerdict) — quarantine is triage, not a PASS.
 */
import { randomUUID } from 'node:crypto';

export interface FlakeAttempt {
  attemptId: string;
  at: string;
  passed: boolean;
  note?: string;
}

export interface QuarantineRecord {
  testId: string;
  owner: string;
  /** ISO timestamp after which the quarantine lapses and must be renewed. */
  expiresAt: string;
  /** Policy / decision reference that authorized the quarantine. */
  policyRef: string;
  reason: string;
  quarantinedAt: string;
  quarantinedBy: string;
}

export interface QuarantineInput {
  testId: string;
  owner: string;
  expiresAt: string;
  policyRef: string;
  reason: string;
  quarantinedBy: string;
  now?: () => number;
}

export class QuarantineNotFoundError extends Error {
  constructor(testId: string) {
    super(`No quarantine record for test ${testId}`);
    this.name = 'QuarantineNotFoundError';
  }
}

/** Append-only flake policy store. */
export class FlakeQuarantine {
  private readonly attempts = new Map<string, FlakeAttempt[]>();
  private readonly records = new Map<string, QuarantineRecord>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Record one attempt. History is append-only — attempts are never rewritten. */
  recordAttempt(testId: string, passed: boolean, note?: string): FlakeAttempt {
    const attempt: FlakeAttempt = {
      attemptId: randomUUID(),
      at: new Date(this.now()).toISOString(),
      passed,
      note,
    };
    const list = this.attempts.get(testId) ?? [];
    list.push(attempt);
    this.attempts.set(testId, list);
    return attempt;
  }

  /** All retained attempts for a test, oldest first. */
  getAttempts(testId: string): FlakeAttempt[] {
    return [...(this.attempts.get(testId) ?? [])];
  }

  /**
   * Quarantine a flaky test. Requires owner + expiry + policy ref; all three
   * are mandatory — an anonymous or open-ended quarantine is refused.
   */
  quarantine(input: QuarantineInput): QuarantineRecord {
    if (!input.testId) throw new Error('testId is required');
    if (!input.owner || !input.owner.trim()) {
      throw new Error('quarantine requires an owner — anonymous quarantine is refused');
    }
    if (!input.policyRef || !input.policyRef.trim()) {
      throw new Error('quarantine requires a policyRef — unjustified quarantine is refused');
    }
    const expiresMs = new Date(input.expiresAt).getTime();
    if (!Number.isFinite(expiresMs) || expiresMs <= this.now()) {
      throw new Error('quarantine requires a future expiresAt — open-ended quarantine is refused');
    }
    const record: QuarantineRecord = {
      testId: input.testId,
      owner: input.owner,
      expiresAt: new Date(expiresMs).toISOString(),
      policyRef: input.policyRef,
      reason: input.reason,
      quarantinedAt: new Date(this.now()).toISOString(),
      quarantinedBy: input.quarantinedBy,
    };
    this.records.set(input.testId, record);
    return record;
  }

  /** True when the test is currently quarantined (and the quarantine has not lapsed). */
  isQuarantined(testId: string): boolean {
    const rec = this.records.get(testId);
    if (!rec) return false;
    return new Date(rec.expiresAt).getTime() > this.now();
  }

  getRecord(testId: string): QuarantineRecord {
    const rec = this.records.get(testId);
    if (!rec || !this.isQuarantined(testId)) throw new QuarantineNotFoundError(testId);
    return rec;
  }

  /** Release a quarantine early (e.g. the flake was fixed and verified). */
  release(testId: string): void {
    if (!this.records.has(testId)) throw new QuarantineNotFoundError(testId);
    this.records.delete(testId);
  }

  listActive(): QuarantineRecord[] {
    return [...this.records.values()].filter((r) => this.isQuarantined(r.testId));
  }
}

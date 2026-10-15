/**
 * Periodic §32 audit-chain self-check (Batch 55, F36).
 *
 * F36 said "continuous proof (periodic verify + alerting) is an
 * operator policy choice, not something the endpoint claims" — this
 * module is that choice made concrete: the server continuously
 * verifies its own chain in-process and raises one §81
 * 'security-issue' needsHuman when the chain breaks, instead of only
 * answering the on-demand GET /api/audit/verify (Batch 53).
 *
 * What each tick does: calls audit.verify() internally — the same
 * verifier the endpoint uses, anchored at genesis over the full
 * append-order chain. Never an HTTP loopback (the server verifies its
 * own store directly; a loopback would add auth/network failure modes
 * to a safety check and could not run before the listener is up).
 *
 * Emission contract (same as emitSecurityNeedsHuman /
 * emitBruteForceNeedsHuman — the §81 write-through path, not a new
 * one): insert-only submit into fdb.needsHuman + NEEDS_HUMAN_RAISED
 * audit; a failed write-through is audited NEEDS_HUMAN_PERSIST_FAILED
 * and never throws. Dedup: at most one OPEN upgrade per source —
 * list('open') is the authority, so a human-resolved record re-raises
 * on the next tick while the chain is still broken (brute-force
 * precedent), and there is no alert storm.
 *
 * Silent on success: a healthy tick writes nothing (no audit spam —
 * a per-minute CHECK event would grow the chain it is checking).
 * A break audits AUDIT_CHAIN_VERIFY_FAILED (brokenAt, verifiedCount,
 * legacyCount) and then raises the upgrade.
 *
 * Fail-closed / degradation: tickAuditChainWatch never throws. A
 * verifier failure is audited AUDIT_CHAIN_WATCH_ERROR (best effort)
 * and the tick returns 'watch-error' — the missed check is audited,
 * not silent. The boot-time check and the interval wrapper in index.ts
 * add the same belt-and-braces try/catch the backup scheduler uses.
 *
 * Default ON: detection-not-prevention means nothing unless detection
 * actually runs, so the watch is enabled unless the operator opts out
 * with FACTORY_AUDIT_CHAIN_WATCH=0. The tick interval is
 * FACTORY_AUDIT_CHAIN_WATCH_INTERVAL_MS (default 60s); invalid values
 * fall back to the default rather than disabling the check.
 *
 * Honest boundaries:
 *  - This is still detection-not-prevention: the watch cannot stop a
 *    DB writer, it makes tampering visible and locatable (Batch 52).
 *  - brokenAt is an append-order (ORDER BY ts, rowid) index into the
 *    full chain, not the newest-first API order (F21) — the narrative
 *    says so explicitly.
 *  - The watch verifies the server's LOCAL chain only: no external
 *    timestamping, no third-party notarization (Batch 54 sweep).
 */
import { needsHuman } from '@ai-factory/autonomy';
import type { AuditLog } from '@ai-factory/core';
import type { NeedsHumanDbRecord, NeedsHumanStore } from '@ai-factory/db';

/** Source key for §81 upgrades raised by this watch. */
export const AUDIT_CHAIN_WATCH_SOURCE = 'audit-chain-watch';

/** Default tick interval: 60 seconds. */
export const AUDIT_CHAIN_WATCH_DEFAULT_INTERVAL_MS = 60_000;

/**
 * Minimal surface the watch needs — a fake of both stores satisfies
 * it, and the server passes { needsHuman: fdb.needsHuman, audit }.
 */
export interface AuditChainWatchDeps {
  needsHuman: Pick<NeedsHumanStore, 'submit' | 'list'>;
  audit: Pick<AuditLog, 'record' | 'verify'>;
}

/**
 * Parse FACTORY_AUDIT_CHAIN_WATCH_INTERVAL_MS. Non-finite, zero, or
 * negative values fall back to the default — an invalid interval must
 * not silently disable the check (fail-closed).
 */
export function parseAuditChainWatchIntervalMs(
  raw: string | undefined,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return AUDIT_CHAIN_WATCH_DEFAULT_INTERVAL_MS;
  return Math.floor(n);
}

/**
 * Build the §81 'security-issue' upgrade record for a broken chain.
 * Pure function — unit-testable without a server.
 *
 * requiredDeciderLevel is 'operator' — the API role the verify
 * endpoint itself requires (Batch 53): responding means inspecting
 * the DB, identifying what changed, and restoring from a known-good
 * backup via POST /api/restore. (Spec defines no risk→rank mapping;
 * this choice is documented, not derived.)
 */
export function buildAuditChainBreakRecord(args: {
  brokenAt: number;
  verifiedCount: number;
  legacyCount: number;
}): NeedsHumanDbRecord {
  // F19 (Batch 44): the honest narrative must survive persistence — it
  // goes into detailJson, not only the transient record.
  const narrative =
    `Periodic audit-chain self-check found the §32 hash chain BROKEN at append-order ` +
    `index ${args.brokenAt} (${args.verifiedCount} record(s) verified before the break` +
    `${args.legacyCount > 0 ? `, ${args.legacyCount} legacy record(s) skipped` : ''}). ` +
    `Note: the index counts the full append-order chain from genesis (ORDER BY ts, rowid), ` +
    `not the newest-first GET /api/audit order. An out-of-band database write changed a ` +
    `sealed record after it was written. The chain does not prevent writes; it makes ` +
    `tampering visible and locatable (detection-not-prevention, Batch 52) — and this is ` +
    `the server's local chain only: no external timestamping, no third-party notarization. ` +
    `Human judgment needed.`;
  const rec = needsHuman('security-issue', {
    detail: narrative,
    context: {
      source: AUDIT_CHAIN_WATCH_SOURCE,
      brokenAt: String(args.brokenAt),
      verifiedCount: String(args.verifiedCount),
      legacyCount: String(args.legacyCount),
    },
    impactScope:
      `Audit-chain integrity: records at and after append-order index ${args.brokenAt} can no ` +
      `longer be proven unmodified. Records before the break still verify. The break itself ` +
      `is the evidence — see the AUDIT_CHAIN_VERIFY_FAILED audit event for the exact location.`,
    stoppedActions: [],
    suggestion:
      'Treat the database as suspect. Identify what changed (compare against a backup), then ' +
      'restore from a known-good backup: POST /api/restore stages a verified backup for ' +
      'application on restart (see docs/backup-restore-guide.md). ' +
      'Mark this upgrade resolved via POST /api/needs-human/:id/resolve — if the chain is ' +
      'still broken, the watch re-raises on the next tick.',
  });
  return {
    id: rec.id,
    reason: rec.reason,
    reasonZh: rec.reasonZh,
    severity: rec.severity,
    source: AUDIT_CHAIN_WATCH_SOURCE,
    recipient: null,
    requiredDeciderLevel: 'operator',
    detailJson: JSON.stringify({
      narrative,
      source: AUDIT_CHAIN_WATCH_SOURCE,
      brokenAt: args.brokenAt,
      verifiedCount: args.verifiedCount,
      legacyCount: args.legacyCount,
      suggestion: rec.suggestion,
    }),
    contextJson: JSON.stringify(rec.context ?? {}),
    raisedAt: Date.now(),
    status: 'open',
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  };
}

/**
 * Write-through for audit-chain-break §81 upgrades: insert-only into
 * the needsHuman store, audited NEEDS_HUMAN_RAISED. A failed
 * write-through is audited NEEDS_HUMAN_PERSIST_FAILED — it never
 * throws (the same contract as emitSecurityNeedsHuman /
 * emitBruteForceNeedsHuman).
 */
export function emitAuditChainBreakNeedsHuman(
  deps: AuditChainWatchDeps,
  record: NeedsHumanDbRecord,
): void {
  try {
    deps.needsHuman.submit(record);
    deps.audit.record('system', 'NEEDS_HUMAN_RAISED', 'needs-human', record.id, {
      reason: record.reason,
      source: record.source,
      requiredDeciderLevel: record.requiredDeciderLevel,
    });
  } catch (err) {
    deps.audit.record('system', 'NEEDS_HUMAN_PERSIST_FAILED', 'needs-human', record.id, {
      error: err instanceof Error ? err.message : String(err),
      source: record.source,
    });
  }
}

export type AuditChainWatchTickResult = 'ok' | 'raised' | 'already-open' | 'watch-error';

/**
 * Run one self-check. Never throws: a verifier failure is audited
 * AUDIT_CHAIN_WATCH_ERROR (best effort) and reported as
 * 'watch-error'.
 */
export function tickAuditChainWatch(
  deps: AuditChainWatchDeps,
): AuditChainWatchTickResult {
  try {
    const v = deps.audit.verify();
    if (v.ok) return 'ok';
    const brokenAt = v.brokenAt ?? -1;
    const alreadyOpen = deps.needsHuman
      .list('open')
      .some((r) => r.source === AUDIT_CHAIN_WATCH_SOURCE);
    if (alreadyOpen) return 'already-open';
    try {
      deps.audit.record('system', 'AUDIT_CHAIN_VERIFY_FAILED', 'audit', 'chain', {
        brokenAt,
        verifiedCount: v.verifiedCount,
        legacyCount: v.legacyCount,
      });
    } catch {
      // The break-evidence write failing must not block the alert.
    }
    emitAuditChainBreakNeedsHuman(
      deps,
      buildAuditChainBreakRecord({
        brokenAt,
        verifiedCount: v.verifiedCount,
        legacyCount: v.legacyCount,
      }),
    );
    return 'raised';
  } catch (err) {
    try {
      deps.audit.record('system', 'AUDIT_CHAIN_WATCH_ERROR', 'audit', 'chain', {
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // Best effort only — the tick must not throw.
    }
    return 'watch-error';
  }
}

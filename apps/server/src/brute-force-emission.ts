/**
 * §81 'security-issue' emission: AUTH_DENIED aggregation → brute-force
 * upgrade (Batch 42).
 *
 * The Batch 41 survey concluded the only honest 'security-issue' signal
 * available was a deterministic detector ("401 聚合→暴力破解告警"):
 * packages/security's BruteForceDetector counts 401s per source inside
 * a sliding window — pure counting, no heuristics. This module is the
 * server wiring: threshold crossing → needsHuman('security-issue', …)
 * → insert-only write-through, following the Batch 36 contract.
 *
 * Emission contract (same as emitRunNeedsHuman / emitDeployNeedsHuman):
 *  - insert-only submit + NEEDS_HUMAN_RAISED audit;
 *  - write-through failure → NEEDS_HUMAN_PERSIST_FAILED audit, never
 *    throws (it must not disturb the already-written 401 response);
 *  - dedup: at most one OPEN upgrade per source — list('open') is the
 *    authority, so a resolved-then-attacked-again source re-emits
 *    naturally on the next denial.
 *  - recipient is null (no named human accounts; coarse token RBAC);
 *    requiredDeciderLevel 'admin': responding means rotating API
 *    tokens / retention & legal-hold surfaces / network edge blocks —
 *    the admin role's "dangerous management surfaces" (§15 RBAC).
 *    The spec has no incident→rank mapping table; this is a documented
 *    mapping choice, like Batch 39's 'manager'.
 *  - severity 'critical' comes from @ai-factory/autonomy's
 *    REASON_SEVERITY for 'security-issue' — not chosen here.
 *
 * Fail-closed / degradation (task requirement, also in the detector's
 * header): the detector is advisory-only. handleBruteForceDenial never
 * throws — a detector bug is audited BRUTE_FORCE_DETECTOR_FAILED and
 * the 401 stands (the gate ran first, upstream and independent), so a
 * broken detector can neither let an attack through nor manufacture a
 * false positive. The missed alert is audited, not silent.
 */
import { needsHuman } from '@ai-factory/autonomy';
import type { AuditLog } from '@ai-factory/core';
import type { NeedsHumanDbRecord, NeedsHumanStore } from '@ai-factory/db';
import { BruteForceDetector } from '@ai-factory/security';
import type { ApiAuthDeniedEvent } from './auth';

/** Minimal surface the emission needs — a fake RouteContext satisfies it. */
export interface BruteForceEmitDeps {
  needsHuman: Pick<NeedsHumanStore, 'submit' | 'list'>;
  audit: Pick<AuditLog, 'record'>;
}

/** Source key for the detector: the client remote address. */
export function bruteForceSourceKey(remoteAddress: string | null): string {
  return remoteAddress ?? 'unknown';
}

/**
 * Build the §81 'security-issue' upgrade record for a threshold
 * crossing. Pure function — unit-testable without a server.
 */
export function buildBruteForceUpgradeRecord(args: {
  remoteAddress: string;
  count: number;
  threshold: number;
  windowMs: number;
  distinctPrefixes: number;
  firstAt: number | null;
  lastAt: number | null;
}): NeedsHumanDbRecord {
  const windowMin = Math.round(args.windowMs / 60000);
  const span =
    args.firstAt !== null && args.lastAt !== null
      ? ` (first ${new Date(args.firstAt).toISOString()}, last ${new Date(args.lastAt).toISOString()})`
      : '';
  const narrative =
    `${args.count} failed API authentications (HTTP 401) from source ${args.remoteAddress} ` +
    `within ${windowMin} minutes (threshold ${args.threshold})${span}. ` +
    `Distinct presented-token prefixes observed in the window: ${args.distinctPrefixes}. ` +
    `Each attempt was individually denied by the auth gate (401); no session was ever established. ` +
    `This is a counting fact over the AUTH_DENIED audit trail, not a heuristic classification.`;
  const rec = needsHuman('security-issue', {
    detail: narrative,
    context: {
      remoteAddress: args.remoteAddress,
      denialCount: String(args.count),
      threshold: String(args.threshold),
      windowMs: String(args.windowMs),
      distinctTokenPrefixes: String(args.distinctPrefixes),
      firstAt: args.firstAt !== null ? String(args.firstAt) : '',
      lastAt: args.lastAt !== null ? String(args.lastAt) : '',
    },
    impactScope:
      `Unauthenticated source ${args.remoteAddress}; no authenticated session exists for it. ` +
      `The API gate keeps denying each attempt (401) — this upgrade is an alert, not a block.`,
    stoppedActions: [],
    suggestion:
      'Rotate the API token(s) (FACTORY_API_TOKEN / FACTORY_API_TOKENS), review the AUTH_DENIED ' +
      'audit trail for this source, and consider blocking the source at the network edge. ' +
      'If this is a misconfigured client, fix its credential. ' +
      "Mark this upgrade resolved via POST /api/needs-human/:id/resolve — if the source keeps " +
      'hammering after resolution, the detector re-emits on the next threshold crossing.',
  });
  return {
    id: rec.id,
    reason: rec.reason,
    reasonZh: rec.reasonZh,
    severity: rec.severity,
    source: `auth-bruteforce:${args.remoteAddress}`,
    recipient: null,
    requiredDeciderLevel: 'admin',
    detailJson: JSON.stringify({
      narrative,
      remoteAddress: args.remoteAddress,
      denialCount: args.count,
      threshold: args.threshold,
      windowMs: args.windowMs,
      distinctTokenPrefixes: args.distinctPrefixes,
      firstAt: args.firstAt,
      lastAt: args.lastAt,
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
 * Write-through for brute-force §81 upgrades (Batch 42): insert-only
 * into the needsHuman store, audited NEEDS_HUMAN_RAISED. A failed
 * write-through is audited NEEDS_HUMAN_PERSIST_FAILED — it never throws
 * and never disturbs the already-written 401 response.
 */
export function emitBruteForceNeedsHuman(
  deps: BruteForceEmitDeps,
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

/**
 * Feed one AUTH_DENIED into the detector; on threshold crossing, emit
 * the §81 upgrade unless one is already OPEN for this source.
 * Never throws (see module header for the degradation contract).
 */
export function handleBruteForceDenial(
  deps: BruteForceEmitDeps,
  detector: BruteForceDetector,
  event: ApiAuthDeniedEvent,
): void {
  try {
    const key = bruteForceSourceKey(event.remoteAddress);
    const outcome = detector.noteDenial(key, event.tokenPrefixHash);
    if (!outcome.crossed) return;
    const source = `auth-bruteforce:${key}`;
    const alreadyOpen = deps.needsHuman
      .list('open')
      .some((r) => r.reason === 'security-issue' && r.source === source);
    if (alreadyOpen) return;
    emitBruteForceNeedsHuman(
      deps,
      buildBruteForceUpgradeRecord({
        remoteAddress: key,
        count: outcome.count,
        threshold: detector.threshold,
        windowMs: detector.windowMs,
        distinctPrefixes: outcome.distinctPrefixes,
        firstAt: outcome.firstAt,
        lastAt: outcome.lastAt,
      }),
    );
  } catch (err) {
    deps.audit.record('system', 'BRUTE_FORCE_DETECTOR_FAILED', 'security', 'brute-force-detector', {
      remoteAddress: event.remoteAddress,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A successful authenticated login clears the source's counter (Batch
 * 42 task: "合法登录后计数清零"). Never throws.
 */
export function clearBruteForceOnLogin(
  deps: BruteForceEmitDeps,
  detector: BruteForceDetector,
  remoteAddress: string | null,
): void {
  try {
    detector.noteSuccess(bruteForceSourceKey(remoteAddress));
  } catch (err) {
    deps.audit.record('system', 'BRUTE_FORCE_DETECTOR_FAILED', 'security', 'brute-force-detector', {
      remoteAddress,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

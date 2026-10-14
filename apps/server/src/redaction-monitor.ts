/**
 * Redaction-hit detection + §81 'security-issue' aggregation (Batch 42).
 *
 * Background: Batch 41's security-issue survey found that output
 * redaction (`redactSecretValues`) was pure silent prevention — not even
 * a hit count, and no detection event. It named "redaction hits recorded
 * as detection events" as the missing deterministic signal for
 * 'security-issue'. This module is that signal.
 *
 * What each hit IS: one output unit (an exec invocation's full output,
 * one terminal chunk, one MCP server chunk) contained ≥1 exact-substring
 * occurrence of a known injected secret value. Counting is deterministic
 * (N replacements happened); it is not a heuristic conviction about the
 * content — every hit names a value the system itself injected.
 *
 * What a hit IS NOT: proof of malice. A single hit can be benign (a
 * command echoing its own environment for debugging). That is why a
 * single hit is never wired to needsHuman — only the AGGREGATED pattern
 * is: ≥ threshold detection events from the same source inside a short
 * window (explicit policy parameters below, matching the Batch 38
 * 'repeated-failure' precedent of an explicit N-in-a-row rule).
 *
 * Honest boundaries:
 *  - The aggregator is in-memory by design (like the authority-conflict
 *    registry): detection EVENTS persist in the audit chain; only the
 *    ephemeral aggregation window resets on restart.
 *  - Aggregation is per output source (exec command / terminal session /
 *    MCP server id). Cross-command exfiltration by one actor across
 *    different commands does not aggregate — the audit trail still has
 *    every detection event for review.
 *  - A source escalates at most once per active pattern: after
 *    escalating, further hits are recorded and audited but do not
 *    re-escalate until the window fully empties (no alert storms while
 *    a human hasn't adjudicated). A genuinely new pattern later may
 *    escalate again.
 *  - Audit details never carry secret content — only counts and
 *    identifiers. The values being matched are never written anywhere
 *    by this module.
 */
import { needsHuman } from '@ai-factory/autonomy';
import type { NeedsHumanDbRecord } from '@ai-factory/db';
import type { RouteContext } from './routes/context';

/** Aggregation policy: ≥3 detection events from one source in 5 minutes. */
export const REDACTION_ESCALATION_THRESHOLD = 3;
export const REDACTION_ESCALATION_WINDOW_MS = 5 * 60 * 1000;

export type RedactionSourceType = 'exec' | 'terminal' | 'mcp_server';

interface WindowEvent {
  at: number;
  hits: number;
}

/**
 * Per-source sliding-window counter of redaction-hit detection events.
 * Pure logic with an injectable clock, so tests are deterministic.
 */
export class RedactionHitAggregator {
  private readonly windows = new Map<string, WindowEvent[]>();
  private readonly escalated = new Set<string>();
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly nowFn: () => number;

  constructor(
    opts: { threshold?: number; windowMs?: number; now?: () => number } = {},
  ) {
    this.threshold = opts.threshold ?? REDACTION_ESCALATION_THRESHOLD;
    this.windowMs = opts.windowMs ?? REDACTION_ESCALATION_WINDOW_MS;
    this.nowFn = opts.now ?? Date.now;
  }

  get policyThreshold(): number {
    return this.threshold;
  }

  get policyWindowMs(): number {
    return this.windowMs;
  }

  /**
   * Record one detection event for `source` (already namespaced by the
   * caller, e.g. `exec:<command>`). Returns whether this event crosses
   * the escalation threshold, plus the in-window totals for the record.
   */
  noteHit(
    source: string,
    hits: number,
    at?: number,
  ): { escalate: boolean; eventsInWindow: number; totalHits: number } {
    const t = at ?? this.nowFn();
    const windowStart = t - this.windowMs;
    // Prune every source's expired events; drop emptied windows so the
    // map cannot grow unboundedly on distinct sources.
    for (const [key, events] of this.windows) {
      const live = events.filter((e) => e.at > windowStart);
      if (live.length === 0) {
        this.windows.delete(key);
        // A fully-aged-out pattern may escalate again if it re-emerges.
        this.escalated.delete(key);
      } else {
        this.windows.set(key, live);
      }
    }
    const events = this.windows.get(source) ?? [];
    events.push({ at: t, hits });
    this.windows.set(source, events);
    const totalHits = events.reduce((sum, e) => sum + e.hits, 0);
    if (this.escalated.has(source)) {
      return { escalate: false, eventsInWindow: events.length, totalHits };
    }
    if (events.length >= this.threshold) {
      this.escalated.add(source);
      return { escalate: true, eventsInWindow: events.length, totalHits };
    }
    return { escalate: false, eventsInWindow: events.length, totalHits };
  }

  /** Test/observability hook: in-window event count for a source. */
  eventsInWindow(source: string, at?: number): number {
    const t = at ?? this.nowFn();
    const windowStart = t - this.windowMs;
    return (this.windows.get(source) ?? []).filter((e) => e.at > windowStart).length;
  }

  /** Test hook: clear all aggregation state. */
  reset(): void {
    this.windows.clear();
    this.escalated.clear();
  }
}

/**
 * Module singleton feeding every redaction call site (exec, terminal,
 * MCP launcher). RouteContext is constructed per request, so the
 * aggregator cannot live on it — same memory-state posture as the
 * authority-conflict registry (Batch 36). Tests use their own
 * RedactionHitAggregator instances via the `monitor` parameter.
 */
export const redactionMonitor = new RedactionHitAggregator();

/**
 * Build the §81 'security-issue' upgrade record for an aggregated
 * redaction-hit pattern.
 *
 * recipient is null: the server has coarse-grained token RBAC with no
 * named human accounts, so we record the required level instead of
 * inventing a person. requiredDeciderLevel is 'operator' — the API role
 * that does daily run work and can rotate/revoke the exposed secrets
 * via the broker and terminate the offending terminal session or stop
 * the MCP server. (Spec defines no risk→rank mapping; this choice is
 * documented, not derived.)
 */
export function buildSecurityUpgradeRecord(args: {
  source: string;
  sourceType: RedactionSourceType;
  eventsInWindow: number;
  totalHits: number;
  windowMs: number;
  threshold: number;
}): NeedsHumanDbRecord {
  // F19 (Batch 44): the honest narrative must survive persistence — it goes
  // into detailJson (brute-force precedent), not only the transient record.
  const narrative =
    `redaction monitor: ${args.eventsInWindow} output(s) from ${args.sourceType} ` +
    `'${args.source}' contained injected secret values (${args.totalHits} exact ` +
    `replacements) within ${Math.round(args.windowMs / 1000)}s ` +
    `(threshold ${args.threshold} detection events). A single hit can be benign ` +
    `(e.g. a command echoing its own environment for debugging), but repeated ` +
    `hits from one source in a short window suggest systematic dumping — ` +
    `human judgment needed.`;
  const rec = needsHuman('security-issue', {
    detail: narrative,
    context: {
      source: args.source,
      sourceType: args.sourceType,
      eventsInWindow: String(args.eventsInWindow),
      totalHits: String(args.totalHits),
      windowMs: String(args.windowMs),
      threshold: String(args.threshold),
    },
    impactScope:
      `secret values injected into ${args.sourceType} '${args.source}' appeared ` +
      `in its output ${args.eventsInWindow} time(s); values were redacted before ` +
      `leaving the server, but the pattern indicates the secret left its ` +
      `consumption point repeatedly`,
    stoppedActions: [],
    suggestion:
      'Inspect the SECRET_REDACTED_HIT audit events for this source to see which ' +
      'outputs contained secret values. If the exposure was unintended, rotate ' +
      'the affected secrets (rotation revokes outstanding leases) and terminate ' +
      'the offending session or stop the MCP server. ' +
      'Mark this upgrade resolved via POST /api/needs-human/:id/resolve.',
  });
  return {
    id: rec.id,
    reason: rec.reason,
    reasonZh: rec.reasonZh,
    severity: rec.severity,
    source: `redaction-monitor:${args.sourceType}:${args.source}`,
    recipient: null,
    requiredDeciderLevel: 'operator',
    detailJson: JSON.stringify({
      narrative,
      source: args.source,
      sourceType: args.sourceType,
      eventsInWindow: args.eventsInWindow,
      totalHits: args.totalHits,
      windowMs: args.windowMs,
      threshold: args.threshold,
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
 * Write-through for redaction-pattern §81 upgrades (Batch 42):
 * insert-only into fdb.needsHuman, audited NEEDS_HUMAN_RAISED. A failed
 * write-through is audited NEEDS_HUMAN_PERSIST_FAILED — it never rolls
 * back anything (redaction already happened; this only escalates).
 * Same contract as emitRunNeedsHuman / emitDeployNeedsHuman.
 */
export function emitSecurityNeedsHuman(
  ctx: RouteContext,
  record: NeedsHumanDbRecord,
): void {
  try {
    ctx.fdb.needsHuman.submit(record);
    ctx.audit.record('system', 'NEEDS_HUMAN_RAISED', 'needs-human', record.id, {
      reason: record.reason,
      source: record.source,
      requiredDeciderLevel: record.requiredDeciderLevel,
    });
  } catch (err) {
    ctx.audit.record('system', 'NEEDS_HUMAN_PERSIST_FAILED', 'needs-human', record.id, {
      error: err instanceof Error ? err.message : String(err),
      source: record.source,
    });
  }
}

export interface RedactionHit {
  source: string;
  sourceType: RedactionSourceType;
  /** Exact replacement count in this output unit (≥1 by contract). */
  hits: number;
}

/**
 * Record one redaction detection event and run the §81 aggregation.
 *
 * Always audits SECRET_REDACTED_HIT with the hit count and the output
 * source — never secret content. Escalates to needsHuman('security-issue')
 * only when the same source crosses the aggregation threshold inside
 * the window; a single hit is deliberately not wired (it can be a
 * benign echo — Batch 41's false-positive standard).
 */
export function recordRedactionHit(
  ctx: RouteContext,
  actor: string,
  hit: RedactionHit,
  monitor: RedactionHitAggregator = redactionMonitor,
): void {
  ctx.audit.record(actor, 'SECRET_REDACTED_HIT', hit.sourceType, hit.source, {
    hits: hit.hits,
  });
  const agg = monitor.noteHit(`${hit.sourceType}:${hit.source}`, hit.hits);
  if (agg.escalate) {
    emitSecurityNeedsHuman(
      ctx,
      buildSecurityUpgradeRecord({
        source: hit.source,
        sourceType: hit.sourceType,
        eventsInWindow: agg.eventsInWindow,
        totalHits: agg.totalHits,
        windowMs: monitor.policyWindowMs,
        threshold: monitor.policyThreshold,
      }),
    );
  }
}

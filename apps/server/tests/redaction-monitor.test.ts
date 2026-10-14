/**
 * Batch 42 — redaction-hit detection + §81 'security-issue' aggregation.
 *
 * What this pins:
 *  1. The aggregator is deterministic counting with an explicit policy
 *     (≥3 detection events from one source in 5 min, injectable clock):
 *     below threshold → no escalation; window expiry resets; sources
 *     are isolated; no re-escalation while a pattern is active;
 *     a fully-aged-out pattern may escalate again.
 *  2. buildSecurityUpgradeRecord: reason 'security-issue' (severity
 *     critical per §81), recipient null, requiredDeciderLevel
 *     'operator', honest detail (single hits can be benign).
 *  3. emitSecurityNeedsHuman: insert-only + NEEDS_HUMAN_RAISED; failed
 *     write-through audits NEEDS_HUMAN_PERSIST_FAILED and never throws.
 *  4. recordRedactionHit: every hit audits SECRET_REDACTED_HIT with the
 *     hit count + source and NO secret content; a single hit never
 *     escalates; the 3rd in-window hit escalates exactly once.
 *
 * Tests import the module from src (its only value import is the
 * @ai-factory/autonomy package; relative imports are type-only).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryNeedsHumanStore } from '@ai-factory/db';
import {
  REDACTION_ESCALATION_THRESHOLD,
  REDACTION_ESCALATION_WINDOW_MS,
  RedactionHitAggregator,
  buildSecurityUpgradeRecord,
  emitSecurityNeedsHuman,
  recordRedactionHit,
} from '../src/redaction-monitor.ts';
import type { RouteContext } from '../src/routes/context.ts';

const SECRET = 'test-secret-value-7d3a9f-do-not-leak';

function makeCtx(store: InMemoryNeedsHumanStore, auditCalls: unknown[][]): RouteContext {
  return {
    fdb: { needsHuman: store },
    audit: {
      record: (...args: unknown[]) => {
        auditCalls.push(args);
      },
    },
  } as unknown as RouteContext;
}

describe('RedactionHitAggregator', () => {
  it('escalates exactly at the threshold inside the window', () => {
    let now = 1_000_000;
    const agg = new RedactionHitAggregator({ now: () => now });
    assert.equal(REDACTION_ESCALATION_THRESHOLD, 3);
    assert.equal(agg.noteHit('exec:echo hi', 1).escalate, false);
    assert.equal(agg.noteHit('exec:echo hi', 2).escalate, false);
    const third = agg.noteHit('exec:echo hi', 1);
    assert.equal(third.escalate, true);
    assert.equal(third.eventsInWindow, 3);
    assert.equal(third.totalHits, 4);
  });

  it('does not re-escalate while the pattern is still active', () => {
    let now = 1_000_000;
    const agg = new RedactionHitAggregator({ now: () => now });
    agg.noteHit('s', 1);
    agg.noteHit('s', 1);
    assert.equal(agg.noteHit('s', 1).escalate, true);
    assert.equal(agg.noteHit('s', 5).escalate, false);
    assert.equal(agg.noteHit('s', 5).escalate, false);
  });

  it('window expiry resets the count; a fresh pattern may escalate again', () => {
    let now = 1_000_000;
    const agg = new RedactionHitAggregator({ now: () => now });
    agg.noteHit('s', 1);
    agg.noteHit('s', 1);
    assert.equal(agg.noteHit('s', 1).escalate, true);
    // Jump past the window: all prior events age out.
    now += REDACTION_ESCALATION_WINDOW_MS + 1;
    assert.equal(agg.eventsInWindow('s'), 0);
    assert.equal(agg.noteHit('s', 1).escalate, false);
    assert.equal(agg.noteHit('s', 1).escalate, false);
    assert.equal(agg.noteHit('s', 1).escalate, true);
  });

  it('sources are isolated from each other', () => {
    let now = 1_000_000;
    const agg = new RedactionHitAggregator({ now: () => now });
    agg.noteHit('a', 1);
    agg.noteHit('a', 1);
    agg.noteHit('b', 1);
    agg.noteHit('b', 1);
    assert.equal(agg.eventsInWindow('a'), 2);
    assert.equal(agg.eventsInWindow('b'), 2);
    // Neither escalates: 2 < 3 each.
    assert.equal(agg.noteHit('a', 1).escalate, true); // a reaches 3
    assert.equal(agg.noteHit('b', 1).escalate, true); // b reaches 3
  });

  it('custom policy parameters are honored', () => {
    let now = 1_000_000;
    const agg = new RedactionHitAggregator({ threshold: 2, windowMs: 60_000, now: () => now });
    assert.equal(agg.policyThreshold, 2);
    assert.equal(agg.policyWindowMs, 60_000);
    assert.equal(agg.noteHit('s', 1).escalate, false);
    assert.equal(agg.noteHit('s', 1).escalate, true);
  });
});

describe('buildSecurityUpgradeRecord', () => {
  it("builds a 'security-issue' record with honest fields", () => {
    const rec = buildSecurityUpgradeRecord({
      source: 'echo hi',
      sourceType: 'exec',
      eventsInWindow: 3,
      totalHits: 7,
      windowMs: REDACTION_ESCALATION_WINDOW_MS,
      threshold: REDACTION_ESCALATION_THRESHOLD,
    });
    assert.equal(rec.reason, 'security-issue');
    assert.equal(rec.reasonZh, '安全问题');
    assert.equal(rec.severity, 'critical');
    assert.equal(rec.source, 'redaction-monitor:exec:echo hi');
    assert.equal(rec.recipient, null);
    assert.equal(rec.requiredDeciderLevel, 'operator');
    assert.equal(rec.status, 'open');
    const detail = JSON.parse(rec.detailJson) as Record<string, unknown>;
    assert.equal(detail['eventsInWindow'], 3);
    assert.equal(detail['totalHits'], 7);
    // F19 (Batch 44): the honest narrative must survive persistence — it is
    // copied into detailJson, not only the transient autonomy record.
    assert.match(String(detail['narrative']), /A single hit can be benign/);
    // Honest caveat: single hits can be benign.
    assert.match(String(detail['suggestion']), /SECRET_REDACTED_HIT/);
    const context = JSON.parse(rec.contextJson) as Record<string, string>;
    assert.equal(context['sourceType'], 'exec');
  });

  it('record JSON never carries secret content', () => {
    const rec = buildSecurityUpgradeRecord({
      source: 'terminal:sess-1',
      sourceType: 'terminal',
      eventsInWindow: 3,
      totalHits: 3,
      windowMs: REDACTION_ESCALATION_WINDOW_MS,
      threshold: REDACTION_ESCALATION_THRESHOLD,
    });
    const blob = JSON.stringify(rec);
    assert.ok(!blob.includes(SECRET), 'no secret value in the record');
  });
});

describe('emitSecurityNeedsHuman', () => {
  it('writes through insert-only + audits NEEDS_HUMAN_RAISED', () => {
    const store = new InMemoryNeedsHumanStore();
    const auditCalls: unknown[][] = [];
    const ctx = makeCtx(store, auditCalls);
    const rec = buildSecurityUpgradeRecord({
      source: 'mcp:fs@1.0.0',
      sourceType: 'mcp_server',
      eventsInWindow: 3,
      totalHits: 3,
      windowMs: REDACTION_ESCALATION_WINDOW_MS,
      threshold: REDACTION_ESCALATION_THRESHOLD,
    });
    emitSecurityNeedsHuman(ctx, rec);
    const row = store.get(rec.id);
    assert.ok(row);
    assert.equal(row?.status, 'open');
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0][1], 'NEEDS_HUMAN_RAISED');
    const detail = auditCalls[0][4] as Record<string, unknown>;
    assert.equal(detail['reason'], 'security-issue');
  });

  it('failed write-through audits NEEDS_HUMAN_PERSIST_FAILED and never throws', () => {
    const store = new InMemoryNeedsHumanStore();
    const auditCalls: unknown[][] = [];
    const ctx = makeCtx(store, auditCalls);
    const rec = buildSecurityUpgradeRecord({
      source: 'x',
      sourceType: 'exec',
      eventsInWindow: 3,
      totalHits: 3,
      windowMs: REDACTION_ESCALATION_WINDOW_MS,
      threshold: REDACTION_ESCALATION_THRESHOLD,
    });
    emitSecurityNeedsHuman(ctx, rec);
    // Duplicate id → submit throws → persist-failed audit, no throw.
    emitSecurityNeedsHuman(ctx, rec);
    assert.equal(auditCalls.length, 2);
    assert.equal(auditCalls[1][1], 'NEEDS_HUMAN_PERSIST_FAILED');
  });
});

describe('recordRedactionHit', () => {
  it('a single hit audits SECRET_REDACTED_HIT and never escalates', () => {
    const store = new InMemoryNeedsHumanStore();
    const auditCalls: unknown[][] = [];
    const ctx = makeCtx(store, auditCalls);
    let now = 1_000_000;
    const monitor = new RedactionHitAggregator({ now: () => now });
    recordRedactionHit(ctx, 'alice', { source: 'echo hi', sourceType: 'exec', hits: 2 }, monitor);
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0][0], 'alice');
    assert.equal(auditCalls[0][1], 'SECRET_REDACTED_HIT');
    assert.equal(auditCalls[0][2], 'exec');
    assert.equal(auditCalls[0][3], 'echo hi');
    const detail = auditCalls[0][4] as Record<string, unknown>;
    assert.equal(detail['hits'], 2);
    // No needsHuman row.
    assert.equal(store.list().length, 0);
  });

  it('the 3rd in-window hit escalates exactly once', () => {
    const store = new InMemoryNeedsHumanStore();
    const auditCalls: unknown[][] = [];
    const ctx = makeCtx(store, auditCalls);
    let now = 1_000_000;
    const monitor = new RedactionHitAggregator({ now: () => now });
    const hit = { source: 'sess-9', sourceType: 'terminal' as const, hits: 1 };
    recordRedactionHit(ctx, 'bob', hit, monitor);
    recordRedactionHit(ctx, 'bob', hit, monitor);
    assert.equal(store.list().length, 0);
    recordRedactionHit(ctx, 'bob', hit, monitor);
    const rows = store.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'security-issue');
    assert.equal(rows[0].status, 'open');
    // 3 detection audits + 1 NEEDS_HUMAN_RAISED.
    assert.equal(auditCalls.length, 4);
    assert.equal(auditCalls[3][1], 'NEEDS_HUMAN_RAISED');
    // 4th hit: audited, not re-escalated.
    recordRedactionHit(ctx, 'bob', hit, monitor);
    assert.equal(store.list().length, 1);
    assert.equal(auditCalls.length, 5);
    assert.equal(auditCalls[4][1], 'SECRET_REDACTED_HIT');
  });

  it('audit payloads never contain secret content', () => {
    const store = new InMemoryNeedsHumanStore();
    const auditCalls: unknown[][] = [];
    const ctx = makeCtx(store, auditCalls);
    let now = 1_000_000;
    const monitor = new RedactionHitAggregator({ now: () => now });
    // The command echoes the secret VALUE; the value itself must not
    // appear anywhere in audit payloads (source is the command shape
    // here, which does not embed the value).
    for (let i = 0; i < 3; i++) {
      recordRedactionHit(
        ctx,
        'carol',
        { source: 'printenv | sort', sourceType: 'exec', hits: 4 },
        monitor,
      );
    }
    const blob = JSON.stringify(auditCalls);
    assert.ok(!blob.includes(SECRET), 'audit payloads carry no secret value');
    const storeBlob = JSON.stringify(store.list());
    assert.ok(!storeBlob.includes(SECRET), 'needsHuman rows carry no secret value');
  });

  it('hits from different sources do not aggregate', () => {
    const store = new InMemoryNeedsHumanStore();
    const auditCalls: unknown[][] = [];
    const ctx = makeCtx(store, auditCalls);
    let now = 1_000_000;
    const monitor = new RedactionHitAggregator({ now: () => now });
    recordRedactionHit(ctx, 'dave', { source: 'cmd-a', sourceType: 'exec', hits: 1 }, monitor);
    recordRedactionHit(ctx, 'dave', { source: 'cmd-a', sourceType: 'exec', hits: 1 }, monitor);
    recordRedactionHit(ctx, 'dave', { source: 'cmd-b', sourceType: 'exec', hits: 1 }, monitor);
    recordRedactionHit(ctx, 'dave', { source: 'cmd-b', sourceType: 'exec', hits: 1 }, monitor);
    assert.equal(store.list().length, 0);
  });
});

/**
 * Batch 42 — §81 'security-issue' via AUTH_DENIED aggregation.
 *
 * What this pins:
 *  1. The detector is deterministic counting: 10 denials from one
 *     source inside 5 minutes trip the signal; a single 401 never
 *     does; denials spread outside the window never do. (Batch 41:
 *     a single 401 may be a mistyped token — emitting on it would
 *     be noise.)
 *  2. Threshold crossing builds a §81 'security-issue' record:
 *     severity critical (from @ai-factory/autonomy's REASON_SEVERITY),
 *     recipient null, requiredDeciderLevel 'admin', source
 *     `auth-bruteforce:<ip>`.
 *  3. Dedup: at most one OPEN per source — list('open') is the
 *     authority, so after a human resolves, the next denial
 *     re-emits.
 *  4. A successful authenticated login clears the source's counter.
 *  5. Fail-closed: a throwing detector is audited
 *     BRUTE_FORCE_DETECTOR_FAILED and emits nothing — the 401 gate
 *     is upstream and independent, so the failure can neither let
 *     an attack through nor manufacture a false positive.
 *  6. Write-through failure → NEEDS_HUMAN_PERSIST_FAILED, never throws.
 *
 * Tests import from src: brute-force-emission.ts has no relative
 * value imports (only type-only './auth' + bare package specifiers),
 * so Node's type-stripping loader handles it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryNeedsHumanStore } from '@ai-factory/db';
import { BruteForceDetector } from '@ai-factory/security';
import {
  bruteForceSourceKey,
  buildBruteForceUpgradeRecord,
  clearBruteForceOnLogin,
  emitBruteForceNeedsHuman,
  handleBruteForceDenial,
} from '../src/brute-force-emission.ts';
import type { BruteForceEmitDeps } from '../src/brute-force-emission.ts';
import type { ApiAuthDeniedEvent } from '../src/auth.ts';

function makeDeps(): { deps: BruteForceEmitDeps; store: InMemoryNeedsHumanStore; audits: unknown[][] } {
  const store = new InMemoryNeedsHumanStore();
  const audits: unknown[][] = [];
  const deps: BruteForceEmitDeps = {
    needsHuman: store,
    audit: {
      record: (actor: string, action: string, entityType: string, entityId: string, details?: Record<string, unknown>) => {
        audits.push([actor, action, entityType, entityId, details]);
      },
    },
  };
  return { deps, store, audits };
}

function ev(remoteAddress: string | null, prefix = 'aaaa'): ApiAuthDeniedEvent {
  return { remoteAddress, tokenPrefixHash: prefix };
}

function deny(deps: BruteForceEmitDeps, detector: BruteForceDetector, ip: string, n: number): void {
  for (let i = 0; i < n; i++) handleBruteForceDenial(deps, detector, ev(ip));
}

describe("§81 'security-issue' record shape (Batch 42)", () => {
  it('builds a critical, recipient-null, admin-level record', () => {
    const rec = buildBruteForceUpgradeRecord({
      remoteAddress: '9.9.9.9',
      count: 10,
      threshold: 10,
      windowMs: 300_000,
      distinctPrefixes: 3,
      firstAt: 1_000_000,
      lastAt: 1_060_000,
    });
    assert.equal(rec.reason, 'security-issue');
    assert.equal(rec.reasonZh, '安全问题');
    assert.equal(rec.severity, 'critical');
    assert.equal(rec.recipient, null);
    assert.equal(rec.requiredDeciderLevel, 'admin');
    assert.equal(rec.source, 'auth-bruteforce:9.9.9.9');
    assert.equal(rec.status, 'open');
    const detail = JSON.parse(rec.detailJson) as Record<string, unknown>;
    assert.equal(detail['remoteAddress'], '9.9.9.9');
    assert.equal(detail['denialCount'], 10);
    assert.equal(detail['threshold'], 10);
    assert.match(String(detail['suggestion'] ?? ''), /resolve/);
    // The detail is a counting fact, and says each attempt was denied.
    assert.match(rec.detailJson, /10 failed API authentications/);
    assert.match(rec.detailJson, /no session was ever established/);
  });

  it('bruteForceSourceKey falls back to "unknown" without inventing an address', () => {
    assert.equal(bruteForceSourceKey(null), 'unknown');
    assert.equal(bruteForceSourceKey('10.0.0.7'), '10.0.0.7');
  });
});

describe('threshold crossing → emission (Batch 42)', () => {
  it('9 denials → nothing; the 10th → one emission + NEEDS_HUMAN_RAISED', () => {
    const { deps, store, audits } = makeDeps();
    const detector = new BruteForceDetector();
    deny(deps, detector, '9.9.9.9', 9);
    assert.equal(store.list('open').length, 0);
    deny(deps, detector, '9.9.9.9', 1);
    const open = store.list('open');
    assert.equal(open.length, 1);
    assert.equal(open[0].reason, 'security-issue');
    assert.equal(open[0].source, 'auth-bruteforce:9.9.9.9');
    const raised = audits.filter((a) => a[1] === 'NEEDS_HUMAN_RAISED');
    assert.equal(raised.length, 1);
  });

  it('a single 401 never emits', () => {
    const { deps, store } = makeDeps();
    handleBruteForceDenial(deps, new BruteForceDetector(), ev('9.9.9.9'));
    assert.equal(store.list('open').length, 0);
  });

  it('denials spread outside the window never emit', () => {
    const { deps, store } = makeDeps();
    let t = 1_000_000;
    const detector = new BruteForceDetector({ now: () => t });
    for (let i = 0; i < 10; i++) {
      handleBruteForceDenial(deps, detector, ev('9.9.9.9'));
      t += 61_000; // no 5-minute window ever holds 10
    }
    assert.equal(store.list('open').length, 0);
  });

  it('no duplicate while one is OPEN; re-emits after resolve', () => {
    const { deps, store } = makeDeps();
    const detector = new BruteForceDetector();
    deny(deps, detector, '9.9.9.9', 10);
    deny(deps, detector, '9.9.9.9', 5);
    assert.equal(store.list('open').length, 1);
    const id = store.list('open')[0].id;
    assert.equal(store.resolve(id, 'resolved', 'admin', 'rotated token', Date.now()), true);
    deny(deps, detector, '9.9.9.9', 1);
    assert.equal(store.list('open').length, 1);
    assert.equal(store.list().length, 2);
  });

  it('a successful login clears the counter', () => {
    const { deps, store } = makeDeps();
    const detector = new BruteForceDetector();
    deny(deps, detector, '9.9.9.9', 9);
    clearBruteForceOnLogin(deps, detector, '9.9.9.9');
    deny(deps, detector, '9.9.9.9', 9);
    assert.equal(store.list('open').length, 0);
    deny(deps, detector, '9.9.9.9', 1);
    assert.equal(store.list('open').length, 1);
  });

  it('different sources are independent', () => {
    const { deps, store } = makeDeps();
    const detector = new BruteForceDetector();
    deny(deps, detector, '9.9.9.9', 10);
    deny(deps, detector, '8.8.8.8', 9);
    const open = store.list('open');
    assert.equal(open.length, 1);
    assert.equal(open[0].source, 'auth-bruteforce:9.9.9.9');
  });
});

describe('fail-closed degradation (Batch 42)', () => {
  it('a throwing detector is audited and emits nothing — the 401 stands', () => {
    const { deps, store, audits } = makeDeps();
    const bad = new BruteForceDetector();
    bad.noteDenial = () => {
      throw new Error('detector exploded');
    };
    assert.doesNotThrow(() => handleBruteForceDenial(deps, bad, ev('9.9.9.9')));
    assert.equal(store.list('open').length, 0);
    const failed = audits.filter((a) => a[1] === 'BRUTE_FORCE_DETECTOR_FAILED');
    assert.equal(failed.length, 1);
    assert.equal(failed[0][3], 'brute-force-detector');
  });

  it('write-through failure → NEEDS_HUMAN_PERSIST_FAILED, never throws', () => {
    const { deps, audits } = makeDeps();
    const failingDeps: BruteForceEmitDeps = {
      ...deps,
      needsHuman: {
        submit: () => {
          throw new Error('disk gone');
        },
        list: () => [],
      },
    };
    const rec = buildBruteForceUpgradeRecord({
      remoteAddress: '9.9.9.9',
      count: 10,
      threshold: 10,
      windowMs: 300_000,
      distinctPrefixes: 1,
      firstAt: null,
      lastAt: null,
    });
    assert.doesNotThrow(() => emitBruteForceNeedsHuman(failingDeps, rec));
    const failed = audits.filter((a) => a[1] === 'NEEDS_HUMAN_PERSIST_FAILED');
    assert.equal(failed.length, 1);
  });
});

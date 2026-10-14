/**
 * Batch 42 — deterministic brute-force detector (§81 'security-issue').
 *
 * What this pins: the detector is pure counting, not classification.
 * N denials from one source inside the sliding window trip the signal;
 * a single 401 never does; denials spread outside the window never do;
 * a successful login clears the counter. Clock is injected — every
 * test below is deterministic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BruteForceDetector,
  BRUTE_FORCE_THRESHOLD,
  BRUTE_FORCE_WINDOW_MS,
  tokenPrefixHash,
} from '../src/index';

function makeDetector() {
  let t = 1_000_000;
  const d = new BruteForceDetector({ now: () => t });
  return {
    d,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

describe('BruteForceDetector', () => {
  it('exposes the documented defaults (10 denials / 5 minutes)', () => {
    assert.equal(BRUTE_FORCE_THRESHOLD, 10);
    assert.equal(BRUTE_FORCE_WINDOW_MS, 5 * 60 * 1000);
  });

  it('a single 401 never crosses', () => {
    const { d } = makeDetector();
    const o = d.noteDenial('1.2.3.4');
    assert.equal(o.count, 1);
    assert.equal(o.crossed, false);
  });

  it('crosses exactly at the threshold inside the window', () => {
    const { d, advance } = makeDetector();
    let last = null;
    for (let i = 0; i < BRUTE_FORCE_THRESHOLD; i++) {
      last = d.noteDenial('1.2.3.4');
      advance(10_000);
      if (i < BRUTE_FORCE_THRESHOLD - 1) assert.equal(last.crossed, false);
    }
    assert.ok(last);
    assert.equal(last.count, BRUTE_FORCE_THRESHOLD);
    assert.equal(last.crossed, true);
  });

  it('stays crossed past the threshold (caller dedups via the store)', () => {
    const { d, advance } = makeDetector();
    let o = null;
    for (let i = 0; i < BRUTE_FORCE_THRESHOLD + 3; i++) {
      o = d.noteDenial('1.2.3.4');
      advance(1_000);
    }
    assert.ok(o);
    assert.equal(o.count, BRUTE_FORCE_THRESHOLD + 3);
    assert.equal(o.crossed, true);
  });

  it('denials spread outside the window never cross', () => {
    const { d, advance } = makeDetector();
    let o = null;
    // 10 denials, 61s apart: no 5-minute window ever holds 10.
    for (let i = 0; i < BRUTE_FORCE_THRESHOLD; i++) {
      o = d.noteDenial('1.2.3.4');
      advance(61_000);
    }
    assert.ok(o);
    assert.equal(o.crossed, false);
    assert.ok(o.count < BRUTE_FORCE_THRESHOLD);
  });

  it('old hits slide out of the window', () => {
    const { d, advance } = makeDetector();
    for (let i = 0; i < 9; i++) d.noteDenial('1.2.3.4');
    advance(BRUTE_FORCE_WINDOW_MS + 1);
    const o = d.noteDenial('1.2.3.4');
    assert.equal(o.count, 1);
    assert.equal(o.crossed, false);
  });

  it('a successful login clears the counter', () => {
    const { d, advance } = makeDetector();
    for (let i = 0; i < 9; i++) {
      d.noteDenial('1.2.3.4');
      advance(1_000);
    }
    d.noteSuccess('1.2.3.4');
    let o = null;
    for (let i = 0; i < 9; i++) {
      o = d.noteDenial('1.2.3.4');
      advance(1_000);
    }
    assert.ok(o);
    assert.equal(o.count, 9);
    assert.equal(o.crossed, false);
    // ...and the 10th denial after the clear crosses again.
    const o2 = d.noteDenial('1.2.3.4');
    assert.equal(o2.count, 10);
    assert.equal(o2.crossed, true);
  });

  it('keys are independent', () => {
    const { d, advance } = makeDetector();
    for (let i = 0; i < BRUTE_FORCE_THRESHOLD - 1; i++) {
      d.noteDenial('1.2.3.4');
      advance(1_000);
    }
    const o = d.noteDenial('5.6.7.8');
    assert.equal(o.count, 1);
    assert.equal(o.crossed, false);
    // Clearing one key does not touch the other.
    d.noteSuccess('5.6.7.8');
    assert.equal(d.countFor('1.2.3.4'), BRUTE_FORCE_THRESHOLD - 1);
  });

  it('tracks distinct token prefixes and window bounds', () => {
    const { d, advance, now } = makeDetector();
    d.noteDenial('1.2.3.4', 'aaaa');
    advance(1_000);
    const t1 = now();
    d.noteDenial('1.2.3.4', 'bbbb');
    advance(1_000);
    const o = d.noteDenial('1.2.3.4', 'aaaa');
    assert.equal(o.count, 3);
    assert.equal(o.distinctPrefixes, 2);
    assert.equal(o.firstAt, t1 - 1_000);
    assert.equal(o.lastAt, now());
  });

  it('rejects nonsense constructor options loudly', () => {
    assert.throws(() => new BruteForceDetector({ threshold: 0 }), /threshold/);
    assert.throws(() => new BruteForceDetector({ windowMs: -5 }), /windowMs/);
  });
});

describe('tokenPrefixHash', () => {
  it("returns 'none' for missing or malformed headers", () => {
    assert.equal(tokenPrefixHash(undefined), 'none');
    assert.equal(tokenPrefixHash(null), 'none');
    assert.equal(tokenPrefixHash('Basic abc'), 'none');
    assert.equal(tokenPrefixHash('Bearer   '), 'none');
  });

  it('is deterministic, 16 hex chars, and carries no token material', () => {
    const h1 = tokenPrefixHash('Bearer supersecret-token-123');
    const h2 = tokenPrefixHash('Bearer supersecret-token-123');
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{16}$/);
    assert.ok(!h1.includes('super'));
    // Same first 4 chars → same hash (grouping); different → different.
    assert.equal(tokenPrefixHash('Bearer super-different-rest'), h1);
    assert.notEqual(tokenPrefixHash('Bearer other-token-xyz'), h1);
  });
});

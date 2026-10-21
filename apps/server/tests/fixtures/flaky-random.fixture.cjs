/**
 * Fixture for flaky.test.ts — deterministic "random" intermittent failure.
 *
 * Each process draws ONE value from a seeded LCG (10 warm-up draws).
 * Verified first-draw outcomes for seeds 1..5:
 *   1 → FAIL, 2 → pass, 3 → FAIL, 4 → pass, 5 → FAIL
 * so five runs with FLAKY_SEED=1..5 always produce a mixed history.
 *
 * NOTE: this file is intentionally NOT named *.test.* — it must never be
 * picked up by the real `npm run test:server` glob. It is only executed
 * by flaky.test.ts via an explicit child-process spawn.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const seed = Number(process.env.FLAKY_SEED ?? '1');
const rand = lcg(Number.isFinite(seed) ? seed : 1);
for (let i = 0; i < 10; i++) rand();
const v = rand();

test('intermittent coin flip', () => {
  assert.ok(v >= 0.5, `seeded coin flip failed (v=${v.toFixed(4)})`);
});

test('always passes', () => {
  assert.ok(true);
});

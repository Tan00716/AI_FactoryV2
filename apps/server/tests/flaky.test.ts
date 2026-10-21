/**
 * Flaky-test detection tests (round-3 task 3) — imports ../src/flaky.ts
 * straight from src under node's type-stripping ESM loader. The module is
 * node builtins only (+ @ai-factory/security), so it resolves (dual-mode
 * import rule in AGENTS.md).
 *
 * Run: npm run test:server (TMPDIR wrapper); or
 *   node --test apps/server/tests/flaky.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FLAKY_CONFIG,
  FlakyHistoryStore,
  FlakyStoreError,
  normalizeTestKey,
  parseTapOutput,
  validateFlakyConfig,
  type TapTestOutcome,
  type TapTestStatus,
} from '../src/flaky.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, '..', '..', '..');
const FIXTURE = join(TEST_DIR, 'fixtures', 'flaky-random.fixture.cjs');

function tmpStoreFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'flaky-test-'));
  const file = join(dir, 'flaky-history.json');
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function outcome(key: string, status: TapTestStatus, file = 'f.test.ts'): TapTestOutcome {
  return { key, file, name: key, status };
}

// Real `node --test --test-reporter=tap` output (captured 2026-10-21):
// nested suite with one failing leaf — the parent 'not ok' is a rollup.
const NESTED_TAP = `TAP version 13
# Subtest: top level pass
ok 1 - top level pass
  ---
  duration_ms: 1.069965
  type: 'test'
  ...
# Subtest: nested suite
    # Subtest: inner failing
    not ok 1 - inner failing
      ---
      duration_ms: 1.258738
      type: 'test'
      location: '/tmp/tapfix/fail.test.js:5:11'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:

        1 !== 2
      code: 'ERR_ASSERTION'
      ...
    # Subtest: inner passing
    ok 2 - inner passing
      ---
      duration_ms: 0.154051
      type: 'test'
      ...
    1..2
not ok 2 - nested suite
  ---
  duration_ms: 2.178618
  type: 'test'
  location: '/tmp/tapfix/fail.test.js:4:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..2
# tests 4
# suites 0
# pass 2
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 132.281902
`;

test('TAP: nested output records leaf outcomes only (rollup parent skipped)', () => {
  const { outcomes, stats } = parseTapOutput(NESTED_TAP, { file: 'fail.test.js' });
  assert.equal(stats.resultLines, 4);
  assert.equal(stats.recorded, 3);
  assert.equal(stats.yamlBlocks, 4);
  const byKey = new Map(outcomes.map((o) => [o.key, o.status]));
  assert.equal(byKey.get('fail.test.js › top level pass'), 'pass');
  assert.equal(byKey.get('fail.test.js › nested suite › inner failing'), 'fail');
  assert.equal(byKey.get('fail.test.js › nested suite › inner passing'), 'pass');
  assert.ok(!byKey.has('fail.test.js › nested suite'), 'rollup parent must not be recorded');
});

test('TAP: SKIP and TODO directives are neutral statuses', () => {
  const tap = `TAP version 13
# Subtest: skipped one
ok 1 - skipped one # SKIP
  ---
  duration_ms: 0.1
  ...
# Subtest: todo one
ok 2 - todo one # TODO: not implemented yet
  ---
  ...
# Subtest: plain pass
ok 3 - plain pass
  ---
  ...
1..3
`;
  const { outcomes } = parseTapOutput(tap);
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ['skip', 'todo', 'pass'],
  );
  assert.deepEqual(
    outcomes.map((o) => o.key),
    ['skipped one', 'todo one', 'plain pass'],
  );
});

test('TAP: non-TAP input parses to zero outcomes (never dressed up)', () => {
  const pretty = '✔ adds numbers (1.6ms)\n✖ fails sometimes\nℹ tests 2\nℹ pass 1\nℹ fail 1\n';
  const { outcomes, stats } = parseTapOutput(pretty);
  assert.equal(outcomes.length, 0);
  assert.equal(stats.resultLines, 0);
});

test('TAP: duplicate test names get suffixed keys', () => {
  const tap = `TAP version 13
# Subtest: same
ok 1 - same
  ---
  ...
# Subtest: same
ok 2 - same
  ---
  ...
1..2
`;
  const { outcomes } = parseTapOutput(tap);
  assert.deepEqual(
    outcomes.map((o) => o.key),
    ['same', 'same (2)'],
  );
});

test('TAP: truncated input is flagged', () => {
  const { stats } = parseTapOutput('TAP version 13\n');
  assert.equal(stats.truncated, false);
});

test('normalizeTestKey: file + path join', () => {
  assert.equal(normalizeTestKey('a.test.ts', ['suite', 'case']), 'a.test.ts › suite › case');
  assert.equal(normalizeTestKey('', ['case']), 'case');
  assert.equal(normalizeTestKey('  ', ['case']), 'case');
});

test('store: all-pass history → stable', () => {
  const { file, cleanup } = tmpStoreFile();
  try {
    const store = new FlakyHistoryStore(file);
    for (let i = 0; i < 3; i++) {
      store.recordRun('p1', [outcome('k1', 'pass')], { label: `run ${i}` });
    }
    const e = store.get('p1', 'k1');
    assert.equal(e?.status, 'stable');
    assert.equal(e?.passes, 3);
    assert.equal(e?.fails, 0);
    assert.equal(e?.runs, 3);
  } finally {
    cleanup();
  }
});

test('store: all-fail history → always-failing', () => {
  const { file, cleanup } = tmpStoreFile();
  try {
    const store = new FlakyHistoryStore(file);
    for (let i = 0; i < 3; i++) {
      store.recordRun('p1', [outcome('k1', 'fail')], { label: `run ${i}` });
    }
    assert.equal(store.get('p1', 'k1')?.status, 'always-failing');
  } finally {
    cleanup();
  }
});

test('store: mixed pass/fail → flaky, with newlyFlaky reported', () => {
  const { file, cleanup } = tmpStoreFile();
  try {
    const store = new FlakyHistoryStore(file);
    store.recordRun('p1', [outcome('k1', 'pass')], { label: 'r1' });
    store.recordRun('p1', [outcome('k1', 'pass')], { label: 'r2' });
    assert.equal(store.get('p1', 'k1')?.status, 'insufficient-data');
    const r = store.recordRun('p1', [outcome('k1', 'fail')], { label: 'r3' });
    assert.equal(store.get('p1', 'k1')?.status, 'flaky');
    assert.deepEqual(r.newlyFlaky, ['k1']);
    // A later all-pass stretch keeps the window honest: still flaky
    // while any fail remains inside the 10-run window.
    store.recordRun('p1', [outcome('k1', 'pass')], { label: 'r4' });
    assert.equal(store.get('p1', 'k1')?.status, 'flaky');
  } finally {
    cleanup();
  }
});

test('store: below minRuns → insufficient-data', () => {
  const { file, cleanup } = tmpStoreFile();
  try {
    const store = new FlakyHistoryStore(file);
    store.recordRun('p1', [outcome('k1', 'fail')], { label: 'r1' });
    store.recordRun('p1', [outcome('k1', 'fail')], { label: 'r2' });
    assert.equal(store.get('p1', 'k1')?.status, 'insufficient-data');
  } finally {
    cleanup();
  }
});

test('store: skip/todo never enter the pass/fail window', () => {
  const { file, cleanup } = tmpStoreFile();
  try {
    const store = new FlakyHistoryStore(file);
    store.recordRun('p1', [outcome('k1', 'pass')], { label: 'r1' });
    store.recordRun('p1', [outcome('k1', 'skip')], { label: 'r2' });
    store.recordRun('p1', [outcome('k1', 'todo')], { label: 'r3' });
    const e = store.get('p1', 'k1');
    assert.equal(e?.runs, 3);
    assert.equal(e?.recent.length, 1); // only the pass entered the window
    assert.equal(e?.status, 'insufficient-data');
  } finally {
    cleanup();
  }
});

test('store: setConfig re-classifies under the new window', () => {
  const { file, cleanup } = tmpStoreFile();
  try {
    const store = new FlakyHistoryStore(file);
    store.recordRun('p1', [outcome('k1', 'pass')], { label: 'r1' });
    store.recordRun('p1', [outcome('k1', 'pass')], { label: 'r2' });
    store.recordRun('p1', [outcome('k1', 'fail')], { label: 'r3' });
    assert.equal(store.get('p1', 'k1')?.status, 'flaky');
    // Raising minRuns above the observed count → insufficient-data.
    const { config, errors } = store.setConfig('p1', { minRuns: 4 });
    assert.deepEqual(errors, []);
    assert.equal(config.minRuns, 4);
    assert.equal(store.get('p1', 'k1')?.status, 'insufficient-data');
  } finally {
    cleanup();
  }
});

test('store: config validation rejects bad thresholds', () => {
  assert.deepEqual(validateFlakyConfig({ windowSize: 1 }).errors.length > 0, true);
  assert.deepEqual(validateFlakyConfig({ minRuns: 99 }).errors.length > 0, true);
  assert.deepEqual(validateFlakyConfig({ windowSize: 5, minRuns: 6 }).errors.length > 0, true);
  assert.deepEqual(validateFlakyConfig({ windowSize: 'x' }).errors.length > 0, true);
  const { config, errors } = validateFlakyConfig({ windowSize: 5, minRuns: 2 });
  assert.deepEqual(errors, []);
  assert.deepEqual(config, { windowSize: 5, minRuns: 2 });
  const def = validateFlakyConfig(undefined);
  assert.deepEqual(def.config, DEFAULT_FLAKY_CONFIG);
  assert.deepEqual(def.errors, []);
});

test('store: corrupt file throws FlakyStoreError (fail-closed)', () => {
  const { file, cleanup } = tmpStoreFile();
  try {
    writeFileSync(file, '{not json', 'utf8');
    const store = new FlakyHistoryStore(file);
    assert.throws(() => store.list('p1'), FlakyStoreError);
  } finally {
    cleanup();
  }
});

test('store: list() filters and ranks flaky first', () => {
  const { file, cleanup } = tmpStoreFile();
  try {
    const store = new FlakyHistoryStore(file);
    for (let i = 0; i < 3; i++) store.recordRun('p1', [outcome('stable-k', 'pass')], { label: `r${i}` });
    store.recordRun('p1', [outcome('flaky-k', 'pass')], { label: 'r1' });
    store.recordRun('p1', [outcome('flaky-k', 'fail')], { label: 'r2' });
    store.recordRun('p1', [outcome('flaky-k', 'pass')], { label: 'r3' });
    const { tests, total } = store.list('p1');
    assert.equal(total, 2);
    assert.equal(tests[0].key, 'flaky-k');
    assert.equal(tests[0].status, 'flaky');
    const only = store.list('p1', { status: 'flaky' });
    assert.equal(only.total, 1);
  } finally {
    cleanup();
  }
});

test('store: clear() wipes the project', () => {
  const { file, cleanup } = tmpStoreFile();
  try {
    const store = new FlakyHistoryStore(file);
    store.recordRun('p1', [outcome('k1', 'pass')], { label: 'r1' });
    store.clear('p1');
    assert.equal(store.list('p1').total, 0);
  } finally {
    cleanup();
  }
});

test('integration: 5 seeded runs of the random fixture mark the intermittent test flaky', () => {
  const { file, cleanup } = tmpStoreFile();
  try {
    const store = new FlakyHistoryStore(file);
    const keyOf = (name: string) => `flaky-random.fixture.cjs › ${name}`;
    for (let seed = 1; seed <= 5; seed++) {
      // Scrub NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID: node refuses to run
      // `node --test` recursively inside a test file ("skipping running
      // files"). The real server is never itself under node --test, so
      // POST /api/flaky/runs is unaffected — this is test-only.
      const env: Record<string, string | undefined> = { ...process.env, FLAKY_SEED: String(seed) };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_TEST_WORKER_ID;
      const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', FIXTURE], {
        cwd: REPO_ROOT,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(r.error, undefined, `spawn failed: ${String(r.error)}`);
      const parsed = parseTapOutput(r.stdout, { file: 'flaky-random.fixture.cjs' });
      assert.equal(parsed.outcomes.length, 2, `seed ${seed}: expected 2 outcomes, got ${parsed.outcomes.length}`);
      store.recordRun('proj', parsed.outcomes, { label: `seed ${seed}`, file: 'flaky-random.fixture.cjs' });
    }
    const intermittent = store.get('proj', keyOf('intermittent coin flip'));
    assert.ok(intermittent, 'intermittent test recorded');
    assert.equal(intermittent.status, 'flaky');
    assert.ok(intermittent.passes > 0 && intermittent.fails > 0);
    const stable = store.get('proj', keyOf('always passes'));
    assert.equal(stable?.status, 'stable');
    const listed = store.list('proj', { status: 'flaky' });
    assert.equal(listed.total, 1);
    assert.equal(listed.tests[0].key, keyOf('intermittent coin flip'));
  } finally {
    cleanup();
  }
});

/**
 * Quality gate unit tests (deterministic lint/test runner).
 *
 * Imports ../src/quality-gate.ts directly: the module uses node builtins
 * plus package-level @ai-factory/runtime / @ai-factory/diagpack
 * (which resolve via main -> dist), so it resolves under node's
 * type-stripping ESM loader.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/quality-gate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_QUALITY_OUTPUT,
  QualityGateConfigError,
  QualityGateStore,
  defaultQualityGateConfig,
  runQualityCommand,
  runQualityGate,
  validateQualityGateConfig,
} from '../src/quality-gate.ts';

function tmpStore(): { store: QualityGateStore; dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-quality-'));
  const file = path.join(dir, 'quality-gates.json');
  return { store: new QualityGateStore(file), dir, file };
}

// ---------- config validation ----------

test('validate: empty input yields safe defaults (everything disabled)', () => {
  const { config, errors } = validateQualityGateConfig({});
  assert.deepEqual(errors, []);
  assert.deepEqual(config, defaultQualityGateConfig());
  assert.equal(config.lintCmd, '');
  assert.equal(config.runOnEdit, false);
  assert.equal(config.blockOnFailure, false);
  assert.equal(config.mutation.report, false);
});

test('validate: mutation linkage config (advisory-only annotation)', () => {
  const ok = validateQualityGateConfig({ mutation: { report: true } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.config.mutation.report, true);
  const bad = validateQualityGateConfig({ mutation: { report: 'yes' } });
  assert.ok(bad.errors.some((e) => e.includes('mutation.report must be a boolean')));
  assert.equal(bad.config.mutation.report, false);
  const wrongShape = validateQualityGateConfig({ mutation: 42 });
  assert.ok(wrongShape.errors.some((e) => e.includes('mutation must be an object')));
});

test('validate: accepts a full valid config', () => {
  const { config, errors } = validateQualityGateConfig({
    lintCmd: 'ruff check --fix .',
    testCmd: 'pytest -x -q',
    timeoutMs: 60000,
    runOnEdit: true,
    blockOnFailure: true,
  });
  assert.deepEqual(errors, []);
  assert.equal(config.lintCmd, 'ruff check --fix .');
  assert.equal(config.timeoutMs, 60000);
  assert.equal(config.runOnEdit, true);
});

test('validate: rejects bad commands, timeouts, and flags', () => {
  const long = 'x'.repeat(8001);
  for (const bad of [
    { lintCmd: 42 },
    { testCmd: long },
    { lintCmd: long },
    { timeoutMs: 0 },
    { timeoutMs: -5 },
    { timeoutMs: 600001 },
    { timeoutMs: Number.NaN },
    { timeoutMs: '60000' },
    { runOnEdit: 'yes' },
    { blockOnFailure: 1 },
  ]) {
    const { errors } = validateQualityGateConfig(bad);
    assert.ok(errors.length > 0, `expected errors for ${JSON.stringify(bad)}`);
  }
});

test('validate: empty-string commands are legal (disabled step)', () => {
  const { config, errors } = validateQualityGateConfig({ lintCmd: '   ', testCmd: '' });
  assert.deepEqual(errors, []);
  assert.equal(config.lintCmd, '');
  assert.equal(config.testCmd, '');
});

// ---------- store ----------

test('store: set/get round-trip; unknown project gets defaults', () => {
  const { store, file } = tmpStore();
  assert.deepEqual(store.get('proj-x'), defaultQualityGateConfig());
  const saved = store.set('proj-x', { lintCmd: 'true', timeoutMs: 5000 });
  assert.equal(saved.lintCmd, 'true');
  assert.equal(store.get('proj-x').lintCmd, 'true');
  // Re-read from disk through a fresh instance.
  const again = new QualityGateStore(file);
  assert.equal(again.get('proj-x').lintCmd, 'true');
  assert.equal(again.get('proj-x').timeoutMs, 5000);
});

test('store: set with invalid input throws and writes nothing', () => {
  const { store } = tmpStore();
  assert.throws(() => store.set('p', { timeoutMs: 0 }), QualityGateConfigError);
  assert.deepEqual(store.get('p'), defaultQualityGateConfig());
});

test('store: corrupt file is fail-closed (throws, never serves half a config)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-quality-corrupt-'));
  const file = path.join(dir, 'quality-gates.json');
  fs.writeFileSync(file, '{ not json', 'utf8');
  const store = new QualityGateStore(file);
  assert.throws(() => store.get('p'), QualityGateConfigError);
  assert.throws(() => store.set('p', { lintCmd: 'true' }), QualityGateConfigError);
});

test('store: remove deletes the project config', () => {
  const { store } = tmpStore();
  store.set('p', { lintCmd: 'true' });
  assert.equal(store.remove('p'), true);
  assert.equal(store.remove('p'), false);
  assert.deepEqual(store.get('p'), defaultQualityGateConfig());
});

// ---------- command runner ----------

test('runQualityCommand: exit 0 is ok, non-zero is failure', async () => {
  const ok = await runQualityCommand('true', { timeoutMs: 5000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.timedOut, false);
  assert.equal(ok.exitCode, 0);

  const bad = await runQualityCommand('false', { timeoutMs: 5000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.timedOut, false);
  assert.equal(bad.exitCode, 1);
});

test('runQualityCommand: timeout kills the child (fail-closed)', async () => {
  const r = await runQualityCommand('sleep 10', { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
});

test('runQualityCommand: oversized output is truncated and disclosed', async () => {
  const big = `node -e "process.stdout.write('x'.repeat(100000))"`;
  const r = await runQualityCommand(big, { timeoutMs: 10000 });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.equal(r.stdout.length, MAX_QUALITY_OUTPUT);
});

test('runQualityCommand: captures stdout and stderr separately', async () => {
  const r = await runQualityCommand(`node -e "console.log('out'); console.error('err')"`, {
    timeoutMs: 10000,
  });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /out/);
  assert.match(r.stderr, /err/);
});

// ---------- V3R14 #6(e): credential env scrub + output redaction ----------

test('runQualityCommand: credential env is scrubbed from the child, output is redacted', async () => {
  const keys = ['FACTORY_API_TOKEN', 'FACTORY_API_TOKENS', 'FACTORY_SECRET_PROBE'];
  const saved = new Map<string, string | undefined>();
  for (const k of keys) {
    saved.set(k, process.env[k]);
    process.env[k] = `test-value-for-${k.toLowerCase()}-1234567890`;
  }
  try {
    const r = await runQualityCommand('printenv', { timeoutMs: 10000 });
    assert.equal(r.ok, true);
    // Assert on env-assignment LINES, not raw substrings: unrelated
    // ambient vars (e.g. a runtime trace-context blob) can legitimately
    // contain the key NAME as text; the threat is the child receiving
    // the credential as its own env assignment (R13 #6(d) precedent).
    const lines = r.stdout.split('\n');
    for (const k of keys) {
      assert.ok(!lines.some((line) => line.startsWith(`${k}=`)), `stdout leaked ${k}`);
      assert.ok(!r.stdout.includes(`test-value-for-${k.toLowerCase()}`), `stdout leaked the value for ${k}`);
    }
    // Scrub is credential-only: benign ambient vars still pass through.
    assert.match(r.stdout, /^PATH=/m);
    // Secret-shaped values echoed by the command are masked, not echoed
    // verbatim (redactText masks the value with an ellipsis marker).
    const echo = await runQualityCommand(`echo "api_key=sk-proj-v3r14qgEchoToken123456"`, { timeoutMs: 10000 });
    assert.equal(echo.ok, true);
    assert.ok(!echo.stdout.includes('sk-proj-v3r14qgEchoToken123456'), 'stdout echoed the secret value verbatim');
    assert.ok(echo.stdout.includes('\u2026'), 'masked preview expected');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---------- runQualityGate ----------

test('runQualityGate: unconfigured step is skipped, not failed', async () => {
  const { store } = tmpStore();
  const r = await runQualityGate(store, 'proj-skip', 'lint');
  assert.equal(r.skipped, true);
  assert.equal(r.ok, false);
  assert.ok(r.skipReason);
});

test('runQualityGate: runs the configured command and records lastRun', async () => {
  const { store } = tmpStore();
  store.set('proj-run', { lintCmd: 'true', testCmd: 'false' });
  const lint = await runQualityGate(store, 'proj-run', 'lint');
  assert.equal(lint.skipped, false);
  assert.equal(lint.ok, true);
  const tst = await runQualityGate(store, 'proj-run', 'test');
  assert.equal(tst.ok, false);
  assert.equal(tst.exitCode, 1);
  const last = store.getLastRun('proj-run');
  assert.equal(last.lint?.ok, true);
  assert.equal(last.test?.ok, false);
  assert.ok(typeof last.test?.durationMs === 'number');
});

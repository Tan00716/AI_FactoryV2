import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAdapterInfo,
  listAdapters,
  probeAdapter,
  resolveAdapterLaunch,
} from '../src/index';

test('registry lists node/python/go with only node implemented', () => {
  const kinds = listAdapters().map((a) => a.kind);
  assert.deepEqual(kinds, ['node', 'python', 'go']);
  const node = getAdapterInfo('node');
  assert.equal(node.driver, 'builtin');
  assert.equal(node.implemented, true);
  assert.equal(getAdapterInfo('python').implemented, false);
  assert.equal(getAdapterInfo('go').implemented, false);
  assert.match(getAdapterInfo('python').installHint, /debugpy/);
  assert.match(getAdapterInfo('go').installHint, /dlv/);
});

test('unknown adapter kind throws UNKNOWN_ADAPTER', () => {
  assert.throws(() => getAdapterInfo('chrome'), (e: Error & { code?: string }) => e.code === 'UNKNOWN_ADAPTER');
});

test('probe with override: working command is available, missing binary is not', () => {
  const ok = probeAdapter('python', { command: 'node', args: ['-e', 'console.log("fake 1.2.3")'] });
  assert.equal(ok.available, true);
  assert.equal(ok.version, 'fake 1.2.3');
  const missing = probeAdapter('go', { command: 'definitely-not-a-real-binary-xyz', args: [] });
  assert.equal(missing.available, false);
  assert.match(missing.detail, /no working probe command/);
});

test('node probe reports the builtin script', () => {
  const p = probeAdapter('node');
  assert.equal(p.available, true);
  assert.equal(p.version, 'builtin');
});

test('resolveAdapterLaunch refuses python/go, never falls back to node', () => {
  assert.throws(
    () => resolveAdapterLaunch('python'),
    (e: Error & { code?: string }) => e.code === 'ADAPTER_NOT_IMPLEMENTED',
  );
  assert.throws(
    () => resolveAdapterLaunch('go'),
    (e: Error & { code?: string }) => e.code === 'ADAPTER_NOT_IMPLEMENTED',
  );
  const node = resolveAdapterLaunch('node');
  assert.equal(node.kind, 'node');
  assert.match(node.script, /node-adapter\.js$/);
});

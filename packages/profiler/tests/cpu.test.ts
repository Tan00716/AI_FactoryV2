import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { captureCpuProfile } from '../src/index';
import { ProfilerError } from '../src/index';

const FIXDIR = join(__dirname, '..', '..', 'tests', 'fixtures');

test('cpu profile finds the real hotspot function in top-3', async () => {
  const res = await captureCpuProfile({
    scriptPath: join(FIXDIR, 'hot.cjs'),
    cwd: FIXDIR,
    timeoutMs: 30000,
  });
  assert.ok(res.sampleCount > 10, `expected samples, got ${res.sampleCount}`);
  assert.ok(res.totalUs > 0, 'expected positive total time');
  assert.ok(res.durationMs > 0, 'expected measured duration');
  assert.equal(res.partial, false, 'script should finish before the timeout');
  const names = res.hotspots.slice(0, 3).map((h) => h.functionName);
  assert.ok(
    names.includes('hotLoop'),
    `hotLoop should be in top-3 hotspots, got: ${names.join(', ')}`,
  );
  const hot = res.hotspots.find((h) => h.functionName === 'hotLoop');
  assert.ok(hot, 'hotLoop hotspot entry must exist');
  assert.ok(hot.selfPct > 50, `hotLoop should dominate self time, got ${hot.selfPct}%`);
  // Flame tree is built from the same real samples.
  assert.ok(res.flame.value > 0, 'flame root must carry weight');
  assert.ok(res.flame.children.length > 0, 'flame must have frames');
});

test('cpu capture fails closed when the script does not exist', async () => {
  await assert.rejects(
    captureCpuProfile({ scriptPath: join(FIXDIR, 'nope.cjs'), cwd: FIXDIR, timeoutMs: 10000 }),
    (e) => e instanceof ProfilerError && e.code === 'not-found',
  );
});

test('cpu capture fails closed when the child is killed by timeout', async () => {
  // Verified empirically: --cpu-prof only flushes on natural exit, so a
  // timeout-killed child yields no profile — fail-closed, not partial data.
  await assert.rejects(
    captureCpuProfile({ scriptPath: join(FIXDIR, 'hot.cjs'), cwd: FIXDIR, timeoutMs: 500 }),
    (e) => e instanceof ProfilerError && e.code === 'no-profile',
  );
});

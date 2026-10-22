import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureHeapSnapshot,
  summarizeHeapSnapshot,
  diffHeapSummaries,
  type HeapSummary,
} from '../src/index';

const FIXDIR = join(__dirname, '..', '..', 'tests', 'fixtures');

/** Minimal hand-built snapshot in the REAL V8 layout (fixed 6-field nodes). */
function syntheticSnapshot(): string {
  return JSON.stringify({
    snapshot: { node_count: 4 },
    // [type, name, id, self_size, edge_count, trace_node_id]
    // types: 3=object, 1=array, 0=hidden
    nodes: [
      3, 0, 1, 100, 0, 0, // object "Widget"
      3, 0, 2, 200, 0, 0, // object "Widget"
      1, 1, 3, 50, 0, 0, //  array "Array"
      0, 2, 4, 999, 0, 0, //  hidden — must be skipped
    ],
    strings: ['Widget', 'Array', 'hidden-stuff'],
  });
}

test('summarizeHeapSnapshot parses constructor aggregates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aif-heap-parse-'));
  const p = join(dir, 's.heapsnapshot');
  writeFileSync(p, syntheticSnapshot(), 'utf8');
  const s = summarizeHeapSnapshot(p, 10);
  assert.equal(s.nodeCount, 3, 'hidden node must be skipped');
  assert.equal(s.totalBytes, 350);
  assert.equal(s.top.length, 2);
  assert.equal(s.top[0].constructor, 'Widget');
  assert.equal(s.top[0].count, 2);
  assert.equal(s.top[0].selfBytes, 300);
  assert.equal(s.top[1].constructor, 'Array');
});

test('summarizeHeapSnapshot fails closed on garbage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aif-heap-bad-'));
  const p = join(dir, 's.heapsnapshot');
  writeFileSync(p, 'not json', 'utf8');
  assert.throws(() => summarizeHeapSnapshot(p), /not valid JSON/);
  assert.throws(() => summarizeHeapSnapshot(join(dir, 'missing.heapsnapshot')), /cannot read/);
});

test('diffHeapSummaries reports per-constructor growth', () => {
  const before: HeapSummary = {
    script: 'a', durationMs: 1, totalBytes: 100, nodeCount: 2,
    top: [{ constructor: 'Widget', count: 2, selfBytes: 100, selfPct: 100 }],
  };
  const after: HeapSummary = {
    script: 'a', durationMs: 1, totalBytes: 500, nodeCount: 6,
    top: [
      { constructor: 'Widget', count: 10, selfBytes: 400, selfPct: 80 },
      { constructor: 'Gadget', count: 1, selfBytes: 100, selfPct: 20 },
    ],
  };
  const d = diffHeapSummaries(before, after);
  assert.equal(d[0].constructor, 'Widget');
  assert.equal(d[0].countDelta, 8);
  assert.equal(d[0].bytesDelta, 300);
  assert.equal(d[1].constructor, 'Gadget');
});

test('captureHeapSnapshot finds the retained LeakWidget instances', async () => {
  const res = await captureHeapSnapshot({
    scriptPath: join(FIXDIR, 'alloc.cjs'),
    cwd: FIXDIR,
    timeoutMs: 60000,
  });
  assert.ok(res.totalBytes > 0, 'expected positive heap size');
  assert.ok(res.nodeCount > 30000, `expected many nodes, got ${res.nodeCount}`);
  assert.ok(res.durationMs > 0, 'expected measured duration');
  const leak = res.top.find((t) => t.constructor === 'LeakWidget');
  assert.ok(leak, `LeakWidget should be in top-10, got: ${res.top.map((t) => t.constructor).join(', ')}`);
  assert.ok(leak.count >= 25000, `expected ~30000 retained, got ${leak.count}`);
});

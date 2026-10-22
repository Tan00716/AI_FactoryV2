/**
 * Heap snapshot capture: runs the target script with a tiny `--require`
 * preload that writes a real `v8.writeHeapSnapshot()` on process exit
 * (works for CJS and ESM scripts — no --inspect needed), then parses the
 * snapshot for per-constructor count / self-size aggregates.
 *
 * Retained size per constructor is deliberately NOT computed (dominator
 * tree over the heap graph is too costly for IDE use); the summary
 * reports self size and says so.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChild } from './spawn';
import {
  ProfilerError,
  type CaptureOptions,
  type ConstructorStat,
  type HeapGrowth,
  type HeapSummary,
} from './types';

/** Refuse to JSON.parse snapshots bigger than this (honest fail-closed). */
const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;

/**
 * V8 heap snapshot node layout is FIXED by the file format (there is no
 * node_fields section in the JSON — verified against real output):
 *   [type, name, id, self_size, edge_count, trace_node_id]
 * Node type ids: 0 hidden, 1 array, 2 string, 3 object, 4 code,
 * 5 closure, 6 regexp, 7 number, 8 native, 9 synthetic, 10 bigint.
 */
const NODE_STRIDE = 6;
const NODE_TYPE_NAMES = [
  'hidden',
  'array',
  'string',
  'object',
  'code',
  'closure',
  'regexp',
  'number',
  'native',
  'synthetic',
  'bigint',
];
const F_TYPE = 0;
const F_NAME = 1;
const F_SELF_SIZE = 3;

/** Node types we aggregate (skip hidden/synthetic bookkeeping nodes). */
const COUNTED_TYPES = new Set([
  'object',
  'closure',
  'code',
  'array',
  'regexp',
  'number',
  'string',
  'bigint',
  'native',
]);

export async function captureHeapSnapshot(opts: CaptureOptions): Promise<HeapSummary> {
  const timeoutMs = clampInt(opts.timeoutMs ?? 60000, 1000, 300000);
  const scriptArgs = Array.isArray(opts.args) ? opts.args : [];
  if (!existsSync(opts.scriptPath)) {
    throw new ProfilerError(`script does not exist: ${opts.scriptPath}`, 'not-found');
  }
  const dir = mkdtempSync(join(opts.tmpDir ?? tmpdir(), 'aif-heap-'));
  try {
    const out = join(dir, 'heap.heapsnapshot');
    const preload = join(dir, 'heap-preload.cjs');
    writeFileSync(
      preload,
      `process.on('exit', () => {\n` +
        `  try { require('node:v8').writeHeapSnapshot(${JSON.stringify(out)}); } catch (e) {}\n` +
        `});\n`,
      'utf8',
    );
    const run = await runChild(
      process.execPath,
      ['--require', preload, opts.scriptPath, ...scriptArgs],
      opts.cwd,
      timeoutMs,
    );
    if (!existsSync(out)) {
      throw new ProfilerError(
        `no heap snapshot was written (exit=${run.exitCode}, signal=${run.signal}) — ` +
          'the script must terminate on its own for the exit hook to fire',
        'no-snapshot',
      );
    }
    const summary = summarizeHeapSnapshot(out, 10);
    return { ...summary, script: opts.scriptPath, durationMs: run.durationMs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface RawSnapshot {
  snapshot?: { node_count?: number };
  nodes?: number[];
  strings?: string[];
}

/** Parse a .heapsnapshot file into constructor aggregates. Exported for tests. */
export function summarizeHeapSnapshot(
  path: string,
  topN = 10,
): { totalBytes: number; nodeCount: number; top: ConstructorStat[] } {
  const raw = readSnapshotFile(path);
  const strings = raw.strings ?? [];
  const nodes = raw.nodes ?? [];
  if (!Array.isArray(nodes) || !Array.isArray(strings)) {
    throw new ProfilerError('unrecognized heap snapshot format (missing nodes/strings)', 'bad-format');
  }
  const agg = new Map<string, { count: number; selfBytes: number }>();
  let totalBytes = 0;
  let nodeCount = 0;
  for (let i = 0; i + NODE_STRIDE <= nodes.length; i += NODE_STRIDE) {
    const typeName = NODE_TYPE_NAMES[nodes[i + F_TYPE]] ?? '';
    if (!COUNTED_TYPES.has(typeName)) continue;
    const ctor = strings[nodes[i + F_NAME]] || '(anonymous)';
    const selfSize = nodes[i + F_SELF_SIZE] || 0;
    nodeCount++;
    totalBytes += selfSize;
    let e = agg.get(ctor);
    if (!e) {
      e = { count: 0, selfBytes: 0 };
      agg.set(ctor, e);
    }
    e.count++;
    e.selfBytes += selfSize;
  }
  const top: ConstructorStat[] = [...agg.entries()]
    .map(([ctor, e]) => ({
      constructor: ctor,
      count: e.count,
      selfBytes: e.selfBytes,
      selfPct: totalBytes > 0 ? Math.round((e.selfBytes / totalBytes) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.selfBytes - a.selfBytes)
    .slice(0, Math.max(1, topN));
  return { totalBytes, nodeCount, top };
}

/** Per-constructor growth between two summaries (leak-spotting). */
export function diffHeapSummaries(before: HeapSummary, after: HeapSummary): HeapGrowth[] {
  const b = new Map(before.top.map((t) => [t.constructor, t]));
  const seen = new Set<string>();
  const out: HeapGrowth[] = [];
  for (const t of after.top) {
    seen.add(t.constructor);
    const prev = b.get(t.constructor);
    out.push({
      constructor: t.constructor,
      countDelta: t.count - (prev?.count ?? 0),
      bytesDelta: t.selfBytes - (prev?.selfBytes ?? 0),
    });
  }
  for (const t of before.top) {
    if (!seen.has(t.constructor)) {
      out.push({ constructor: t.constructor, countDelta: -t.count, bytesDelta: -t.selfBytes });
    }
  }
  return out.sort((x, y) => y.bytesDelta - x.bytesDelta);
}

function readSnapshotFile(path: string): RawSnapshot {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e) {
    throw new ProfilerError(`cannot read heap snapshot: ${(e as Error).message}`, 'read');
  }
  if (buf.length > MAX_SNAPSHOT_BYTES) {
    throw new ProfilerError(
      `heap snapshot is ${(buf.length / 1048576).toFixed(1)}MB — over the ${MAX_SNAPSHOT_BYTES / 1048576}MB parse limit`,
      'too-large',
    );
  }
  try {
    return JSON.parse(buf.toString('utf8')) as RawSnapshot;
  } catch (e) {
    throw new ProfilerError(`heap snapshot is not valid JSON: ${(e as Error).message}`, 'bad-format');
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

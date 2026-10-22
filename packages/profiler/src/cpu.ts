/**
 * CPU profile capture: spawns the target script with node's native
 * `--cpu-prof` flag (real V8 sampling — Profiler domain over CDP, no
 * model, no synthetic data), parses the .cpuprofile, and returns
 * hotspots + a folded flame tree.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldFlameTree } from './flame';
import { runChild } from './spawn';
import {
  ProfilerError,
  type CpuCaptureOptions,
  type CpuHotspot,
  type CpuProfileResult,
  type SampledStack,
  type StackFrame,
} from './types';

interface CpuProfileNode {
  id: number;
  callFrame: { functionName?: string; url?: string; lineNumber?: number };
  children?: number[];
}

interface CpuProfileFile {
  nodes: CpuProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
  startTime?: number;
  endTime?: number;
}

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_INTERVAL_US = 1000;

export async function captureCpuProfile(opts: CpuCaptureOptions): Promise<CpuProfileResult> {
  const timeoutMs = clampInt(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, 300000);
  const intervalUs = clampInt(opts.sampleIntervalUs ?? DEFAULT_INTERVAL_US, 100, 1000000);
  const scriptArgs = Array.isArray(opts.args) ? opts.args : [];
  if (!existsSync(opts.scriptPath)) {
    throw new ProfilerError(`script does not exist: ${opts.scriptPath}`, 'not-found');
  }

  const dir = mkdtempSync(join(opts.tmpDir ?? tmpdir(), 'aif-cpuprof-'));
  try {
    const nodeArgs = [
      '--cpu-prof',
      `--cpu-prof-dir=${dir}`,
      '--cpu-prof-name=cpu.cpuprofile',
      `--cpu-prof-interval=${intervalUs}`,
      opts.scriptPath,
      ...scriptArgs,
    ];
    const run = await runChild(process.execPath, nodeArgs, opts.cwd, timeoutMs);

    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.cpuprofile'))
      .map((f) => join(dir, f))
      .sort();
    if (files.length === 0) {
      throw new ProfilerError(
        `no .cpuprofile was written (exit=${run.exitCode}, signal=${run.signal}) — ` +
          (run.timedOut
            ? 'the child was killed by the timeout before V8 flushed the profile (--cpu-prof only writes on natural exit)'
            : 'the script may have failed before V8 flushed the profile'),
        'no-profile',
      );
    }
    const raw = JSON.parse(readFileSync(files[0], 'utf8')) as CpuProfileFile;
    const stacks = samplesToStacks(raw);
    const totalUs = stacks.reduce((s, st) => s + st.weight, 0);
    return {
      script: opts.scriptPath,
      args: scriptArgs,
      durationMs: run.durationMs,
      sampleCount: stacks.length,
      totalUs,
      partial: run.timedOut,
      hotspots: summarizeHotspots(stacks, totalUs),
      flame: foldFlameTree(stacks),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Convert the flat V8 sample list into root->leaf stacks with weights. */
export function samplesToStacks(raw: CpuProfileFile): SampledStack[] {
  const byId = new Map<number, CpuProfileNode>();
  for (const n of raw.nodes ?? []) byId.set(n.id, n);
  const parent = new Map<number, number>();
  for (const n of raw.nodes ?? []) {
    for (const c of n.children ?? []) parent.set(c, n.id);
  }
  const samples = raw.samples ?? [];
  const deltas = raw.timeDeltas ?? [];
  const stacks: SampledStack[] = [];
  for (let i = 0; i < samples.length; i++) {
    const frames: StackFrame[] = [];
    let id: number | undefined = samples[i];
    const seen = new Set<number>();
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      const node = byId.get(id);
      if (!node) break;
      frames.unshift({
        name: node.callFrame.functionName || '(anonymous)',
        url: node.callFrame.url || '',
        line: (node.callFrame.lineNumber ?? 0) + 1,
      });
      id = parent.get(id);
    }
    if (frames.length > 0) {
      stacks.push({ frames, weight: Math.max(0, deltas[i] ?? 0) });
    }
  }
  return stacks;
}

/** Aggregate self/total time per function; top-10 by self time. */
export function summarizeHotspots(stacks: SampledStack[], totalUs: number): CpuHotspot[] {
  const agg = new Map<string, { frame: StackFrame; self: number; total: number }>();
  for (const st of stacks) {
    st.frames.forEach((f, i) => {
      const key = `${f.name}\n${f.url}:${f.line}`;
      let e = agg.get(key);
      if (!e) {
        e = { frame: f, self: 0, total: 0 };
        agg.set(key, e);
      }
      e.total += st.weight;
      if (i === st.frames.length - 1) e.self += st.weight;
    });
  }
  const pct = (v: number) => (totalUs > 0 ? (v / totalUs) * 100 : 0);
  return [...agg.values()]
    .map((e) => ({
      functionName: e.frame.name,
      url: e.frame.url,
      line: e.frame.line,
      selfUs: Math.round(e.self),
      totalUs: Math.round(e.total),
      selfPct: round2(pct(e.self)),
      totalPct: round2(pct(e.total)),
    }))
    .sort((a, b) => b.selfUs - a.selfUs)
    .slice(0, 10);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

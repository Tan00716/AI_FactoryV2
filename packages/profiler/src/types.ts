/**
 * @ai-factory/profiler — shared types (round-4 task R4-A7).
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - CPU profiles are real V8 samples: the target script is spawned with
 *    node's native `--cpu-prof` flag and the resulting .cpuprofile is
 *    parsed — no synthetic data anywhere in the pipeline.
 *  - Heap snapshots are real `v8.writeHeapSnapshot()` output, parsed for
 *    per-constructor count / self-size aggregates.
 *  - "Retained size" per constructor is NOT computed: true retained size
 *    needs a dominator tree over the heap graph, which is too costly to
 *    build inside the IDE. The UI labels the column "self size" honestly.
 *  - Heap capture runs the script via `node --require <preload>`; the
 *    script may be CJS or ESM, but it must terminate on its own (the
 *    snapshot is written on process exit).
 *  - Sampling is statistical: very short functions may be missed; the
 *    reported sampleCount / totalUs let the user judge significance.
 */

export interface CaptureOptions {
  /** Absolute path of the script to run. */
  scriptPath: string;
  /** Extra argv for the script. */
  args?: string[];
  /** Working directory of the child process. */
  cwd: string;
  /** Kill the child after this many ms (default 60000). */
  timeoutMs?: number;
  /** Scratch dir parent (default os.tmpdir()). */
  tmpDir?: string;
}

export interface CpuCaptureOptions extends CaptureOptions {
  /** V8 sampling interval in microseconds (default 1000). */
  sampleIntervalUs?: number;
}

export interface StackFrame {
  name: string;
  url: string;
  line: number;
}

export interface SampledStack {
  frames: StackFrame[]; // root -> leaf
  weight: number; // microseconds
}

export interface CpuHotspot {
  functionName: string;
  url: string;
  line: number;
  selfUs: number;
  totalUs: number;
  selfPct: number;
  totalPct: number;
}

export interface FlameNode {
  name: string;
  /** Total microseconds including children. */
  value: number;
  /** Self microseconds (leaf samples only). */
  self: number;
  children: FlameNode[];
}

export interface CpuProfileResult {
  script: string;
  args: string[];
  /** Wall-clock ms the capture took (real, measured). */
  durationMs: number;
  sampleCount: number;
  /** Sum of sample deltas in microseconds. */
  totalUs: number;
  /** True when the child was killed by timeout and the profile is truncated. */
  partial: boolean;
  hotspots: CpuHotspot[];
  flame: FlameNode;
}

export interface ConstructorStat {
  constructor: string;
  count: number;
  selfBytes: number;
  selfPct: number;
}

export interface HeapSummary {
  script: string;
  /** Wall-clock ms the capture took (real, measured). */
  durationMs: number;
  totalBytes: number;
  nodeCount: number;
  top: ConstructorStat[];
}

export interface HeapGrowth {
  constructor: string;
  countDelta: number;
  bytesDelta: number;
}

export class ProfilerError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ProfilerError';
    this.code = code;
  }
}

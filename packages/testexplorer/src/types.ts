/** Shared shapes for the test explorer (Round 7 #3). */

export type CaseStatus = 'pass' | 'fail' | 'skip' | 'todo';

export interface DiscoveredCase {
  /** Leaf name as written, e.g. 'adds'. */
  name: string;
  /** Full name with describe chain, e.g. 'math > adds'. */
  fullName: string;
  /** 1-based line of the test call. */
  line: number;
}

export interface DiscoveredFile {
  /** Absolute path. */
  path: string;
  /** Path relative to the discovery root, posix-style. */
  rel: string;
  cases: DiscoveredCase[];
  /** Set when the file was found but not parsed (e.g. over the size cap). */
  skipped?: string;
}

export interface DiscoveredPackage {
  /** package.json name, or the directory basename when unnamed. */
  name: string;
  /** Absolute directory path. */
  path: string;
  /** Directory relative to the discovery root ('.' for the root itself). */
  rel: string;
  files: DiscoveredFile[];
}

export interface Discovery {
  root: string;
  packages: DiscoveredPackage[];
  totals: { packages: number; files: number; cases: number };
  /** True when a cap cut discovery short: results are partial. */
  degraded: boolean;
  degradedReason?: string;
}

export interface CaseResult {
  /** Absolute test-file path. */
  file: string;
  /** Leaf name as reported by node:test. */
  name: string;
  /** Describe chain + leaf name, e.g. 'math > adds'. */
  fullName: string;
  status: CaseStatus;
  /** Milliseconds for this leaf test (node:test reported). */
  durationMs: number;
  /** Failure message + stack, capped (see run.ts). Absent on pass/skip. */
  error?: string;
}

export interface RunSummary {
  pass: number;
  fail: number;
  skip: number;
  todo: number;
  total: number;
  durationMs: number;
}

export interface RunOutcome {
  results: CaseResult[];
  summary: RunSummary;
  /** Captured child stdout, capped (see run.ts). */
  stdout: string;
  /** Captured child stderr, capped. */
  stderr: string;
  /** True when stdout/stderr capture hit the cap. */
  truncated: boolean;
  /** True when the run was killed by the timeout. */
  timedOut: boolean;
  /** Child exit code (null when killed). */
  exitCode: number | null;
  /** Run-level failure (runner crash, missing file, timeout): no leaf results. */
  runError?: string;
  /** Per-file load verdicts for files that produced no cases. */
  fileErrors?: Array<{ file: string; error: string }>;
}

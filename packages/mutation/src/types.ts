/**
 * @ai-factory/mutation — shared types.
 *
 * Deterministic, zero-model mutation testing kernel. Text-level operators
 * only (no AST, no semantics); verdicts come from actually running the
 * project's own tests against each mutant.
 */

/** Final verdict for one mutant. */
export type MutantVerdict = 'killed' | 'survived' | 'timeout' | 'invalid';

/** One generated mutant: a single textual change at a source location. */
export interface Mutant {
  /** Stable id: `${file}:${line}:${column}:${operator}`. */
  id: string;
  /** Source file, relative to the target dir as supplied by the caller. */
  file: string;
  /** Operator name, e.g. 'arithmetic-plus'. */
  operator: string;
  /** 1-based line of the mutation site. */
  line: number;
  /** 1-based column of the mutation site. */
  column: number;
  /** 0-based offset of the mutation site into the source text. */
  offset: number;
  /** Length of the original text being replaced. */
  length: number;
  /** Original source text at the site. */
  original: string;
  /** Replacement text. */
  replacement: string;
  /** Human-readable description, e.g. "`+` → `-`". */
  description: string;
}

/** Sampling budgets. Everything is deterministic given the seed. */
export interface SamplingConfig {
  /** Integer seed for the shuffle; same seed + same mutants = same sample. */
  seed: number;
  /** Max mutants to run in one sampled run. */
  maxMutants: number;
  /** Max mutants taken from a single file. */
  perFileCap: number;
}

/**
 * Minimal structural sandbox decision (V3R18 #6(m)). The server's
 * ExecSandboxDecision is assignable to this; the mutation package must
 * not import the server's exec-sandbox module.
 */
export interface MutantSandboxDecision {
  prefix: string[];
  refused: boolean;
  reason: string | null;
  refuseCode: string | null;
}

/** Options for executing one mutant's tests. */
export interface MutantRunOptions {
  /** Test command argv, e.g. ['node','--test','--test-reporter=tap','calc.test.ts']. */
  testCommand: string[];
  /** Wall-clock budget per mutant. */
  timeoutMs: number;
  /** Cap on captured child output bytes. */
  maxOutputBytes: number;
  /** When true (default), run `node --check` on the mutated file first
   * (JS only — skipped for TypeScript, whose checkSyntax does not
   * type-strip); syntax errors become the 'invalid' verdict instead
   * of 'killed'. */
  nodeCheck: boolean;
  /** V3R18 #6(m): sandbox decider for the mutant test runs. When set,
   * each mutant's test command runs inside the exec bwrap sandbox
   * (cwd = the mutant's scratch dir); when the decision is refused the
   * run throws SANDBOX_UNAVAILABLE. The decider receives the scratch
   * dir — never the target dir — so the prefix's --chdir matches the
   * spawn cwd. Unset → unsandboxed (pre-R18 behavior, used by the
   * src-direct unit tests). */
  decideSandbox?: (cwd: string) => Promise<MutantSandboxDecision>;
}

/** Outcome of running the tests against one mutant. */
export interface MutantRunResult {
  mutant: Mutant;
  verdict: MutantVerdict;
  durationMs: number;
  /** Child exit code; null when the child never exited (timeout/spawn error). */
  exitCode: number | null;
  timedOut: boolean;
  /** Tail of combined child output (capped).
   *
   * Persisted reports replace this field with
   * PERSISTED_OUTPUT_TAIL_NOTE (see stripReportForPersist in report.ts):
   * child output tails are never stored on disk, because mutant test
   * output can echo ambient credentials and persisted reports are
   * readable back through cross-feature file readers (R16 N2). The
   * in-memory report keeps the real tail. */
  outputTail: string;
  /** Short machine note, e.g. 'node --check failed' or 'budget exceeded'. */
  note: string;
}

/** Aggregate counts for a report. */
export interface MutationTotals {
  /** Mutants generated before sampling. */
  generated: number;
  /** Mutants selected by sampling and actually attempted. */
  sampled: number;
  killed: number;
  survived: number;
  timeout: number;
  invalid: number;
  /**
   * Mutation score: killed / (killed + survived).
   * null when there are no decisive verdicts. Timeouts and invalid
   * mutants are reported separately and never counted as killed.
   */
  score: number | null;
}

/** Full report for one sampled mutation run. */
export interface MutationReport {
  runId: string;
  seed: number;
  generatedAt: string;
  target: { dir: string; files: string[]; testFiles: string[] };
  sampling: { maxMutants: number; perFileCap: number };
  timeoutMs: number;
  /** True when the run stopped early (budget hit). Attempted mutants are
   * still reported; unattempted ones are simply absent. */
  truncated: boolean;
  truncateReason: string | null;
  totals: MutationTotals;
  results: MutantRunResult[];
}

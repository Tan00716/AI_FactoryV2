/**
 * Core types for the Code Review Agent (spec §35).
 *
 * The review is a deterministic static heuristic pass — no LLM. Each of the
 * 10 spec dimensions runs its own checker and emits Findings; the verdict
 * aggregates by severity.
 */

/** The 10 review dimensions from spec §35, in spec order. */
export type ReviewDimension =
  | 'correctness'
  | 'architecture'
  | 'readability'
  | 'maintainability'
  | 'security'
  | 'performance'
  | 'testCoverage'
  | 'regressionRisk'
  | 'projectConventions'
  | 'dependencyChanges';

export const ALL_DIMENSIONS: readonly ReviewDimension[] = [
  'correctness',
  'architecture',
  'readability',
  'maintainability',
  'security',
  'performance',
  'testCoverage',
  'regressionRisk',
  'projectConventions',
  'dependencyChanges',
] as const;

export type ReviewSeverity = 'info' | 'warning' | 'error' | 'blocker';

/** §35 output verdicts. */
export type ReviewVerdict =
  | 'PASS'
  | 'PASS_WITH_WARNINGS'
  | 'CHANGES_REQUESTED'
  | 'BLOCK';

/** One review observation from a single dimension. */
export interface Finding {
  dimension: ReviewDimension;
  severity: ReviewSeverity;
  message: string;
  file?: string;
  line?: number;
}

/** One file under review. `before` is absent for new files. */
export interface ReviewFile {
  path: string;
  before?: string;
  after?: string;
}

export interface ReviewInput {
  /** Files under review. Content falls back to `diff` when `after` is absent. */
  files: ReviewFile[];
  /** Unified diff; parsed per-file when a file has no `after` content. */
  diff?: string;
  /** Project convention keywords, e.g. ['no-console', 'kebab-case-filenames']. */
  projectConventions?: string[];
  /**
   * SPEC v2 §37: the reviewer's own words about the change ("already
   * verified", rationale, …). Readable by the reviewer, but NEVER evidence —
   * reviewCode() only inspects files/diffs, so notes cannot flip a verdict.
   */
  implementerNotes?: string;
}

export interface ReviewSummary {
  total: number;
  blocker: number;
  error: number;
  warning: number;
  info: number;
  filesReviewed: number;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  findings: Finding[];
  dimensions: readonly ReviewDimension[];
  summary: ReviewSummary;
  reviewedAt: string;
}

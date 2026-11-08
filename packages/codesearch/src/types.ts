/**
 * @ai-factory/codesearch — project-wide text search, index-free.
 *
 * Design: this is a grep, not an index. Nothing here builds, stores, or
 * refreshes a search index — the walk happens on demand per query, so
 * results always reflect the files as they are right now (still a
 * snapshot: nothing watches the filesystem between runs).
 *
 * Honest boundaries (rendered in the desktop UI too):
 *  1. Results are a snapshot of the files at search time. File changes
 *     after the run require an explicit re-run; nothing is live-synced.
 *  2. On-demand walk: large trees are slower than an indexed engine
 *     (codeindex covers the agent-side indexed path). Caps below keep
 *     a single search fail-closed.
 *  3. Regex runs in the caller process with no ReDoS sandbox — same
 *     trust posture as problem-matcher and TODO regexes (the operator's
 *     own foot-gun). Patterns are length-capped and empty-match
 *     patterns are rejected, which stops the trivially catastrophic
 *     cases but not adversarial ones.
 *  4. Binary files are skipped by NUL-byte sniffing; symlinks are never
 *     followed; ignored paths are pruned only when the caller passes an
 *     ignore predicate (the server route wires the two-tier ignore gate).
 */

export interface CodeSearchQuery {
  /** The search text or regex source. */
  query: string;
  /** Treat query as a regular expression. Default false (literal). */
  regex?: boolean;
  /** Case-sensitive matching. Default false. */
  caseSensitive?: boolean;
  /**
   * File include globs (comma-separated or array), e.g. ["src/**", "*.md"].
   * Simple glob dialect: `*`, `**`, `?`. Relative to the search root,
   * posix separators. Empty/absent = all text files.
   */
  glob?: string | string[];
  /** Cap on total matches returned. Default 2000, hard-capped at 10000. */
  maxMatches?: number;
}

export interface NormalizedCodeSearchQuery {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  globs: string[];
  maxMatches: number;
}

/** One matched line. */
export interface CodeSearchMatch {
  /** Workspace-relative posix path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based UTF-16 column where the match starts. */
  column: number;
  /** The matched line text, trimmed to MAX_LINE_CHARS. */
  text: string;
}

/** Matches grouped by file, files sorted ascending. */
export interface CodeSearchFileGroup {
  file: string;
  matches: CodeSearchMatch[];
}

export interface CodeSearchStats {
  filesScanned: number;
  linesScanned: number;
  skippedBinary: number;
  skippedTooLarge: number;
  /** True when a cap stopped the walk/matching early (result incomplete). */
  truncated: boolean;
  durationMs: number;
}

export interface CodeSearchResult {
  query: NormalizedCodeSearchQuery;
  groups: CodeSearchFileGroup[];
  /** Total matches across all groups (== sum of group lengths). */
  totalMatches: number;
  stats: CodeSearchStats;
}

export interface CodeSearchOptions {
  /**
   * Extra exclusion predicate over the absolute path; directories are
   * pruned when it returns true. The server route passes the two-tier
   * ignore gate here.
   */
  ignore?: (abs: string, isDir: boolean) => boolean;
  /**
   * Override for the control-plane directory set (R20 #6(u)). Defaults
   * to controlPlaneDirs() from @ai-factory/security, read from the
   * ambient process env. Tests may inject an explicit set to avoid
   * depending on ambient env.
   */
  controlDirs?: string[];
  /** Override the match cap (still hard-capped at HARD_MAX_MATCHES). */
  maxMatches?: number;
  /** Clock injection for deterministic durationMs in tests. */
  now?: () => number;
}

export class CodeSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeSearchError';
  }
}

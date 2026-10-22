/**
 * Shared types for @ai-factory/blame (round-5 task R5-A4).
 *
 * HONEST BOUNDARIES (mirrored in the server route + desktop UI):
 *  - Blame is a snapshot: it reflects the working tree at call time. Edits
 *    after the call are not reflected until the next request.
 *  - Lines not yet committed carry the all-zero sha and are surfaced as
 *    `uncommitted: true` with the current author unknown (marked
 *    "uncommitted" / "未提交").
 *  - Timeline fusion is a best-effort merge of git log entries and
 *    Local History snapshots sorted by wall-clock time descending. Snapshot
 *    times come from snapshot file names (epoch ms); git times come from
 *    committer timestamps.
 */

/** All-zero sha that `git blame --porcelain` emits for uncommitted lines. */
export const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';

export interface BlameLine {
  /** 1-based line number. */
  line: number;
  /** Full 40-char commit sha (UNCOMMITTED_SHA when uncommitted). */
  hash: string;
  /** Short sha (7 chars) for display. */
  shortHash: string;
  /** Commit author name; 'uncommitted' when not yet committed. */
  author: string;
  /** Author e-mail ('' when uncommitted). */
  authorMail: string;
  /** Author epoch seconds (0 when uncommitted). */
  authorTime: number;
  /** Commit summary ('' when uncommitted). */
  summary: string;
  /** True for working-tree lines with no commit yet. */
  uncommitted: boolean;
}

export interface BlameResult {
  /** Absolute repo root the blame ran against. */
  repoRoot: string;
  /** Workspace-relative file path. */
  file: string;
  lines: BlameLine[];
  /** True when the file exceeded the line cap and blame stopped early. */
  truncated: boolean;
  /** Line cap that was applied. */
  lineCap: number;
}

export interface TimelineGitEntry {
  kind: 'git';
  hash: string;
  shortHash: string;
  author: string;
  /** Epoch seconds. */
  date: number;
  message: string;
}

export interface TimelineSnapshotEntry {
  kind: 'snapshot';
  /** Snapshot id (file name inside the history dir). */
  id: string;
  /** Epoch milliseconds. */
  dateMs: number;
  /** 'save' | 'pre-restore'. */
  snapshotKind: string;
  /** Byte size of the snapshot. */
  size: number;
}

export type TimelineEntry = TimelineGitEntry | TimelineSnapshotEntry;

export interface TimelineResult {
  /** Absolute repo root, or '' when not in a git repo (snapshots only). */
  repoRoot: string;
  /** Workspace-relative file path. */
  file: string;
  entries: TimelineEntry[];
  /** True when the directory is not inside a git repository. */
  noGit: boolean;
}

/** A diff endpoint reference to one timeline point. */
export interface TimelinePoint {
  type: 'git' | 'snapshot' | 'work';
  /** Commit hash (git) or snapshot id (snapshot); empty for work. */
  ref: string;
}

export class BlameError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'BlameError';
    this.code = code;
  }
}

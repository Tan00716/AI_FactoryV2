/**
 * Mnemonic bookmarks (round-5 R5-B9) — shared types.
 *
 * A bookmark pins one of three scopes:
 *   - 'line': a file + 1-based line (drift-aware, see relocateLine)
 *   - 'file': a whole file
 *   - 'dir':  a directory
 *
 * Optional `mnemonic` is a single [0-9a-z] character: the desktop binds
 * `bookmark.jump.<mnemonic>` commands to these so a user keybinding like
 * ctrl+5 jumps straight to the bookmark. Mnemonics are unique per project
 * root (fail-closed on duplicates).
 *
 * Drift honesty: a line bookmark stores a sha256 of up to 5 context lines
 * around the pinned line at creation time. On resolve, if the content at
 * the stored line no longer matches, relocation searches nearby and either
 * returns the new line ('relocated') or admits defeat ('drifted'). The UI
 * shows the drift state; it never silently jumps to a wrong line.
 */
export type BookmarkKind = 'line' | 'file' | 'dir';

export interface Bookmark {
  id: string;
  kind: BookmarkKind;
  /** Root-relative path, forward slashes, no leading './'. */
  path: string;
  /** 1-based, line kind only. */
  line?: number;
  /** Single [0-9a-z] character, or undefined. */
  mnemonic?: string;
  label: string;
  tags: string[];
  /** sha256 hex of contextLines.join('\n'); line kind only. */
  contextHash?: string;
  /** Up to 5 lines centered on `line` at creation; line kind only. */
  contextLines?: string[];
  createdAt: number;
}

export type RelocationStatus = 'ok' | 'relocated' | 'drifted';

export interface Relocation {
  status: RelocationStatus;
  /** Resolved 1-based line (=== stored line when status is 'ok'). */
  line: number;
}

/** Mnemonic alphabet: digits + lowercase ascii letters. */
export const MNEMONIC_RE = /^[0-9a-z]$/;

/** How many context lines we store (2 above, the line, 2 below). */
export const CONTEXT_RADIUS = 2;

/** Relocation search window: +/- this many lines around the stored line. */
export const RELOCATE_WINDOW = 300;

/** Max bookmark count per project root (fail-closed DoS guard). */
export const MAX_BOOKMARKS_PER_ROOT = 500;

export interface BookmarkInput {
  kind: BookmarkKind;
  path: string;
  line?: number;
  mnemonic?: string;
  label?: string;
  tags?: string[];
}

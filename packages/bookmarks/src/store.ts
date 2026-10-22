/**
 * Bookmark store logic (round-5 R5-B9). Pure, zero-dependency, UI-agnostic.
 *
 * The hashing function is injected (`hashLines`) so this package stays
 * free of node:crypto — the desktop bundle (vite) cannot import node
 * builtins, and the server passes its own sha256. Nothing here touches
 * the filesystem: persistence lives in the server route.
 */
import {
  CONTEXT_RADIUS,
  MAX_BOOKMARKS_PER_ROOT,
  MNEMONIC_RE,
  RELOCATE_WINDOW,
  type Bookmark,
  type BookmarkInput,
  type Relocation,
} from './types.js';

/** Injected line-hash: sha256 hex of lines.join('\n') on the server. */
export type HashLines = (lines: string[]) => string;

/** Fail-closed validation of a bookmark input. Empty = valid. */
export function validateBookmarkInput(input: unknown): string[] {
  const issues: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return ['bookmark must be an object'];
  }
  const b = input as Record<string, unknown>;
  if (b['kind'] !== 'line' && b['kind'] !== 'file' && b['kind'] !== 'dir') {
    issues.push("kind must be 'line', 'file' or 'dir'");
  }
  if (typeof b['path'] !== 'string' || !b['path'].trim() || b['path'].length > 1024) {
    issues.push('path must be a non-empty string (max 1024 chars)');
  } else {
    const p = b['path'] as string;
    if (p.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(p)) {
      issues.push('path must not contain NUL or ".." segments');
    }
  }
  if (b['kind'] === 'line') {
    if (!Number.isInteger(b['line']) || (b['line'] as number) < 1) {
      issues.push('line bookmarks require a 1-based integer line');
    }
  } else if (b['line'] !== undefined) {
    issues.push('line is only allowed for line bookmarks');
  }
  if (b['mnemonic'] !== undefined) {
    if (typeof b['mnemonic'] !== 'string' || !MNEMONIC_RE.test(b['mnemonic'])) {
      issues.push('mnemonic must be a single [0-9a-z] character');
    }
  }
  if (b['label'] !== undefined && (typeof b['label'] !== 'string' || b['label'].length > 200)) {
    issues.push('label must be a string of at most 200 chars');
  }
  if (b['tags'] !== undefined) {
    if (
      !Array.isArray(b['tags']) ||
      b['tags'].length > 20 ||
      (b['tags'] as unknown[]).some(
        (t) => typeof t !== 'string' || !t.trim() || t.length > 40,
      )
    ) {
      issues.push('tags must be an array of at most 20 non-empty strings (max 40 chars each)');
    }
  }
  return issues;
}

/** Normalize a root-relative path to forward slashes, no leading './'. */
export function normalizePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
}

export interface AddBookmarkArgs {
  existing: Bookmark[];
  input: BookmarkInput;
  fileText?: string;
  hashLines: HashLines;
  now?: () => number;
  makeId?: () => string;
}

/**
 * Add a bookmark to the in-memory list. Fail-closed: returns { issues }
 * and never mutates on any validation failure. On success the bookmark is
 * appended and returned. Line bookmarks capture context lines + hash from
 * `fileText` (required for kind 'line').
 */
export function addBookmark(args: AddBookmarkArgs): { bookmark?: Bookmark; issues: string[] } {
  const { existing, input } = args;
  const issues = validateBookmarkInput(input);
  if (issues.length > 0) return { issues };
  if (existing.length >= MAX_BOOKMARKS_PER_ROOT) {
    return { issues: [`bookmark limit reached (${MAX_BOOKMARKS_PER_ROOT} per project root)`] };
  }
  const path = normalizePath(input.path);
  if (input.mnemonic) {
    const clash = existing.find((b) => b.mnemonic === input.mnemonic);
    if (clash) {
      return { issues: [`mnemonic '${input.mnemonic}' is already used by bookmark ${clash.id}`] };
    }
  }
  if (existing.some((b) => b.kind === input.kind && b.path === path && (b.line ?? 0) === (input.line ?? 0))) {
    return { issues: ['an identical bookmark already exists'] };
  }
  const now = args.now ?? Date.now;
  const makeId = args.makeId ?? defaultId;
  const bookmark: Bookmark = {
    id: makeId(),
    kind: input.kind,
    path,
    label:
      input.label && input.label.trim()
        ? input.label.trim()
        : input.kind === 'line'
          ? `${path}:${input.line}`
          : path,
    tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
    createdAt: now(),
  };
  if (input.line !== undefined) bookmark.line = input.line;
  if (input.mnemonic) bookmark.mnemonic = input.mnemonic;
  if (input.kind === 'line') {
    if (typeof args.fileText !== 'string') {
      return { issues: ['line bookmarks require the file text to capture drift context'] };
    }
    const lines = args.fileText.split('\n');
    const idx = (input.line as number) - 1;
    const contextLines = lines.slice(
      Math.max(0, idx - CONTEXT_RADIUS),
      idx + CONTEXT_RADIUS + 1,
    );
    bookmark.contextLines = contextLines;
    bookmark.contextHash = args.hashLines(contextLines);
  }
  return { bookmark, issues: [] };
}

function defaultId(): string {
  // Browser-safe id: no node:crypto here (see module header).
  return `bm_${Date.now().toString(36)}_${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

/**
 * Resolve a line bookmark against current file content.
 *
 * - 'ok': the stored line's context still matches → same line.
 * - 'relocated': context found within +/- RELOCATE_WINDOW → new line
 *   (best-effort; the UI shows "relocated" so the user can verify).
 * - 'drifted': no match anywhere in the window → the caller must NOT jump
 *   silently; the UI marks the bookmark drifted.
 */
export function relocateLine(
  content: string,
  bookmark: Bookmark,
  hashLines: HashLines,
): Relocation {
  const storedLine = bookmark.line ?? 1;
  const lines = content.split('\n');
  const stored = bookmark.contextLines ?? [];
  const storedHash = bookmark.contextHash;
  if (stored.length === 0 || !storedHash) {
    // Legacy bookmark without context: trust the line number but flag it
    // as unverifiable → 'drifted' is wrong; treat as 'ok' only when the
    // line is in range. We cannot verify, so be honest: 'relocated' would
    // lie. Return 'ok' and let the UI note "no drift context".
    return { status: 'ok', line: Math.min(Math.max(1, storedLine), lines.length) };
  }
  const at = (lineNo: number): string[] => {
    const idx = lineNo - 1;
    return lines.slice(Math.max(0, idx - CONTEXT_RADIUS), idx + CONTEXT_RADIUS + 1);
  };
  if (storedLine >= 1 && storedLine <= lines.length && hashLines(at(storedLine)) === storedHash) {
    return { status: 'ok', line: storedLine };
  }
  for (let d = 1; d <= RELOCATE_WINDOW; d++) {
    for (const candidate of [storedLine - d, storedLine + d]) {
      if (candidate < 1 || candidate > lines.length) continue;
      if (hashLines(at(candidate)) === storedHash) {
        return { status: 'relocated', line: candidate };
      }
    }
  }
  return { status: 'drifted', line: storedLine };
}

/** Remove a bookmark by id. Returns the removed bookmark or null. */
export function removeBookmark(existing: Bookmark[], id: string): Bookmark | null {
  const i = existing.findIndex((b) => b.id === id);
  if (i < 0) return null;
  const [removed] = existing.splice(i, 1);
  return removed;
}

/** Update label/tags/mnemonic. Fail-closed on mnemonic clash. */
export function updateBookmark(
  existing: Bookmark[],
  id: string,
  patch: { label?: string; tags?: string[]; mnemonic?: string | null },
): { bookmark?: Bookmark; issues: string[] } {
  const target = existing.find((b) => b.id === id);
  if (!target) return { issues: ['bookmark not found'] };
  const issues: string[] = [];
  if (patch.label !== undefined && (typeof patch.label !== 'string' || patch.label.length > 200)) {
    issues.push('label must be a string of at most 200 chars');
  }
  if (
    patch.tags !== undefined &&
    (!Array.isArray(patch.tags) ||
      patch.tags.length > 20 ||
      patch.tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 40))
  ) {
    issues.push('tags must be an array of at most 20 non-empty strings (max 40 chars each)');
  }
  if (patch.mnemonic !== undefined && patch.mnemonic !== null) {
    if (typeof patch.mnemonic !== 'string' || !MNEMONIC_RE.test(patch.mnemonic)) {
      issues.push('mnemonic must be a single [0-9a-z] character');
    } else {
      const clash = existing.find((b) => b.id !== id && b.mnemonic === patch.mnemonic);
      if (clash) issues.push(`mnemonic '${patch.mnemonic}' is already used by bookmark ${clash.id}`);
    }
  }
  if (issues.length > 0) return { issues };
  if (patch.label !== undefined) target.label = patch.label.trim() || target.label;
  if (patch.tags !== undefined) target.tags = patch.tags.map((t) => t.trim()).filter(Boolean);
  if (patch.mnemonic === null) delete target.mnemonic;
  else if (patch.mnemonic !== undefined) target.mnemonic = patch.mnemonic;
  return { bookmark: target, issues: [] };
}

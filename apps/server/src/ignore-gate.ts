/**
 * Ignore gate — the single choke point for the two-tier ignore files
 * (Cursor-style `.ai-factory/ignore` / `.ai-factory/indexing-ignore`,
 * zero model). Task ②, second strengthening round.
 *
 * Every AI surface that enumerates or serves local file content funnels
 * through here:
 *   - codeindex walk + search (forIndex=true)
 *   - repomap build (forIndex=true, via codeindex)
 *   - @-context providers @tree/@diff/@open (forIndex=false; only the
 *     hard tier hides a file from explicitly-referenced context)
 *   - backup project-file enumeration (forIndex=false)
 *
 * Design notes:
 *  - FULLY SYNCHRONOUS: ignore files are tiny config; the gate re-stats
 *    both files on every access (mtime hot reload) and only re-reads on
 *    change. This keeps it usable from synchronous call sites (the tree
 *    provider walk) without async plumbing.
 *  - Per-root cache (one IgnoreSet per resolved root). resetIgnoreGate()
 *    exists for hermetic tests.
 *  - Loud skips: when a layer fails to load, the audit hook fires
 *    IGNORE_LAYER_SKIPPED (deduped per file mtime so a broken file does
 *    not spam the chain). The hook is wired by index.ts to the process
 *    AuditLog; tests can install their own. A skipped layer matches
 *    NOTHING — a corrupt ignore file never silently swallows everything.
 *  - This module value-imports node builtins + the @ai-factory/ignores
 *    package only (no relative sibling value-imports), so server tests
 *    may import it straight from src under node's type-stripping ESM
 *    loader (dual-mode import rule — see AGENTS.md).
 *
 * HONEST BOUNDARY: the gate only constrains the tool surfaces that
 * consult it. It cannot stop the OS, another tool, or the operator's own
 * exec/terminal from reading a file — that is by design (the user's own
 * actions are not the AI's context). The /api/files editor surface is
 * deliberately ungated: hiding files from the user's own editor view
 * would be the product lying to its operator.
 */

import { resolve as resolvePath } from 'node:path';
import { IgnoreSet, type IgnoreVerdict } from '@ai-factory/ignores';

const sets = new Map<string, IgnoreSet>();

export type IgnoreGateAuditHook = (
  root: string,
  layer: 'hard' | 'indexing',
  message: string,
) => void;

let auditHook: IgnoreGateAuditHook | null = null;
/** Dedupes IGNORE_LAYER_SKIPPED per (root, layer, mtime) — a broken file
 *  is reported once per change, not once per access. */
const auditedSkips = new Set<string>();

/** Test seam / boot wiring: where IGNORE_LAYER_SKIPPED goes. */
export function setIgnoreGateAuditHook(fn: IgnoreGateAuditHook | null): void {
  auditHook = fn;
}

/** Test seam: drop the per-root cache. */
export function resetIgnoreGate(): void {
  sets.clear();
  auditedSkips.clear();
}

/**
 * Get (and hot-reload) the IgnoreSet for a root. Never throws for a
 * missing/unreadable ignore file — that is a loud layer skip, reported
 * through errors() + the audit hook.
 */
export function getIgnoreSet(root: string): IgnoreSet {
  const abs = resolvePath(root);
  let set = sets.get(abs);
  if (!set) {
    set = IgnoreSet.loadSync(abs);
    sets.set(abs, set);
  } else {
    set.refreshIfChanged();
  }
  reportSkippedLayers(set);
  return set;
}

function reportSkippedLayers(set: IgnoreSet): void {
  for (const e of set.errors()) {
    const key = `${e.file}|${e.mtimeMs ?? 'none'}`;
    if (auditedSkips.has(key)) continue;
    auditedSkips.add(key);
    if (auditHook) {
      try {
        auditHook(set.root, e.layer, e.message);
      } catch {
        // The audit hook must never break the gate.
      }
    }
  }
}

/** Sync verdict over the cached (hot-reloaded) set. */
export function ignoreVerdictSync(
  root: string,
  absPath: string,
  forIndex = false,
  isDir = false,
): IgnoreVerdict {
  return getIgnoreSet(root).verdict(absPath, forIndex, isDir);
}

/** The choke point: one boolean for every call site. */
export function isIgnoredSync(
  root: string,
  absPath: string,
  forIndex = false,
  isDir = false,
): boolean {
  return ignoreVerdictSync(root, absPath, forIndex, isDir).ignored;
}

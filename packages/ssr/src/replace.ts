/**
 * Deterministic replacement engine for SSR matches.
 *
 * Three ops, all pure text edits over the ORIGINAL line array:
 *  - rename:        scope-limited whole-word rename (definition + hits
 *                   inside the innermost enclosing body; `.name`
 *                   property accesses are skipped). NOT true scope
 *                   analysis — nested shadowing is renamed together;
 *                   the preview diff shows exactly what changes.
 *  - replaceRange:  splice the whole node range with template text
 *                   ($name / $kind substitutions).
 *  - addModifier:   insert a visibility/other modifier into a method's
 *                   definition line (no-op with reason when the method
 *                   already carries a visibility modifier or the op is
 *                   applied to a non-method).
 *
 * Edits apply bottom-up per file so earlier line numbers stay valid.
 * previewTemplate() renders a unified-style diff WITHOUT writing.
 */

import type { ApplyResult, FileEdit, SsrMatch, SsrTemplate, StructNode } from './types.js';
import { extractStructNodes } from './scanner.js';

export interface ResolvedMatch extends SsrMatch {
  node: StructNode;
  text: string;
  lines: string[];
}

/** Re-scan the match's file and re-resolve the node (guards stale matches). */
export function resolveMatch(file: string, text: string, m: SsrMatch): ResolvedMatch | null {
  const nodes = extractStructNodes(file, text);
  const node = nodes.find(
    (n) => n.kind === m.kind && n.name === m.name && n.startLine === m.startLine,
  );
  if (!node) return null;
  return { ...m, node, text, lines: text.split('\n') };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scope-limited rename. Scope = innermost enclosing node range, else the
 * node's own range. Whole-word hits not preceded by '.' are renamed.
 */
export function renameInScope(rm: ResolvedMatch, to: string): FileEdit | { skipped: string } {
  const { node, lines } = rm;
  if (!/^[A-Za-z_$][\w$]*$/.test(to)) return { skipped: 'invalid target identifier' };
  if (to === node.name) return { skipped: 'target equals current name' };

  // Innermost enclosing body.
  const all = extractStructNodes(rm.file, rm.text);
  let scopeStart = node.startLine;
  let scopeEnd = node.endLine;
  let best = -1;
  for (const n of all) {
    if (n === node) continue;
    if (n.startLine < node.startLine && n.endLine >= node.endLine && n.startLine > best) {
      best = n.startLine;
      scopeStart = n.startLine;
      scopeEnd = n.endLine;
    }
  }

  const re = new RegExp(`(?<!\\.)\\b${escapeRegExp(node.name)}\\b`, 'g');
  const newLines = [...lines];
  let count = 0;
  for (let li = scopeStart; li <= scopeEnd; li++) {
    const idx = li - 1;
    const replaced = newLines[idx].replace(re, to);
    if (replaced !== newLines[idx]) {
      count += (newLines[idx].match(re) || []).length;
      newLines[idx] = replaced;
    }
  }
  if (count === 0) return { skipped: 'no occurrences found in scope' };
  return {
    file: rm.file,
    startLine: scopeStart,
    endLine: scopeEnd,
    newLines: newLines.slice(scopeStart - 1, scopeEnd),
    summary: `rename ${node.name} -> ${to} (${count} occurrence${count === 1 ? '' : 's'} in scope lines ${scopeStart}-${scopeEnd})`,
  };
}

function applySubstitutions(text: string, m: SsrMatch): string {
  return text.replace(/\$name/g, m.name).replace(/\$kind/g, m.kind);
}

export function replaceRangeEdit(rm: ResolvedMatch, text: string): FileEdit {
  const newLines = applySubstitutions(text, rm).split('\n');
  return {
    file: rm.file,
    startLine: rm.node.startLine,
    endLine: rm.node.endLine,
    newLines,
    summary: `replace ${rm.node.kind} ${rm.node.name} (lines ${rm.node.startLine}-${rm.node.endLine})`,
  };
}

export function addModifierEdit(rm: ResolvedMatch, modifier: string): FileEdit | { skipped: string } {
  if (rm.node.kind !== 'method') return { skipped: 'addModifier only applies to methods' };
  const vis = ['public', 'private', 'protected'];
  if (vis.includes(modifier) && rm.node.modifiers.some((x) => vis.includes(x))) {
    return { skipped: `method already has visibility modifier (${rm.node.modifiers.join(',')})` };
  }
  if (rm.node.modifiers.includes(modifier)) return { skipped: `modifier ${modifier} already present` };
  const line = rm.lines[rm.node.startLine - 1];
  const indent = /^\s*/.exec(line)?.[0] ?? '';
  const rest = line.slice(indent.length);
  const edited = `${indent}${modifier} ${rest}`;
  return {
    file: rm.file,
    startLine: rm.node.startLine,
    endLine: rm.node.startLine,
    newLines: [edited],
    summary: `add modifier ${modifier} to method ${rm.node.name}`,
  };
}

/** Render a small unified-style diff for one file edit. */
export function renderDiff(file: string, lines: string[], edit: FileEdit): string {
  const ctx = 2;
  const from = Math.max(1, edit.startLine - ctx);
  const to = Math.min(lines.length, edit.endLine + ctx);
  const out: string[] = [`--- a/${file}`, `+++ b/${file}`, `@@ -${from},${to - from + 1} +${from},${edit.newLines.length + (to - from + 1) - (edit.endLine - edit.startLine + 1)} @@`];
  for (let li = from; li < edit.startLine; li++) out.push(` ${lines[li - 1]}`);
  for (let li = edit.startLine; li <= edit.endLine; li++) out.push(`-${lines[li - 1]}`);
  for (const nl of edit.newLines) out.push(`+${nl}`);
  for (let li = edit.endLine + 1; li <= to; li++) out.push(` ${lines[li - 1]}`);
  return out.join('\n');
}

/**
 * Compute edits for every match WITHOUT writing. Returns per-file diffs.
 * Selection: when provided, only matches whose (file,startLine) are listed.
 */
export function previewEdits(
  files: Map<string, string>,
  matches: SsrMatch[],
  template: SsrTemplate,
  only?: Array<{ file: string; startLine: number }>,
): { edits: FileEdit[]; diffs: Record<string, string>; skipped: ApplyResult['skipped'] } {
  const edits: FileEdit[] = [];
  const skipped: ApplyResult['skipped'] = [];
  const sel = only ? new Set(only.map((o) => `${o.file}\0${o.startLine}`)) : null;
  for (const m of matches) {
    if (sel && !sel.has(`${m.file}\0${m.startLine}`)) continue;
    const text = files.get(m.file);
    if (text === undefined) {
      skipped.push({ file: m.file, startLine: m.startLine, reason: 'file not loaded' });
      continue;
    }
    const rm = resolveMatch(m.file, text, m);
    if (!rm) {
      skipped.push({ file: m.file, startLine: m.startLine, reason: 'match no longer resolves (file changed?)' });
      continue;
    }
    if (!template.replace) {
      skipped.push({ file: m.file, startLine: m.startLine, reason: 'template has no replace spec' });
      continue;
    }
    const op = template.replace;
    const edit =
      op.op === 'rename'
        ? renameInScope(rm, op.to)
        : op.op === 'replaceRange'
          ? replaceRangeEdit(rm, op.text)
          : addModifierEdit(rm, op.modifier);
    if ('skipped' in edit) {
      skipped.push({ file: m.file, startLine: m.startLine, reason: edit.skipped });
      continue;
    }
    edits.push(edit);
  }
  // Render diffs per file (against original text).
  const diffs: Record<string, string> = {};
  const byFile = new Map<string, FileEdit[]>();
  for (const e of edits) {
    const arr = byFile.get(e.file) ?? [];
    arr.push(e);
    byFile.set(e.file, arr);
  }
  for (const [file, arr] of byFile) {
    const lines = files.get(file)!.split('\n');
    diffs[file] = arr.map((e) => renderDiff(file, lines, e)).join('\n');
  }
  return { edits, diffs, skipped };
}

/**
 * Apply edits bottom-up per file and return the new file contents.
 * Pure: does not touch the filesystem (the route layer writes + audits).
 */
export function applyEdits(files: Map<string, string>, edits: FileEdit[]): Map<string, string> {
  const out = new Map(files);
  const byFile = new Map<string, FileEdit[]>();
  for (const e of edits) {
    const arr = byFile.get(e.file) ?? [];
    arr.push(e);
    byFile.set(e.file, arr);
  }
  for (const [file, arr] of byFile) {
    arr.sort((a, b) => b.startLine - a.startLine); // bottom-up
    let lines = out.get(file)!.split('\n');
    for (const e of arr) {
      lines = [...lines.slice(0, e.startLine - 1), ...e.newLines, ...lines.slice(e.endLine)];
    }
    out.set(file, lines.join('\n'));
  }
  return out;
}

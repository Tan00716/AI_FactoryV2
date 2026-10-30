/**
 * Three-way diff and apply for settings sections (R7-#10).
 *
 * Baseline semantics: the stored baseline is the sections state as of
 * the last successful apply on this machine. With a baseline:
 *   - incoming-only key, absent from baseline  -> "added"
 *   - incoming-only key, present in baseline   -> "conflict" (deleted
 *     locally, changed remotely — restoring needs a decision)
 *   - key in both, incoming != current, current == baseline
 *     -> "modified" (only the incoming side changed: safe to apply)
 *   - key in both, incoming != current, incoming == baseline
 *     -> no entry (only the local side changed: keep local)
 *   - key in both, both differ from baseline and from each other
 *     -> "conflict"
 *   - current-only key, absent from baseline   -> no entry (added
 *     locally after the baseline; the incoming side never had it)
 *   - current-only key, present in baseline, current == baseline
 *     -> "removed" (deleted remotely: needs a decision)
 *   - current-only key, present in baseline, current != baseline
 *     -> "conflict" (changed locally, deleted remotely)
 * Without a baseline (never applied before), differing keys are
 * "modified", not conflicts: there is no evidence of a concurrent
 * change, so the first import wins on apply. This is documented in
 * the README and surfaced in the preview summary (baseline: false).
 *
 * Sections absent from the incoming document are never diffed and
 * never written: apply only touches the document's sections, so a
 * partial import cannot delete unrelated local settings.
 *
 * Apply is all-or-nothing at the validation step: added/modified
 * entries apply automatically; conflict/removed entries apply only
 * with an explicit per-key resolution, and any unresolved one aborts
 * the whole apply before anything is written.
 */
import { jsonEqual } from './doc.js';
import type {
  ApplyResult,
  DiffEntry,
  Resolutions,
  Sections,
  SectionValue,
} from './types.js';

function has(obj: SectionValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function diffSections(
  incoming: Sections,
  current: Sections,
  base: Sections | null,
): DiffEntry[] {
  const entries: DiffEntry[] = [];
  // Only sections present in the incoming document are diffed: a
  // section absent from the document is untouched by apply, so it
  // must not produce added/modified/conflict/removed entries either.
  const sectionNames = Object.keys(incoming);
  for (const section of [...sectionNames].sort()) {
    const inc: SectionValue = incoming[section] ?? {};
    const cur: SectionValue = current[section] ?? {};
    const bas: SectionValue | null = base ? (base[section] ?? {}) : null;
    const keys = new Set([...Object.keys(inc), ...Object.keys(cur)]);
    for (const key of [...keys].sort()) {
      const inInc = has(inc, key);
      const inCur = has(cur, key);
      const inBase = bas !== null && has(bas, key);
      const incV = inInc ? inc[key] : null;
      const curV = inCur ? cur[key] : null;
      const baseV = inBase ? bas![key] : null;
      if (inInc && inCur) {
        if (jsonEqual(incV, curV)) continue;
        if (bas === null) {
          entries.push({ section, key, kind: 'modified', currentValue: curV, incomingValue: incV, baseValue: null });
        } else if (jsonEqual(curV, baseV)) {
          entries.push({ section, key, kind: 'modified', currentValue: curV, incomingValue: incV, baseValue: baseV });
        } else if (jsonEqual(incV, baseV)) {
          continue; // local-only change: keep local, no entry
        } else {
          entries.push({ section, key, kind: 'conflict', currentValue: curV, incomingValue: incV, baseValue: baseV });
        }
      } else if (inInc && !inCur) {
        if (bas === null || !inBase) {
          entries.push({ section, key, kind: 'added', currentValue: null, incomingValue: incV, baseValue: baseV });
        } else {
          entries.push({ section, key, kind: 'conflict', currentValue: null, incomingValue: incV, baseValue: baseV });
        }
      } else if (!inInc && inCur) {
        if (bas === null || !inBase) continue; // added locally: keep
        if (jsonEqual(curV, baseV)) {
          entries.push({ section, key, kind: 'removed', currentValue: curV, incomingValue: null, baseValue: baseV });
        } else {
          entries.push({ section, key, kind: 'conflict', currentValue: curV, incomingValue: null, baseValue: baseV });
        }
      }
    }
  }
  return entries;
}

export function diffSummary(entries: DiffEntry[]): Record<string, number> {
  const summary: Record<string, number> = { added: 0, modified: 0, conflict: 0, removed: 0 };
  for (const e of entries) summary[e.kind] = (summary[e.kind] ?? 0) + 1;
  return summary;
}

/**
 * Compute the next sections state. Throws listing every unresolved
 * conflict/removed key; the caller must not write anything then.
 * Resolution keys are "section:key". For a "removed" entry,
 * 'incoming' means delete the local key; for a "conflict" entry,
 * 'incoming' means take the incoming value. 'keep' keeps local in
 * both cases.
 */
export function applySections(
  incoming: Sections,
  current: Sections,
  base: Sections | null,
  resolutions: Resolutions = {},
): ApplyResult {
  const entries = diffSections(incoming, current, base);
  const unresolved = entries.filter(
    (e) => (e.kind === 'conflict' || e.kind === 'removed') && resolutions[`${e.section}:${e.key}`] === undefined,
  );
  if (unresolved.length > 0) {
    throw new Error(
      `unresolved entries: ${unresolved.map((e) => `${e.section}:${e.key} (${e.kind})`).join(', ')}`,
    );
  }
  const next: Sections = {};
  for (const [section, sec] of Object.entries(current)) next[section] = { ...sec };
  const applied: string[] = [];
  const kept: string[] = [];
  for (const e of entries) {
    const id = `${e.section}:${e.key}`;
    if (e.kind === 'added' || e.kind === 'modified') {
      if (!next[e.section]) next[e.section] = {};
      next[e.section][e.key] = e.incomingValue;
      applied.push(id);
    } else {
      const r = resolutions[id];
      if (r === 'incoming') {
        if (e.incomingValue === null) {
          if (next[e.section]) delete next[e.section][e.key];
        } else {
          if (!next[e.section]) next[e.section] = {};
          next[e.section][e.key] = e.incomingValue;
        }
        applied.push(id);
      } else {
        kept.push(id);
      }
    }
  }
  return { next, applied, kept };
}

/**
 * Effective-view merge (round-6 R6-A6). Pure function over the two managed
 * levels plus compat files.
 *
 * Order: global managed rules (by order) form the base; each project rule
 * replaces a same-named global rule IN PLACE (stable position, project
 * content wins) or appends when the name is new. Compat files append last
 * in fixed order (AGENTS.md, .cursorrules, .clinerules) as read-only
 * entries. The losing global rule is NOT in the effective list — it stays
 * visible in the level list with overriddenBy set, so the override is
 * labelled, never silent.
 *
 * Disabled rules remain in the effective list with enabled=false; the
 * caller (panel) greys them. This function does not filter them out,
 * because a vanished rule reads as a bug to the operator.
 */
import type { CompatFile, EffectiveRule, ManagedRule } from './types.js';
import { sameName, sortRules } from './validate.js';

export function mergeEffective(
  globalRules: ManagedRule[],
  projectRules: ManagedRule[],
  compat: CompatFile[],
): EffectiveRule[] {
  const effective: EffectiveRule[] = sortRules(globalRules).map((r) => ({
    name: r.name,
    content: r.content,
    enabled: r.enabled,
    scope: 'global' as const,
    source: 'managed' as const,
    id: r.id,
    readOnly: false,
    overrides: [],
    overriddenBy: null,
  }));
  for (const p of sortRules(projectRules)) {
    const idx = effective.findIndex((e) => e.source === 'managed' && sameName(e.name, p.name));
    const entry: EffectiveRule = {
      name: p.name,
      content: p.content,
      enabled: p.enabled,
      scope: 'project',
      source: 'managed',
      id: p.id,
      readOnly: false,
      overrides: [],
      overriddenBy: null,
    };
    if (idx >= 0) {
      entry.overrides = [effective[idx].id];
      effective[idx] = entry;
    } else {
      effective.push(entry);
    }
  }
  for (const c of compat) {
    effective.push({
      name: c.file,
      content: c.content,
      enabled: true,
      scope: 'project',
      source: c.source,
      id: '',
      readOnly: true,
      overrides: [],
      overriddenBy: null,
    });
  }
  return effective;
}

/** Annotate one level's rules with overriddenBy when a project rule wins. */
export function annotateOverridden(
  globalRules: ManagedRule[],
  projectRules: ManagedRule[],
): (ManagedRule & { overriddenBy: string | null })[] {
  return sortRules(globalRules).map((g) => {
    const winner = projectRules.find((p) => sameName(p.name, g.name));
    return { ...g, overriddenBy: winner ? winner.id : null };
  });
}

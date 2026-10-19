/**
 * Declarative allow/ask/deny tool rules — Claude Code-style permission rules.
 *
 * A rule names a tool (exact name or glob, e.g. 'Bash', 'shell.execute',
 * 'mcp__*') and a glob pattern over that tool's *target string* (the
 * command line for shell tools, the path for file tools, ...), with one
 * of three effects:
 *
 *   allow — the call proceeds without asking;
 *   ask   — the call must go through the approval path;
 *   deny  — the call is refused outright.
 *
 * Evaluation order is fixed: **deny > ask > allow**. Among all rules
 * whose tool glob matches the invoked tool (or one of its aliases) AND
 * whose pattern glob matches the target string, a deny always wins over
 * an ask, which always wins over an allow. No matching rule → no
 * opinion (undefined) — the caller falls through to its default policy
 * (e.g. the read/write/exec/admin tier baseline).
 *
 * Layers (project → personal → global) merge by override: a rule with
 * an identical (tool, pattern) pair in a later layer REPLACES the
 * earlier one, but a deny in ANY layer still beats an allow in a later
 * layer — deny always wins.
 *
 * Glob semantics (standard, minimatch-like):
 *   *   matches any run of characters EXCEPT '/'  (one path segment)
 *   **  matches any run of characters INCLUDING '/' (any depth);
 *       a '**' followed by '/' also matches zero segments,
 *       so a 'src' + '/**' + '/*.ts' style pattern hits 'src/a.ts'
 *   ?   matches exactly one character except '/'
 *
 * Honest boundary: this is STRING matching, not semantic understanding.
 * `Bash(rm -rf *)` does not match `rm -rf /tmp/x` (the `*` does not cross
 * '/') — use `**` for cross-segment patterns. A rule like `Bash(*)` +
 * pattern `*` matches every shell command; the validator warns about
 * such match-everything rules but does not forbid them.
 *
 * Pure deterministic logic — zero model involvement.
 */
import type { PermissionRule, RuleEffect } from './types.js';

export const RULE_EFFECTS: readonly RuleEffect[] = ['allow', 'ask', 'deny'];

/** A named rule layer (project / personal / global), in merge order. */
export interface RuleLayer {
  name: string;
  rules: PermissionRule[];
}

/** The winning rule for one tool call, if any rule matched. */
export interface RuleVerdict {
  effect: RuleEffect;
  rule: PermissionRule;
  /** Name of the layer the winning rule came from. */
  layer: string;
}

function escapeRegExpChar(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/, '\\$&');
}

/**
 * Compile a glob to a RegExp. `*` → `[^/]*`, `**` → `.*`,
 * `**\/` → `(?:.*\/)?` (zero or more segments), `?` → `[^/]`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' matches zero or more whole segments.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += escapeRegExpChar(c);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when `target` matches `glob` (full-string match). */
export function globMatch(glob: string, target: string): boolean {
  return globToRegExp(glob).test(target);
}

/** Validate one operator-supplied rule. Warnings are non-fatal. */
export function validateRule(input: unknown): {
  ok: true;
  rule: PermissionRule;
  warnings: string[];
} | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'rule must be an object {tool, pattern, effect}' };
  }
  const r = input as Record<string, unknown>;
  if (typeof r['tool'] !== 'string' || (r['tool'] as string).length === 0) {
    return { ok: false, error: "'tool' must be a non-empty string" };
  }
  if (typeof r['pattern'] !== 'string' || (r['pattern'] as string).length === 0) {
    return { ok: false, error: "'pattern' must be a non-empty string" };
  }
  if (typeof r['effect'] !== 'string' || !(RULE_EFFECTS as readonly string[]).includes(r['effect'] as string)) {
    return { ok: false, error: `'effect' must be one of: ${RULE_EFFECTS.join(', ')}` };
  }
  const rule: PermissionRule = {
    tool: r['tool'] as string,
    pattern: r['pattern'] as string,
    effect: r['effect'] as RuleEffect,
  };
  const warnings: string[] = [];
  if (rule.tool === '*' && (rule.pattern === '*' || rule.pattern === '**')) {
    warnings.push(
      `rule '${rule.tool}(${rule.pattern})' matches EVERY tool call — ` +
        'this is almost certainly broader than intended',
    );
  }
  if (rule.effect === 'deny' && rule.pattern.includes('*') === false && rule.pattern.includes('?') === false) {
    // An exact-string deny is fine, but remind the author it is exact.
    warnings.push(
      `deny rule '${rule.tool}(${rule.pattern})' is an exact string match — ` +
        'consider wildcards (e.g. trailing *) if variants should also be denied',
    );
  }
  return { ok: true, rule, warnings };
}

/** Validate a whole rule list (the shape stored per layer). */
export function validateRuleList(input: unknown): {
  ok: true;
  rules: PermissionRule[];
  warnings: string[];
} | { ok: false; error: string } {
  const list = Array.isArray(input) ? input : (input as { rules?: unknown })?.rules;
  if (!Array.isArray(list)) {
    return { ok: false, error: 'rules must be an array of {tool, pattern, effect}' };
  }
  const rules: PermissionRule[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const v = validateRule(list[i]);
    if (!v.ok) return { ok: false, error: `rules[${i}]: ${v.error}` };
    rules.push(v.rule);
    for (const w of v.warnings) warnings.push(`rules[${i}]: ${w}`);
  }
  return { ok: true, rules, warnings };
}

/**
 * Merge layers in order: a later layer's rule with an identical
 * (tool, pattern) pair REPLACES the earlier one. Returns the merged
 * list with each rule tagged by its surviving layer name.
 */
export function mergeRuleLayers(layers: RuleLayer[]): { rule: PermissionRule; layer: string }[] {
  const merged: { rule: PermissionRule; layer: string }[] = [];
  const index = new Map<string, number>();
  for (const { name, rules } of layers) {
    for (const rule of rules) {
      const key = `${rule.tool}\n${rule.pattern}`;
      const at = index.get(key);
      if (at === undefined) {
        index.set(key, merged.length);
        merged.push({ rule, layer: name });
      } else {
        merged[at] = { rule, layer: name };
      }
    }
  }
  return merged;
}

const EFFECT_RANK: Record<RuleEffect, number> = { deny: 3, ask: 2, allow: 1 };

/**
 * Evaluate one tool call against merged layers.
 *
 * A rule matches when its tool glob matches the invoked tool id OR any
 * of the tool's aliases, AND its pattern glob matches the target string.
 * Fixed order: deny > ask > allow. Ties within one effect resolve to the
 * first matching rule in merged order (deterministic).
 *
 * Returns undefined when no rule matches — the caller keeps its default
 * policy. Pure function, no I/O.
 */
export function evaluateRules(
  layers: RuleLayer[],
  tool: string,
  toolAliases: readonly string[],
  target: string,
): RuleVerdict | undefined {
  const merged = mergeRuleLayers(layers);
  let best: { rule: PermissionRule; layer: string } | undefined;
  for (const m of merged) {
    const toolHit =
      globMatch(m.rule.tool, tool) || toolAliases.some((a) => globMatch(m.rule.tool, a));
    if (!toolHit) continue;
    if (!globMatch(m.rule.pattern, target)) continue;
    if (best === undefined || EFFECT_RANK[m.rule.effect] > EFFECT_RANK[best.rule.effect]) {
      best = m;
    }
  }
  return best === undefined
    ? undefined
    : { effect: best.rule.effect, rule: best.rule, layer: best.layer };
}

/**
 * Server-side declarative permission-rule store — three config layers.
 *
 * Layers, in merge order (later overrides earlier on identical
 * (tool, pattern), but a deny in ANY layer always beats allow/ask):
 *   1. project  <cwd>/.ai-factory/permissions.json        (team-shared, committed)
 *   2. personal <cwd>/.ai-factory/permissions.local.json (gitignored)
 *   3. global   ~/.config/ai-factory/permissions.json    (this machine's user)
 *
 * Overrides for hermetic tests:
 *   FACTORY_PERMISSION_RULES_ROOT   — replaces <cwd> for layers 1+2
 *   FACTORY_PERMISSION_RULES_GLOBAL — replaces the global file path
 *
 * Persistence: JSON `{rules: [...]}` per layer, atomic write (tmp +
 * rename). Hot reload: each layer is re-read when its file mtime
 * changes, so rule edits take effect without a server restart.
 *
 * Corrupt layer → that layer is SKIPPED (treated as empty) and reported
 * in `corruptLayers`; the failure is fail-open for the layer but loud in
 * the GET response and the server log, never a silent rule drop. (Bricking
 * the whole tool surface on a typo'd JSON file would be worse than
 * skipping one layer; deny rules are opt-in hardening.)
 *
 * Enforcement entry: checkToolRules(toolId, args) → RuleVerdict |
 * undefined. Tool aliases map catalog ids to the Claude Code-style names
 * operators write rules against (shell.execute ↔ Bash).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  evaluateRules,
  validateRuleList,
  type PermissionRule,
  type RuleEffect,
  type RuleLayer,
  type RuleVerdict,
} from '@ai-factory/permissions';

export type RuleLayerName = 'project' | 'personal' | 'global';
export const RULE_LAYER_NAMES: readonly RuleLayerName[] = ['project', 'personal', 'global'];

/** Catalog tool id → operator-facing aliases for rule matching. */
export const TOOL_RULE_ALIASES: Record<string, string[]> = {
  'shell.execute': ['Bash'],
};

/** The target string a rule pattern matches against, per tool. */
export function ruleTargetFor(toolId: string, args: Record<string, unknown>): string {
  if (toolId === 'shell.execute') {
    return typeof args['command'] === 'string' ? (args['command'] as string) : '';
  }
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return '';
  }
}

export function ruleLayerPaths(root?: string): Record<RuleLayerName, string> {
  const base = resolve(root ?? process.env['FACTORY_PERMISSION_RULES_ROOT'] ?? process.cwd());
  const globalFile =
    process.env['FACTORY_PERMISSION_RULES_GLOBAL'] ??
    join(homedir(), '.config', 'ai-factory', 'permissions.json');
  return {
    project: join(base, '.ai-factory', 'permissions.json'),
    personal: join(base, '.ai-factory', 'permissions.local.json'),
    global: globalFile,
  };
}

interface LayerState {
  rules: PermissionRule[];
  mtimeMs: number;
  corrupt: boolean;
}

export interface LayerView {
  name: RuleLayerName;
  path: string;
  rules: PermissionRule[];
  corrupt: boolean;
}

export class PermissionRuleStore {
  private cache = new Map<string, LayerState>();
  private paths = ruleLayerPaths();

  /** Re-resolve paths (tests point the store at temp dirs via env). */
  refreshPaths(): void {
    this.paths = ruleLayerPaths();
    this.cache.clear();
  }

  private loadLayer(name: RuleLayerName): LayerState {
    const path = this.paths[name];
    let mtimeMs = -1;
    try {
      if (!existsSync(path)) {
        const cached: LayerState = { rules: [], mtimeMs: -1, corrupt: false };
        this.cache.set(path, cached);
        return cached;
      }
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return { rules: [], mtimeMs: -1, corrupt: true };
    }
    const hit = this.cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit;
    let state: LayerState;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const v = validateRuleList(parsed);
      if (!v.ok) {
        console.warn(`[ai-factory] permission rules layer '${name}' invalid: ${v.error} — layer skipped`);
        state = { rules: [], mtimeMs, corrupt: true };
      } else {
        if (v.warnings.length > 0) {
          for (const w of v.warnings) console.warn(`[ai-factory] permission rules layer '${name}': ${w}`);
        }
        state = { rules: v.rules, mtimeMs, corrupt: false };
      }
    } catch (err) {
      console.warn(
        `[ai-factory] permission rules layer '${name}' unreadable (${(err as Error).message}) — layer skipped`,
      );
      state = { rules: [], mtimeMs, corrupt: true };
    }
    this.cache.set(path, state);
    return state;
  }

  /** Per-layer view for the UI (paths included so operators know where each rule lives). */
  layers(): LayerView[] {
    return RULE_LAYER_NAMES.map((name) => {
      const s = this.loadLayer(name);
      return { name, path: this.paths[name] as string, rules: [...s.rules], corrupt: s.corrupt };
    });
  }

  /** Layers in merge order, for evaluateRules. */
  private asRuleLayers(): RuleLayer[] {
    return RULE_LAYER_NAMES.map((name) => ({ name, rules: this.loadLayer(name).rules }));
  }

  /** Evaluate one tool call. No matching rule → undefined (default policy applies). */
  evaluate(toolId: string, args: Record<string, unknown>): RuleVerdict | undefined {
    const aliases = TOOL_RULE_ALIASES[toolId] ?? [];
    return evaluateRules(this.asRuleLayers(), toolId, aliases, ruleTargetFor(toolId, args));
  }

  /**
   * Evaluate a raw (tool, target) pair — for the evaluate endpoint's
   * dry-run, where the caller supplies the target string directly
   * instead of tool args.
   */
  evaluateRaw(tool: string, target: string): RuleVerdict | undefined {
    const aliases = TOOL_RULE_ALIASES[tool] ?? [];
    return evaluateRules(this.asRuleLayers(), tool, aliases, target);
  }

  /** Replace a whole layer's rules (PUT). Atomic write; throws on validation failure. */
  saveLayer(name: RuleLayerName, rules: unknown): { saved: number; warnings: string[] } {
    const v = validateRuleList(rules);
    if (!v.ok) throw new Error(v.error);
    const path = this.paths[name] as string;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ rules: v.rules }, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
    this.cache.delete(path);
    return { saved: v.rules.length, warnings: v.warnings };
  }
}

let singleton: PermissionRuleStore | undefined;

/** Process-wide store (hot-reloads on mtime change). */
export function permissionRules(): PermissionRuleStore {
  if (!singleton) singleton = new PermissionRuleStore();
  return singleton;
}

/** Tests: drop the singleton so env overrides take effect. */
export function resetPermissionRulesForTests(): void {
  singleton = undefined;
}

/**
 * Enforcement entry for the tool-runner choke point.
 * Pure delegation to the singleton — no I/O beyond the mtime-checked cache.
 */
export function checkToolRules(
  toolId: string,
  args: Record<string, unknown>,
): RuleVerdict | undefined {
  return permissionRules().evaluate(toolId, args);
}

export type { PermissionRule, RuleEffect, RuleLayer, RuleVerdict };

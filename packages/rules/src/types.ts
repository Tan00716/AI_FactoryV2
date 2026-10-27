/**
 * Tiered rule files (round-6 R6-A6) — shared types and limits.
 *
 * Two managed levels:
 *   - 'global':  ~/.ai-factory/rules/rules.json (operator-wide defaults)
 *   - 'project': <root>/.ai-factory/rules.json (per-project overrides)
 *
 * Three compat sources are READ-ONLY: AGENTS.md, .cursorrules, .clinerules
 * found at the project root. They are surfaced in the effective view with
 * their source labelled, but never edited through this API — editing them
 * here would risk destroying their free-form formatting, so v1 only reads
 * them. Managed rules are the editable layer; compat files are display-only.
 *
 * Merge semantics (see merge.ts): project rules override same-named global
 * rules; the override is labelled, never silent. Disabled rules stay in the
 * effective list with enabled=false (greyed in the UI) rather than vanishing.
 * No semantic validation of rule content is performed — the content is the
 * operator's prose, and this package deliberately does not judge it.
 */

export type RuleScope = 'global' | 'project';
export type RuleSource = 'managed' | 'agents' | 'cursorrules' | 'clinerules';

export interface ManagedRule {
  id: string;
  name: string;
  scope: RuleScope;
  content: string;
  enabled: boolean;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface CompatFile {
  /** 'agents' | 'cursorrules' | 'clinerules' */
  source: Exclude<RuleSource, 'managed'>;
  /** File name as found at the project root, e.g. 'AGENTS.md'. */
  file: string;
  content: string;
  /** Byte size of the file on disk, for the UI's truncation note. */
  sizeBytes: number;
  /** True when the file exceeded MAX_COMPAT_BYTES and content is truncated. */
  truncated: boolean;
}

export interface EffectiveRule {
  name: string;
  content: string;
  enabled: boolean;
  /** Which level/file this entry came from. */
  scope: RuleScope;
  source: RuleSource;
  /** Id of the managed rule this entry is ('' for compat entries). */
  id: string;
  /** True for compat entries: shown but not editable through this API. */
  readOnly: boolean;
  /** Ids of same-named managed rules this entry overrides (project wins). */
  overrides: string[];
  /** Id of the rule that overrides this one, when this entry lost. */
  overriddenBy: string | null;
}

export interface LevelStore {
  version: 1;
  rules: ManagedRule[];
}

export const MAX_RULES_PER_LEVEL = 200;
export const MAX_RULE_NAME_LENGTH = 120;
export const MAX_RULE_CONTENT_BYTES = 64 * 1024;
export const MAX_STORE_BYTES = 2 * 1024 * 1024;
export const MAX_COMPAT_BYTES = 512 * 1024;
/** Compat files are looked up in this fixed order at the project root. */
export const COMPAT_FILES = [
  { source: 'agents', file: 'AGENTS.md' },
  { source: 'cursorrules', file: '.cursorrules' },
  { source: 'clinerules', file: '.clinerules' },
] as const;

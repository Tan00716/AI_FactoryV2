/**
 * Settings sync document model (R7-#10).
 *
 * A sync document is a versioned snapshot of named settings sections.
 * Every section value is a flat JSON object (key -> JSON value); the
 * route adapters wrap non-object stores into this shape (e.g. the
 * keybindings array file becomes { items: [...] }). Section values
 * are compared key by key, so a diff can name exactly which keys
 * were added, modified, conflicted, or removed.
 *
 * Sections in v1 (the route enforces this allowlist; unknown sections
 * in an import document are rejected, never silently dropped):
 *   - "keybindings": { items: [...] } — the user keybinding layer.
 *   - "rules-global": { version: 1, rules: [...] } — the global
 *     managed-rule store document, compared as a whole per key.
 *
 * Deliberately NOT synced, ever: secrets, .env files, API tokens,
 * extension code, project files. The document validator refuses any
 * payload whose serialized form matches a shared @ai-factory/security
 * secret pattern, at export and at import.
 */

/** A single section: a flat key -> JSON value map. */
export type SectionValue = Record<string, unknown>;

/** All sections in a document, keyed by section name. */
export type Sections = Record<string, SectionValue>;

export interface SyncDoc {
  format: 'ai-factory-settings-sync';
  version: 1;
  /** ISO timestamp of the export. Informational only: conflict logic
   * uses the stored baseline, never wall-clock ordering, so clock
   * skew between machines cannot silently pick a winner. */
  exportedAt: string;
  sections: Sections;
}

/** Diff kinds. "removed" is the fourth kind beyond the brief's three:
 * a key the incoming document no longer carries. Like a conflict it
 * needs an explicit resolution (delete it, or keep the local value);
 * it is never applied silently. */
export type DiffKind = 'added' | 'modified' | 'conflict' | 'removed';

export interface DiffEntry {
  section: string;
  key: string;
  kind: DiffKind;
  /** Value on this machine (null when the key is absent). */
  currentValue: unknown;
  /** Value in the incoming document (null when absent). */
  incomingValue: unknown;
  /** Value at the last applied baseline (null when absent / no baseline). */
  baseValue: unknown;
}

/** Per-key resolution for conflict/removed entries, keyed "section:key". */
export type Resolution = 'incoming' | 'keep';
export type Resolutions = Record<string, Resolution>;

export interface ApplyResult {
  /** Sections after applying (same shape as the current state). */
  next: Sections;
  /** "section:key" strings that were written. */
  applied: string[];
  /** "section:key" strings left at their local value by resolution. */
  kept: string[];
}

/** Remote configuration as served over HTTP: the URL only. The token
 * is never stored in this object, never in a sync document, never in
 * a response, and never in an audit record — it is resolved at
 * request time from FACTORY_SETTINGSYNC_TOKEN (or the file named by
 * FACTORY_SETTINGSYNC_TOKEN_FILE), the same pattern as webhooks. */
export interface RemoteConfig {
  url: string | null;
  /** True when a token resolves from the environment right now. */
  tokenConfigured: boolean;
}

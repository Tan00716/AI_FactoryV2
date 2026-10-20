/**
 * @ai-factory/ignores — two-tier ignore files for AI Factory.
 *
 * Gitignore-style matching + the two project-level layers
 * (`.ai-factory/ignore` hard exclusion, `.ai-factory/indexing-ignore`
 * indexing-only exclusion). Zero external dependencies.
 *
 * HONEST BOUNDARY: the gate only constrains the tool surfaces that
 * consult it (index, repo map, @-context providers, code search,
 * backups). It cannot stop the OS, another tool, or the operator's own
 * shell from reading a file — that is by design.
 */

export {
  evaluateIgnore,
  parseIgnoreLine,
  parseIgnoreText,
  type CompiledIgnorePattern,
} from './matcher.js';
export {
  DEFAULT_HARD_IGNORE_TEMPLATE,
  HARD_IGNORE_FILE,
  INDEXING_IGNORE_FILE,
  IgnoreSet,
  MAX_IGNORE_FILE_BYTES,
  MAX_IGNORE_LINES,
  type IgnoreLayerError,
  type IgnoreLayerName,
  type IgnoreLayerState,
  type IgnoreVerdict,
} from './ignore-set.js';

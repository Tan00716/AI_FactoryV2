/**
 * @ai-factory/repomap — deterministic repository map.
 *
 * Builds a structural summary of a repository: file → classes/functions
 * (with full signatures and line numbers), ranked by importance over a
 * heuristic reference graph — the same idea as Aider's tree-sitter repo
 * map, but with zero native dependencies.
 *
 * HONEST LIMITATIONS (documented, not hidden):
 *  - No tree-sitter, no parser. Symbol extraction is the heuristic
 *    regex pass from @ai-factory/codeindex: it misses metaprogramming,
 *    decorators-heavy code, macros, and dynamically built symbols.
 *  - The "reference graph" is name-based, not semantic: a reference is
 *    counted when a file's token set contains the symbol's name. Same-
 *    named symbols in different scopes are conflated; shadowed names
 *    produce false reference edges. This is a recall aid for agents,
 *    not a compiler frontend.
 *  - Languages: TS/JS, Python, Go, Rust get symbols + signatures (via
 *    codeindex). Every other file type gets a file-level entry only
 *    (path + size), no symbols.
 *  - Test-framework call sites (`test('…', …)`, `describe(`, `it(`) can be
 *    misread as method definitions by the heuristic extractor, which
 *    inflates test files' importance (the name `test` is referenced
 *    everywhere). Ranking stays deterministic; treat test-file scores
 *    with skepticism.
 *  - Token counts are estimates (chars/4), not a real tokenizer.
 *
 * Data flow: codeindex IndexData (reused, incremental via its
 * mtime+size watermarks) → reference counting → importance scoring →
 * budget-truncated render (repo-map.json machine-readable,
 * repo-map.md human-readable).
 */

export type {
  MapSymbol,
  MapFile,
  RepoMapData,
  RepoMapStats,
  BuildMapOptions,
} from './types.js';
export {
  buildRepoMap,
  renderMarkdown,
  DEFAULT_MAX_TOKENS,
  MAP_VERSION,
} from './map.js';
export { estimateTokens } from './tokens.js';
export { RepoMapService, RepoMapError, defaultMapCacheDir } from './service.js';

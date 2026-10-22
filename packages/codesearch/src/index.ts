/**
 * @ai-factory/codesearch — project-wide text search (index-free grep) and
 * the `.code-search` file format.
 */
export type {
  CodeSearchFileGroup,
  CodeSearchMatch,
  CodeSearchOptions,
  CodeSearchQuery,
  CodeSearchResult,
  CodeSearchStats,
  NormalizedCodeSearchQuery,
} from './types.js';
export { CodeSearchError } from './types.js';
export {
  DEFAULT_MAX_MATCHES,
  HARD_MAX_MATCHES,
  globToRegExp,
  grepProject,
  normalizeQuery,
} from './grep.js';
export {
  CODE_SEARCH_MAGIC,
  CODE_SEARCH_RESULTS_SEP,
  CODE_SEARCH_SNAPSHOT_NOTE,
  parseCodeSearchFile,
  serializeCodeSearchFile,
  type CodeSearchFileHeader,
  type ParsedCodeSearchFile,
} from './format.js';

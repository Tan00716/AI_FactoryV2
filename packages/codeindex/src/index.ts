/**
 * @ai-factory/codeindex — local code index for agents.
 *
 * Heuristic symbol extraction + inverted full-text index over a repo
 * root, with incremental rebuilds. Zero external dependencies.
 */

export type {
  CodeSymbol,
  FileRecord,
  IndexData,
  IndexStats,
  Posting,
  SearchHit,
  SymbolKind,
} from './types.js';
export {
  buildIndex,
  defaultCacheDir,
  indexFilePath,
  loadIndex,
  saveIndex,
  tokenize,
  INDEX_VERSION,
  MAX_POSTINGS_PER_TOKEN,
} from './indexer.js';
export { extractSymbols, supportedExtensions } from './extract.js';
export { walkRepo, MAX_FILE_BYTES, MAX_FILES } from './walker.js';
export {
  getDefinition,
  searchSymbols,
  searchText,
  withContext,
} from './query.js';
export type { QueryOptions } from './query.js';
export { CodeIndexService, CodeIndexError } from './service.js';

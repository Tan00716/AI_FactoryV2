/**
 * @ai-factory/search — pluggable web search for agents (W-E).
 *
 * Default: BingRssProvider (no key, works out of the box; personal /
 * non-commercial ToS caveat documented on the provider). Keyed
 * providers (Brave, Tavily) are preferred when API keys are configured —
 * pass them first in the provider list.
 */
export type {
  SearchOptions,
  SearchProvider,
  SearchResult,
} from './types';
export { SearchError, normalizeSearchOptions } from './types';
export {
  BingRssProvider,
  BraveProvider,
  TavilyProvider,
  cleanText,
  fetchText,
  parseBingRss,
  setFetchTextGuard,
  SEARCH_PROVIDER_BASE_URLS,
  SEARCH_PROVIDER_ENDPOINT_URLS,
  type FetchTextGuard,
} from './providers';
export {
  createSearchClient,
  createDefaultProviders,
  formatResultsForPrompt,
  validatedSearchOptions,
  type SearchClient,
  type SearchClientOptions,
  type SearchOutcome,
} from './client';

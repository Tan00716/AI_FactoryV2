/**
 * Web search types (W-E) — the Codex/Claude "web search" equivalent.
 *
 * Search results are untrusted external content: they must pass through
 * sanitizeUntrusted() (see client.formatResultsForPrompt) before ever
 * reaching a model prompt. Raw results are data for display, never
 * instructions.
 */

/** One search hit. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Which provider produced this hit (debugging/provenance). */
  source?: string;
}

export interface SearchOptions {
  /** Max results to return. Defaults to 5, capped at 20. */
  count?: number;
  /** Per-request timeout in ms. Defaults to 15000. */
  timeoutMs?: number;
  /** BCP-47 / market hint, e.g. 'en-US', 'zh-CN'. Optional. */
  lang?: string;
}

/**
 * Pluggable search provider. Implementations do exactly one thing:
 * turn a query into a result list. Key management, failover and
 * sanitization live in client.ts, not in providers.
 */
export interface SearchProvider {
  /** Stable provider id, e.g. 'bing-rss', 'brave', 'tavily'. */
  readonly name: string;
  /** True when the provider cannot run without an API key. */
  readonly requiresKey: boolean;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

/** Thrown when every configured provider fails. Plain Error on purpose:
 * it carries no FactoryError ENV_* code, so the server's env-error
 * HTTP boundary analysis (needs-human-irrecoverable-env-error-http)
 * is unaffected by the web_search tool. */
export class SearchError extends Error {
  readonly code = 'SEARCH_FAILED' as const;
  constructor(
    message: string,
    readonly providerErrors: ReadonlyArray<{ provider: string; error: string }>,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}

/** Normalize caller options (defaults + caps). */
export function normalizeSearchOptions(opts: SearchOptions = {}): Required<Pick<SearchOptions, 'count' | 'timeoutMs'>> & Pick<SearchOptions, 'lang'> {
  const count = Math.min(20, Math.max(1, Math.floor(opts.count ?? 5)));
  const timeoutMs = Math.min(60000, Math.max(1000, Math.floor(opts.timeoutMs ?? 15000)));
  return { count, timeoutMs, lang: opts.lang };
}

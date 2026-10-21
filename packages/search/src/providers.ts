/**
 * Search providers (W-E). Zero external dependencies — node:http/https only.
 *
 * Provider lineup:
 * - BingRssProvider ('bing-rss'): no key, works out of the box. Parses
 *   Bing's RSS results feed. HONEST BOUNDARY: Bing's feed carries a
 *   personal/non-commercial use notice; this default exists so search
 *   works with zero configuration, not as a licensed data pipeline.
 *   Configure a keyed provider for anything beyond personal use.
 * - BraveProvider ('brave'): Brave Search API, needs BRAVE_SEARCH_API_KEY
 *   (or the vault key `search.brave.key`). Proper API terms.
 * - TavilyProvider ('tavily'): Tavily Search API, needs TAVILY_API_KEY
 *   (or the vault key `search.tavily.key`).
 */
import * as http from 'node:http';
import * as https from 'node:https';
import type { SearchOptions, SearchProvider, SearchResult } from './types';
import { normalizeSearchOptions } from './types';

/** Max response body we'll buffer: 1 MiB. Search feeds are small. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Provider endpoint base URLs (second-round task ⑦, egress firewall).
 * The egress firewall pre-checks these at route boundaries with full
 * project/task layer context; the low-level fetchText guard (below)
 * enforces the global layer on every actual outbound call.
 */
export const SEARCH_PROVIDER_BASE_URLS = [
  'https://www.bing.com/search?format=rss',
  'https://api.search.brave.com/res/v1/web/search',
  'https://api.tavily.com/search',
];

/**
 * Provider name → endpoint base URL (same origin as the base URLs
 * above). Route boundaries pre-check only the providers that are
 * actually configured, so a deny for an unused provider cannot block
 * an otherwise-fine search.
 */
export const SEARCH_PROVIDER_ENDPOINT_URLS: Record<string, string> = {
  'bing-rss': 'https://www.bing.com/search?format=rss',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  tavily: 'https://api.tavily.com/search',
};

/**
 * Process-wide egress guard for fetchText. The server installs one via
 * setFetchTextGuard (see apps/server/src/egress.ts + index.ts wiring);
 * the guard may throw to refuse an outbound call (e.g. an
 * EGRESS_BLOCKED error). Default: none — standalone package behavior
 * is unchanged and the guard never affects non-server embedders.
 */
export type FetchTextGuard = (url: string) => void;
let fetchTextGuard: FetchTextGuard | null = null;

/** Install (or clear with null) the process-wide fetchText egress guard. */
export function setFetchTextGuard(fn: FetchTextGuard | null): void {
  fetchTextGuard = fn;
}

export interface FetchTextOptions {
  timeoutMs: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
}

/** Minimal GET/POST with timeout + size cap. Rejects on non-2xx. */
export function fetchText(url: string, opts: FetchTextOptions): Promise<string> {
  // Egress firewall (global layer): a throwing guard rejects this call
  // before any socket is opened. Runs before the Promise body so a
  // refused call never even constructs a request.
  if (fetchTextGuard) {
    try {
      fetchTextGuard(url);
    } catch (err) {
      return Promise.reject(err);
    }
  }
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const parsed = new URL(url);
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (url.startsWith('https:') ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method ?? 'GET',
        headers: {
          'user-agent': 'ai-factory-search/0.1.0 (+https://github.com/Tan00716/AI_FactoryV2)',
          accept: 'text/html,application/rss+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
          ...(opts.body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(opts.body) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status} from ${parsed.hostname}`));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (c: Buffer) => {
          bytes += c.length;
          if (bytes > MAX_BODY_BYTES) {
            req.destroy(new Error('response body exceeded 1 MiB cap'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`request timed out after ${opts.timeoutMs}ms`)));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Strip tags + decode the handful of entities feeds actually emit.
 * Entities are decoded FIRST: feeds often emit escaped markup like
 * &lt;strong&gt;, which must become <strong> before tag stripping or
 * the literal text survives. Only real-looking tags (</?letter…>)
 * are stripped, so a literal "5 < 10" survives. */
export function cleanText(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unredirectBing(url: string): string {
  // Bing RSS links are direct; the HTML form wraps them in /ck/a. Defensive only.
  return url;
}

/** Parse Bing RSS <item> blocks. Tolerant: skips malformed items. */
export function parseBingRss(xml: string, count: number): SearchResult[] {
  const out: SearchResult[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && out.length < count) {
    const item = m[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(item)?.[1];
    const link = /<link>([\s\S]*?)<\/link>/.exec(item)?.[1];
    const desc = /<description>([\s\S]*?)<\/description>/.exec(item)?.[1];
    if (!title || !link) continue;
    out.push({
      title: cleanText(title),
      url: unredirectBing(cleanText(link)),
      snippet: desc ? cleanText(desc) : '',
      source: 'bing-rss',
    });
  }
  return out;
}

export class BingRssProvider implements SearchProvider {
  readonly name = 'bing-rss';
  readonly requiresKey = false;

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const { count, timeoutMs } = normalizeSearchOptions(opts);
    if (!query.trim()) return [];
    const url =
      'https://www.bing.com/search?format=rss&q=' + encodeURIComponent(query.trim());
    const xml = await fetchText(url, { timeoutMs });
    return parseBingRss(xml, count);
  }
}

export interface KeyedProviderOptions {
  apiKey: string;
}

export class BraveProvider implements SearchProvider {
  readonly name = 'brave';
  readonly requiresKey = true;
  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('BraveProvider needs an API key');
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const { count, timeoutMs } = normalizeSearchOptions(opts);
    if (!query.trim()) return [];
    const url =
      'https://api.search.brave.com/res/v1/web/search?q=' +
      encodeURIComponent(query.trim()) +
      `&count=${count}` +
      (opts?.lang ? `&search_lang=${encodeURIComponent(opts.lang)}` : '');
    const body = await fetchText(url, {
      timeoutMs,
      headers: { 'X-Subscription-Token': this.apiKey, accept: 'application/json' },
    });
    const json = JSON.parse(body) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const results = json.web?.results ?? [];
    return results.slice(0, count).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
      source: 'brave',
    })).filter((r) => r.url);
  }
}

export class TavilyProvider implements SearchProvider {
  readonly name = 'tavily';
  readonly requiresKey = true;
  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('TavilyProvider needs an API key');
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const { count, timeoutMs } = normalizeSearchOptions(opts);
    if (!query.trim()) return [];
    const body = await fetchText('https://api.tavily.com/search', {
      timeoutMs,
      method: 'POST',
      body: JSON.stringify({
        api_key: this.apiKey,
        query: query.trim(),
        max_results: count,
        include_answer: false,
      }),
    });
    const json = JSON.parse(body) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (json.results ?? []).slice(0, count).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
      source: 'tavily',
    })).filter((r) => r.url);
  }
}

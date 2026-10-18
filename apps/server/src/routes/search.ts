/**
 * Web search route (W-E) — the agent-facing search endpoint.
 *
 *   POST /api/search   { query, count?, lang? } → { provider, results: [{title,url,snippet}] }
 *
 * Provider chain: keyed providers first (Brave, then Tavily) when their
 * keys resolve, Bing RSS (no key) as the always-available fallback.
 * Keys resolve from the vault (`search.brave.key`, `search.tavily.key`)
 * with env fallback (BRAVE_SEARCH_API_KEY, TAVILY_API_KEY); vault wins
 * when both exist. Keys are never logged or returned.
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) already maps
 * POST → operator for this prefix — searching calls external services,
 * so operator-only is the right floor. No auth.ts change.
 *
 * Results are untrusted external content: this endpoint returns them
 * raw for display; anything embedding them in a model prompt must use
 * formatResultsForPrompt() (sanitizeUntrusted quarantine).
 *
 * The coordinator wires this in: handleSearchRoutes(req, res, url, ctx).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import {
  BingRssProvider,
  BraveProvider,
  TavilyProvider,
  createSearchClient,
  type SearchProvider,
} from '@ai-factory/search';

const PREFIX = '/api/search';

/** Resolve a provider API key: vault first, env fallback. Never throws. */
async function resolveSearchKey(
  ctx: RouteContext | undefined,
  vaultName: string,
  envName: string,
): Promise<string | null> {
  if (ctx?.secretBroker) {
    try {
      const v = await ctx.secretBroker.resolve(vaultName, {
        actor: 'server:search',
        purpose: 'web search provider key',
      });
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch {
      // Not in vault — fall through to env.
    }
  }
  const env = process.env[envName];
  return env && env.trim() ? env.trim() : null;
}

/** Build the provider chain (keyed first, RSS last). ctx is optional:
 * without it (e.g. the HTTP-run web_search tool) keys resolve from env
 * only; the /api/search route passes ctx so vault keys apply too. */
export async function buildSearchProviders(ctx?: RouteContext): Promise<SearchProvider[]> {
  const providers: SearchProvider[] = [];
  const braveKey = await resolveSearchKey(ctx, 'search.brave.key', 'BRAVE_SEARCH_API_KEY');
  if (braveKey) providers.push(new BraveProvider(braveKey));
  const tavilyKey = await resolveSearchKey(ctx, 'search.tavily.key', 'TAVILY_API_KEY');
  if (tavilyKey) providers.push(new TavilyProvider(tavilyKey));
  providers.push(new BingRssProvider());
  return providers;
}

export async function handleSearchRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // POST /api/search — run a web search.
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const query = body['query'];
    if (typeof query !== 'string' || !query.trim()) {
      ctx.json(res, 400, { error: 'query is required' });
      return true;
    }
    const count = typeof body['count'] === 'number' ? body['count'] : undefined;
    const lang = typeof body['lang'] === 'string' ? body['lang'] : undefined;
    const client = createSearchClient({ providers: await buildSearchProviders(ctx) });
    try {
      const outcome = await client.search(query, { count, lang });
      ctx.audit.record('server', 'SEARCH', 'web_search', query.slice(0, 80), {
        provider: outcome.provider,
        resultCount: outcome.results.length,
      });
      ctx.json(res, 200, { provider: outcome.provider, results: outcome.results });
    } catch (err) {
      ctx.json(res, 502, {
        error: 'search failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  // GET /api/search/providers — which providers are configured (no keys exposed).
  if (method === 'GET' && path === `${PREFIX}/providers`) {
    const providers = await buildSearchProviders(ctx);
    ctx.json(res, 200, {
      providers: providers.map((p) => ({ name: p.name, requiresKey: p.requiresKey })),
    });
    return true;
  }

  return false;
}

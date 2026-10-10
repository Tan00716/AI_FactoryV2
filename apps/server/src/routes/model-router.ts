/**
 * Model Router routes — spec §28–§30.
 *
 *  POST /api/router/route   {taskType, complexity, requiredTools?, latencyPref?,
 *                            costPref?, privacy?, needsReasoning?, contextNeeded?,
 *                            needsVision?, currentUsage?} → RouteDecision
 *  GET  /api/router/catalog → model catalog
 *  GET  /api/router/account  → provider profile + plan usage status
 *  GET  /api/models          → §90 Model Registry rows: provider, model,
 *                              capability, context, reasoning, cost, latency,
 *                              availability, fallback
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleModelRouterRoutes } from './routes/model-router';
 *   if (await handleModelRouterRoutes(req, res, url, ctx)) return;
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { MODEL_CATALOG, getAccountStatus, registryRows, route } from '@ai-factory/model-router';
import type { RouteContext } from './context';

function bad(json: RouteContext['json'], res: ServerResponse, msg: string) {
  json(res, 400, { error: msg });
}

export async function handleModelRouterRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // §90 — Model Registry UI data.
  if (method === 'GET' && path === '/api/models') {
    return ctx.json(res, 200, { models: registryRows() }), true;
  }

  if (!path.startsWith('/api/router/')) return false;

  if (method === 'GET' && path === '/api/router/catalog') {
    return ctx.json(res, 200, { models: MODEL_CATALOG }), true;
  }

  if (method === 'GET' && path === '/api/router/account') {
    return ctx.json(res, 200, getAccountStatus()), true;
  }

  if (method === 'POST' && path === '/api/router/route') {
    const b = await ctx.readBody(req);
    const taskType = b['taskType'];
    const complexity = b['complexity'];
    if (
      typeof taskType !== 'string' ||
      typeof complexity !== 'number' ||
      complexity < 1 ||
      complexity > 5
    ) {
      bad(ctx.json, res, 'taskType (string) and complexity (1-5) are required');
      return true;
    }
    try {
      const decision = route({
        taskType: taskType as never,
        complexity: complexity as 1 | 2 | 3 | 4 | 5,
        requiredTools: Array.isArray(b['requiredTools'])
          ? (b['requiredTools'] as string[])
          : [],
        latencyPref: b['latencyPref'] === 'high' ? 'high' : 'low',
        costPref: b['costPref'] === 'high' ? 'high' : 'low',
        privacy:
          b['privacy'] === 'sensitive' || b['privacy'] === 'internal'
            ? b['privacy']
            : 'public',
        needsReasoning: b['needsReasoning'] === true,
        contextNeeded:
          b['contextNeeded'] === 'large' || b['contextNeeded'] === 'medium'
            ? b['contextNeeded']
            : 'small',
        needsVision: b['needsVision'] === true,
        currentUsage: {
          usedPct:
            typeof b['usedPct'] === 'number'
              ? (b['usedPct'] as number)
              : typeof (b['currentUsage'] as Record<string, unknown> | undefined)
                    ?.['usedPct'] === 'number'
                ? ((b['currentUsage'] as Record<string, unknown>)[
                    'usedPct'
                  ] as number)
                : 0,
        },
      });
      return ctx.json(res, 200, decision), true;
    } catch (e) {
      bad(ctx.json, res, e instanceof Error ? e.message : 'routing failed');
      return true;
    }
  }

  return false;
}

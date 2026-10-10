/**
 * Tool registry routes — SPEC v2 §33.
 *
 *   GET  /api/tools                        list registered tools (latest versions)
 *   POST /api/tools/register               register tool metadata
 *   GET  /api/tools/:id/versions           list versions
 *   POST /api/tools/execute                execute with execution-point capability check
 *   GET  /api/tools/attempts               unified execution audit log (incl. DENIED)
 *
 * The coordinator wires this in: handleToolRoutes(req, res, url, ctx).
 * NOTE: apps/server/src/index.ts is not touched by this module's author;
 * the coordinator must call this handler in the dispatch chain.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ToolExecutor,
  ToolRegistry,
  type ToolCall,
  type ToolPrincipal,
} from '@ai-factory/tools';
import type { RouteContext } from './context';

const PREFIX = '/api/tools';

// In-memory prototype singletons (consistent with other route modules here).
const registry = new ToolRegistry();
const executor = new ToolExecutor(registry, {
  runner: () => ({ exitCode: 0, stdout: '', stderr: '', note: 'prototype runner: no real execution' }),
});

export async function handleToolRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  if (method === 'GET' && path === PREFIX) {
    return ctx.json(res, 200, { tools: registry.list() }), true;
  }

  if (method === 'GET' && path === `${PREFIX}/attempts`) {
    return ctx.json(res, 200, { attempts: executor.attempts() }), true;
  }

  if (method === 'POST' && path === `${PREFIX}/register`) {
    const body = await ctx.readBody(req);
    try {
      registry.register(body as never);
      return ctx.json(res, 201, { registered: (body as { id: string }).id }), true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      const status = code === 'DUPLICATE_TOOL_VERSION' ? 409 : 400;
      return ctx.json(res, status, { error: (err as Error).message, code }), true;
    }
  }

  const versionsMatch = path.match(new RegExp(`^${PREFIX}/([^/]+)/versions$`));
  if (method === 'GET' && versionsMatch) {
    try {
      return ctx.json(res, 200, { versions: registry.listVersions(versionsMatch[1]) }), true;
    } catch {
      return ctx.json(res, 404, { error: 'tool not found' }), true;
    }
  }

  if (method === 'POST' && path === `${PREFIX}/execute`) {
    const body = await ctx.readBody(req);
    const toolId = body['toolId'];
    const action = body['action'];
    const resource = body['resource'];
    const principal = body['principal'] as ToolPrincipal | undefined;
    const capability = body['capability'] as ToolCall['capability'] | undefined;
    if (typeof toolId !== 'string' || typeof action !== 'string' || typeof resource !== 'string') {
      return ctx.json(res, 400, { error: 'toolId, action and resource are required' }), true;
    }
    if (!principal || !capability) {
      return ctx.json(res, 400, { error: 'principal and capability are required' }), true;
    }
    const record = await executor.execute({
      toolId,
      toolVersion: typeof body['toolVersion'] === 'string' ? (body['toolVersion'] as string) : undefined,
      args: (body['args'] as Record<string, unknown>) ?? {},
      action,
      resource,
      principal,
      capability,
      idempotencyKey: typeof body['idempotencyKey'] === 'string' ? (body['idempotencyKey'] as string) : undefined,
    });
    // DENIED is a valid outcome (audited); the record carries the reason.
    return ctx.json(res, 200, record), true;
  }

  return false;
}

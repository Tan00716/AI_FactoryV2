/**
 * Hook routes (W-B) — manage lifecycle hooks.
 *
 *   GET  /api/hooks                 list hooks
 *   POST /api/hooks                 create {event, tool?, command, timeoutMs?, description?}
 *   DELETE /api/hooks/:id          remove
 *   POST /api/hooks/:id/test       dry-run with a sample payload
 *   POST /api/hooks/evaluate       {event, tool, ...context} → run evaluation now
 *
 * PreToolUse hooks are enforced as a veto checkpoint in POST /api/exec;
 * PostToolUse hooks run after exec completes. This API manages the
 * registry; see ../hooks.ts for the deterministic executor.
 *
 * The coordinator wires this in: handleHookRoutes(req, res, url, ctx).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import {
  HOOK_EVENTS,
  createHook,
  deleteHook,
  evaluateHooks,
  loadHooks,
  runHook,
  type HookEvent,
} from '../hooks';

const PREFIX = '/api/hooks';

function isHookEvent(v: unknown): v is HookEvent {
  return v === 'PreToolUse' || v === 'PostToolUse' || v === 'Stop';
}

export async function handleHookRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/hooks — list.
  if (method === 'GET' && path === PREFIX) {
    try {
      ctx.json(res, 200, { hooks: loadHooks(), events: HOOK_EVENTS });
    } catch (e) {
      ctx.json(res, 500, { error: (e as Error).message });
    }
    return true;
  }

  // POST /api/hooks — create.
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req);
    try {
      const hook = createHook({
        event: body['event'],
        tool: body['tool'],
        command: body['command'],
        timeoutMs: body['timeoutMs'],
        description: body['description'],
        enabled: body['enabled'],
      });
      ctx.audit.record('human', 'HOOK_CREATED', 'hook', hook.id, {
        event: hook.event,
        tool: hook.tool ?? null,
      });
      ctx.json(res, 201, { hook });
    } catch (e) {
      ctx.json(res, 400, { error: (e as Error).message });
    }
    return true;
  }

  // POST /api/hooks/evaluate — run evaluation now (must precede :id matcher).
  if (method === 'POST' && path === `${PREFIX}/evaluate`) {
    const body = await ctx.readBody(req);
    const event = body['event'];
    const tool = body['tool'];
    if (!isHookEvent(event)) {
      ctx.json(res, 400, { error: `event must be one of ${HOOK_EVENTS.join('|')}` });
      return true;
    }
    if (typeof tool !== 'string' || !tool) {
      ctx.json(res, 400, { error: 'tool is required' });
      return true;
    }
    try {
      const { event: _e, tool: _t, ...rest } = body as Record<string, unknown>;
      const evaluation = await evaluateHooks(event, { tool, ...rest });
      ctx.json(res, 200, evaluation);
    } catch (e) {
      ctx.json(res, 500, { error: (e as Error).message });
    }
    return true;
  }

  const idMatch = path.match(new RegExp(`^${PREFIX}/([^/]+)(?:/(test))?$`));
  if (!idMatch) return false;
  const [, id, verb] = idMatch;

  // DELETE /api/hooks/:id
  if (method === 'DELETE' && !verb) {
    try {
      const removed = deleteHook(id);
      if (!removed) {
        ctx.json(res, 404, { error: `hook not found: ${id}` });
        return true;
      }
      ctx.audit.record('human', 'HOOK_DELETED', 'hook', id, {});
      ctx.json(res, 200, { ok: true });
      return true;
    } catch (e) {
      ctx.json(res, 500, { error: (e as Error).message });
      return true;
    }
  }

  // POST /api/hooks/:id/test — dry-run with a sample payload.
  if (method === 'POST' && verb === 'test') {
    try {
      const hooks = loadHooks();
      const hook = hooks.find((h) => h.id === id);
      if (!hook) {
        ctx.json(res, 404, { error: `hook not found: ${id}` });
        return true;
      }
      const run = await runHook(hook, {
        event: hook.event,
        tool: hook.tool ?? 'exec',
        dryRun: true,
        note: 'sample payload from POST /api/hooks/:id/test',
      });
      ctx.json(res, 200, { run });
      return true;
    } catch (e) {
      ctx.json(res, 500, { error: (e as Error).message });
      return true;
    }
  }

  return false;
}

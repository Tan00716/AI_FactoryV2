/**
 * Autonomy routes — spec §80–§81.
 *
 *  GET  /api/autonomy/mode?projectId=     current mode (default assisted)
 *  PUT  /api/autonomy/mode                {projectId, mode, updatedBy}
 *  POST /api/autonomy/decide               {action, mode?} → decision matrix
 *  POST /api/autonomy/verify-prod          {evidence} → §41 independent checklist
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  ProjectAutonomyStore,
  decide,
  verifyProdReadiness,
} from '@ai-factory/autonomy';
import type { RouteContext } from './context';

const store = new ProjectAutonomyStore();

export async function handleAutonomyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/autonomy/')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/autonomy/'.length).split('/').filter(Boolean);

  if (method === 'GET' && seg.length === 1 && seg[0] === 'mode') {
    const projectId = url.searchParams.get('projectId') ?? 'proj-myapp';
    ctx.json(res, 200, store.get(projectId));
    return true;
  }

  if (method === 'PUT' && seg.length === 1 && seg[0] === 'mode') {
    const body = await ctx.readBody(req);
    const projectId = body['projectId'] as string | undefined;
    const mode = body['mode'] as string | undefined;
    if (!projectId || !mode) {
      ctx.json(res, 400, { error: 'projectId and mode are required' });
      return true;
    }
    try {
      const record = store.set(projectId, mode, String(body['updatedBy'] ?? 'human'));
      ctx.audit.record(String(body['updatedBy'] ?? 'human'), 'AUTONOMY_MODE_SET', 'project', projectId, { mode });
      ctx.json(res, 200, record);
    } catch (e) {
      ctx.json(res, 400, { error: (e as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'decide') {
    const body = await ctx.readBody(req);
    const action = body['action'] as { kind?: string } | undefined;
    const mode = (body['mode'] as string | undefined) ?? 'assisted';
    if (!action || !action.kind) {
      ctx.json(res, 400, { error: 'action.kind is required' });
      return true;
    }
    try {
      ctx.json(res, 200, decide(action as never, mode as never));
    } catch (e) {
      ctx.json(res, 400, { error: (e as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'verify-prod') {
    const body = await ctx.readBody(req);
    const verdict = verifyProdReadiness((body['evidence'] as never) ?? {});
    ctx.audit.record('system', 'PROD_READINESS_CHECK', 'deployment', 'prod', {
      ready: verdict.ready,
      missing: verdict.missing,
    });
    ctx.json(res, verdict.ready ? 200 : 422, verdict);
    return true;
  }

  return false;
}

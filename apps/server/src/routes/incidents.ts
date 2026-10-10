/**
 * Incidents routes — SPEC v2 §42.
 *
 *  GET  /api/incidents                    list (optional ?status=)
 *  POST /api/incidents                    {title, severity, detectedBy, runbookId?} → create
 *  GET  /api/incidents/:id                one incident
 *  POST /api/incidents/:id/transitions    {to, actor, detail?}
 *  POST /api/incidents/:id/evidence       {ref, actor}
 *  POST /api/incidents/:id/resolution-basis {basis, actor}
 *  POST /api/incidents/:id/postmortem     {rootCause, followUp[], humanConfirmedBy?}
 *  POST /api/incidents/runbooks           register a runbook
 *
 * Installer pattern (the coordinator wires it into apps/server/src/index.ts):
 *   import { handleIncidentsRoutes } from './routes/incidents';
 *   if (await handleIncidentsRoutes(req, res, url, ctx)) return;
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  IncidentManager,
  IncidentStatus,
  Runbook,
} from '@ai-factory/incidents';
import type { RouteContext } from './context';

const manager = new IncidentManager();

function isStatus(s: string): s is IncidentStatus {
  return (
    ['DETECTED', 'TRIAGED', 'INVESTIGATING', 'MITIGATING', 'RECOVERING', 'RESOLVED', 'POSTMORTEM', 'CLOSED'] as string[]
  ).includes(s);
}

export async function handleIncidentsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/incidents')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/incidents'.length).split('/').filter(Boolean);

  try {
    // POST /api/incidents/runbooks
    if (method === 'POST' && seg.length === 1 && seg[0] === 'runbooks') {
      const body = await ctx.readBody(req);
      const rb = manager.registerRunbook(body as unknown as Runbook);
      ctx.json(res, 201, { runbook: rb });
      return true;
    }

    // POST /api/incidents  {title, severity, detectedBy, runbookId?}
    if (method === 'POST' && seg.length === 0) {
      const body = await ctx.readBody(req);
      const inc = manager.create({
        title: String(body.title ?? ''),
        severity: body.severity as 'P0' | 'P1' | 'P2' | 'P3',
        detectedBy: String(body.detectedBy ?? 'unknown'),
        runbookId: body.runbookId ? String(body.runbookId) : undefined,
      });
      ctx.json(res, 201, { incident: inc });
      return true;
    }

    // GET /api/incidents[?status=]
    if (method === 'GET' && seg.length === 0) {
      const status = url.searchParams.get('status');
      const list = status && isStatus(status) ? manager.list(status) : manager.list();
      ctx.json(res, 200, { incidents: list });
      return true;
    }

    const id = seg[0];
    if (!id || seg[0] === 'runbooks') return false;

    // GET /api/incidents/:id
    if (method === 'GET' && seg.length === 1) {
      ctx.json(res, 200, { incident: manager.get(id) });
      return true;
    }

    // POST /api/incidents/:id/transitions  {to, actor, detail?}
    if (method === 'POST' && seg.length === 2 && seg[1] === 'transitions') {
      const body = await ctx.readBody(req);
      const to = String(body.to ?? '');
      if (!isStatus(to)) {
        ctx.json(res, 400, { error: `unknown status ${to}` });
        return true;
      }
      const inc = manager.transition(id, to, String(body.actor ?? 'unknown'), body.detail ? String(body.detail) : undefined);
      ctx.json(res, 200, { incident: inc });
      return true;
    }

    // POST /api/incidents/:id/evidence  {ref, actor}
    if (method === 'POST' && seg.length === 2 && seg[1] === 'evidence') {
      const body = await ctx.readBody(req);
      const inc = manager.addRecoveryEvidence(id, String(body.ref ?? ''), String(body.actor ?? 'unknown'));
      ctx.json(res, 200, { incident: inc });
      return true;
    }

    // POST /api/incidents/:id/resolution-basis  {basis, actor}
    if (method === 'POST' && seg.length === 2 && seg[1] === 'resolution-basis') {
      const body = await ctx.readBody(req);
      const inc = manager.setResolutionBasis(id, String(body.basis ?? ''), String(body.actor ?? 'unknown'));
      ctx.json(res, 200, { incident: inc });
      return true;
    }

    // POST /api/incidents/:id/postmortem  {rootCause, followUp[], humanConfirmedBy?}
    if (method === 'POST' && seg.length === 2 && seg[1] === 'postmortem') {
      const body = await ctx.readBody(req);
      const inc = manager.setPostmortem(
        id,
        {
          rootCause: String(body.rootCause ?? ''),
          followUp: Array.isArray(body.followUp) ? body.followUp.map(String) : [],
          humanConfirmedBy: body.humanConfirmedBy ? String(body.humanConfirmedBy) : undefined,
        },
        String(body.actor ?? 'unknown'),
      );
      ctx.json(res, 200, { incident: inc });
      return true;
    }

    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notFound = /not found/i.test(message);
    ctx.json(res, notFound ? 404 : 400, { error: message, name: err instanceof Error ? err.name : undefined });
    return true;
  }
}

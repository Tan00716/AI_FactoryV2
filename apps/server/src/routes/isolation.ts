/**
 * Isolation routes — SPEC v2 §7 (real isolation, fail-closed).
 *
 *   GET  /api/isolation/backends            list known backend kinds
 *   POST /api/isolation/verify              {backend: 'unverified'|'local-dev', workspaceRoot?, osBoundaryAttested?} → ConfinementReport
 *   POST /api/isolation/gate                {backend, ...} → 200 verified | 503 CONFINEMENT_UNAVAILABLE
 *   POST /api/isolation/workspaces          create a WorkspaceRecord (§7.2)
 *   POST /api/isolation/paths/analyze       {path} → PathThreat[]
 *   POST /api/isolation/paths/resolve       {root, path} → {resolved} | 400 PATH_ESCAPE
 *
 * The coordinator wires this in: handleIsolationRoutes(req, res, url, ctx).
 * NOTE: apps/server/src/index.ts is not touched by this module's author;
 * the coordinator must call this handler in the dispatch chain.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ConfinementUnavailableError,
  LocalDevBackend,
  UnverifiedBackend,
  assertConfinementForAutonomousShell,
  createWorkspaceRecord,
  detectPathThreats,
  resolveConfinedPathSync,
  type IsolationBackend,
} from '@ai-factory/security';
import type { RouteContext } from './context';

const PREFIX = '/api/isolation';

function buildBackend(body: Record<string, unknown>): IsolationBackend {
  const kind = body['backend'];
  if (kind === 'local-dev') {
    const root = body['workspaceRoot'];
    if (typeof root !== 'string' || !root) {
      throw Object.assign(new Error('workspaceRoot is required for local-dev'), { status: 400 });
    }
    return new LocalDevBackend({
      workspaceRoot: root,
      osBoundaryAttested: body['osBoundaryAttested'] === true,
      forbiddenPrefixes: Array.isArray(body['forbiddenPrefixes'])
        ? (body['forbiddenPrefixes'] as unknown[]).filter((p): p is string => typeof p === 'string')
        : [],
    });
  }
  return new UnverifiedBackend();
}

export async function handleIsolationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  if (method === 'GET' && path === `${PREFIX}/backends`) {
    return ctx.json(res, 200, {
      backends: [
        { name: 'unverified', kind: 'unverified', note: 'fail-closed default; never verifies' },
        { name: 'local-dev', kind: 'local-dev', note: 'best-effort checks; verifies only with attested OS boundary' },
      ],
    }), true;
  }

  if (method === 'POST' && path === `${PREFIX}/verify`) {
    const body = await ctx.readBody(req);
    try {
      const report = buildBackend(body).verifyConfinement();
      return ctx.json(res, 200, report), true;
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return ctx.json(res, status, { error: (err as Error).message }), true;
    }
  }

  if (method === 'POST' && path === `${PREFIX}/gate`) {
    const body = await ctx.readBody(req);
    try {
      const report = assertConfinementForAutonomousShell(buildBackend(body));
      return ctx.json(res, 200, { allowed: true, report }), true;
    } catch (err) {
      if (err instanceof ConfinementUnavailableError) {
        return ctx.json(res, 503, {
          allowed: false,
          code: err.code,
          reasonCode: err.reasonCode,
          error: err.message,
          report: err.report,
        }), true;
      }
      const status = (err as { status?: number }).status ?? 400;
      return ctx.json(res, status, { error: (err as Error).message }), true;
    }
  }

  if (method === 'POST' && path === `${PREFIX}/workspaces`) {
    const body = await ctx.readBody(req);
    const id = body['id'];
    const roots = body['authorized_roots'];
    const owner = body['owner'];
    if (typeof id !== 'string' || !id) return ctx.json(res, 400, { error: 'id is required' }), true;
    if (!Array.isArray(roots) || roots.length === 0) {
      return ctx.json(res, 400, { error: 'authorized_roots (non-empty array) is required' }), true;
    }
    if (typeof owner !== 'string' || !owner) return ctx.json(res, 400, { error: 'owner is required' }), true;
    try {
      const record = createWorkspaceRecord({
        id,
        authorized_roots: roots as string[],
        owner,
        backend: buildBackend(body),
      });
      return ctx.json(res, 201, record), true;
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return ctx.json(res, status, { error: (err as Error).message }), true;
    }
  }

  if (method === 'POST' && path === `${PREFIX}/paths/analyze`) {
    const body = await ctx.readBody(req);
    const p = body['path'];
    if (typeof p !== 'string') return ctx.json(res, 400, { error: 'path is required' }), true;
    return ctx.json(res, 200, { threats: detectPathThreats(p) }), true;
  }

  if (method === 'POST' && path === `${PREFIX}/paths/resolve`) {
    const body = await ctx.readBody(req);
    const root = body['root'];
    const p = body['path'];
    if (typeof root !== 'string' || typeof p !== 'string') {
      return ctx.json(res, 400, { error: 'root and path are required' }), true;
    }
    try {
      const resolved = resolveConfinedPathSync(root, p);
      return ctx.json(res, 200, { resolved }), true;
    } catch (err) {
      return ctx.json(res, 400, { error: (err as Error).message, code: 'PATH_ESCAPE' }), true;
    }
  }

  return false;
}

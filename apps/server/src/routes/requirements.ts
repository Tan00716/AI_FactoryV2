/**
 * Requirement routes — SPEC_V2 §16 (lives in @ai-factory/requirements).
 *
 *  POST /api/requirements                        create requirement
 *  GET  /api/requirements/:id                     latest version
 *  GET  /api/requirements/:id/versions/:v        immutable version read
 *  POST /api/requirements/:id/versions           {changeKind, changeNote, patch} → new version
 *  POST /api/requirements/:id/impact              {fromVersion, toVersion} → impact analysis
 *  POST /api/requirements/:id/ac-refinement       {acId, patch} → refined version
 *  POST /api/requirements/:id/compatibility       {evidenceId, requirementVersion, compatible, basis}
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { RequirementManager } from '@ai-factory/requirements';
import type { RouteContext } from './context';

const manager = new RequirementManager();

export async function handleRequirementRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/requirements')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/requirements'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg.length === 0) {
    const body = await ctx.readBody(req);
    try {
      const r = manager.create({
        id: body['id'] as string | undefined,
        businessGoal: body['businessGoal'] as string,
        rationale: body['rationale'] as string | undefined,
        acceptanceCriteria: body['acceptanceCriteria'] as never,
        exclusions: body['exclusions'] as string[] | undefined,
        constraints: body['constraints'] as string[] | undefined,
        completionTarget: body['completionTarget'] as never,
        environments: body['environments'] as string[] | undefined,
        outcomeMeasurement: body['outcomeMeasurement'] as string | undefined,
        releaseNaAuthorization: body['releaseNaAuthorization'] as never,
        createdBy: (body['createdBy'] as string | undefined) ?? 'api',
      });
      ctx.audit.record('api', 'REQUIREMENT_CREATED', 'requirement', r.id, {});
      ctx.json(res, 201, { requirement: r });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'GET' && seg.length === 1) {
    try {
      ctx.json(res, 200, { requirement: manager.get(seg[0]) });
    } catch (err) {
      ctx.json(res, 404, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'GET' && seg.length === 3 && seg[1] === 'versions') {
    try {
      ctx.json(res, 200, { version: manager.getVersion(seg[0], Number(seg[2])) });
    } catch (err) {
      ctx.json(res, 404, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 2 && seg[1] === 'versions') {
    const body = await ctx.readBody(req);
    try {
      const v = manager.newVersion(
        seg[0],
        body['changeKind'] as never,
        (body['changeNote'] as string | undefined) ?? '',
        (body['createdBy'] as string | undefined) ?? 'api',
        (draft) => {
          Object.assign(draft, body['patch'] ?? {});
        },
      );
      ctx.json(res, 201, { version: v });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 2 && seg[1] === 'impact') {
    const body = await ctx.readBody(req);
    try {
      const impact = manager.analyzeImpact(
        seg[0],
        Number(body['fromVersion']),
        Number(body['toVersion']),
        (body['by'] as string | undefined) ?? 'api',
      );
      ctx.json(res, 200, { impact });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 2 && seg[1] === 'ac-refinement') {
    const body = await ctx.readBody(req);
    try {
      const v = manager.proposeAcRefinement(
        seg[0],
        body['acId'] as string,
        (body['patch'] as never) ?? {},
        (body['by'] as string | undefined) ?? 'api',
      );
      ctx.json(res, 201, { version: v });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 2 && seg[1] === 'compatibility') {
    const body = await ctx.readBody(req);
    const rec = manager.checkEvidenceCompatibility(
      body['evidenceId'] as string,
      seg[0],
      Number(body['requirementVersion']),
      body['compatible'] as boolean,
      (body['basis'] as string | undefined) ?? '',
      (body['checkedBy'] as string | undefined) ?? 'api',
    );
    ctx.json(res, 201, { compatibility: rec });
    return true;
  }

  return false;
}

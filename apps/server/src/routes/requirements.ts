/**
 * Requirement routes — SPEC_V2 §16 (lives in @ai-factory/requirements).
 *
 *  POST /api/requirements                        create requirement
 *  GET  /api/requirements/:id                     latest version
 *  GET  /api/requirements/:id/versions/:v        immutable version read
 *  POST /api/requirements/:id/versions           {changeKind, changeNote, patch} → new version
 *  POST /api/requirements/:id/links               {version, taskIds?, planIds?, codeRefs?,
 *                                                  testIds?, evidenceIds?, approvalIds?,
 *                                                  releaseIds?} → updated EntityLinks
 *  POST /api/requirements/:id/impact              {fromVersion, toVersion} → impact analysis
 *  POST /api/requirements/:id/ac-refinement       {acId, patch} → refined version
 *  POST /api/requirements/:id/compatibility       {evidenceId, requirementVersion, compatible, basis}
 *  GET  /api/requirements/holds?taskId=           list promotion holds (optionally per task)
 *  POST /api/requirements/holds/:id/release      {by, revalidationNote} → release a hold
 *  POST /api/requirements/promotion-check         {taskId} → 200 {allowed:true} | 409 {allowed:false, holds}
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { RequirementManager } from '@ai-factory/requirements';
import type { EntityLinks } from '@ai-factory/requirements';
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

  // Promotion-hold routes (§16 G-05) — MUST precede the generic
  // GET /api/requirements/:id handler below, or 'holds' would be read
  // as a requirement id.
  if (method === 'GET' && seg.length === 1 && seg[0] === 'holds') {
    const taskId = url.searchParams.get('taskId') ?? undefined;
    ctx.json(res, 200, { holds: manager.listHolds(taskId) });
    return true;
  }

  if (method === 'POST' && seg.length === 3 && seg[0] === 'holds' && seg[2] === 'release') {
    const body = await ctx.readBody(req);
    try {
      const hold = manager.releaseHold(
        seg[1],
        (body['by'] as string | undefined) ?? 'api',
        (body['revalidationNote'] as string | undefined) ?? '',
      );
      ctx.audit.record('api', 'PROMOTION_HOLD_RELEASED', 'requirement', hold.requirementId, {
        holdId: hold.id,
        taskId: hold.taskId,
      });
      ctx.json(res, 200, { hold });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'promotion-check') {
    const body = await ctx.readBody(req);
    const taskId = body['taskId'] as string | undefined;
    if (!taskId) {
      ctx.json(res, 400, { error: 'taskId is required' });
      return true;
    }
    // Fail-closed gate: assertPromotionAllowed throws while a hold is
    // active; the 409 body lists the blocking holds.
    try {
      manager.assertPromotionAllowed(taskId);
      ctx.json(res, 200, { allowed: true });
    } catch (err) {
      if (manager.isPromotionHeld(taskId)) {
        ctx.json(res, 409, { allowed: false, holds: manager.activeHolds(taskId) });
      } else {
        ctx.json(res, 500, { error: (err as Error).message });
      }
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

  // Entity links (§16) — binds tasks/plans/code/tests/evidence/approvals/
  // releases to one requirement version. This is the HTTP entry point that
  // makes impact analysis (and its promotion holds) reachable end-to-end:
  // without it no task could ever be linked, so analyzeImpact() would
  // never suspend anything. Fail-closed: a missing/invalid version or a
  // nonexistent requirement version is a 400, never a silent no-op.
  if (method === 'POST' && seg.length === 2 && seg[1] === 'links') {
    const body = await ctx.readBody(req);
    const version = Number(body['version']);
    if (!Number.isInteger(version) || version < 1) {
      ctx.json(res, 400, { error: 'version (positive integer) is required' });
      return true;
    }
    const LINK_FIELDS = [
      'planIds',
      'taskIds',
      'codeRefs',
      'testIds',
      'evidenceIds',
      'approvalIds',
      'releaseIds',
    ] as const;
    const links: Partial<EntityLinks> = {};
    for (const f of LINK_FIELDS) {
      const v = body[f];
      if (v === undefined) continue;
      if (!Array.isArray(v) || !v.every((e) => typeof e === 'string')) {
        ctx.json(res, 400, { error: `${f} must be an array of strings` });
        return true;
      }
      links[f] = v as string[];
    }
    try {
      manager.linkEntities(seg[0], version, links);
      ctx.audit.record('api', 'REQUIREMENT_ENTITIES_LINKED', 'requirement', seg[0], {
        version,
      });
      ctx.json(res, 200, { links: manager.getLinks(seg[0], version) });
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

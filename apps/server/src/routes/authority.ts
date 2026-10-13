/**
 * Authority conflict routes — spec §8.1, INV-31.
 *
 *  POST /api/authority/directives              register a principal's directive
 *  GET  /api/authority/conflicts[?status=]     list conflicts
 *  GET  /api/authority/conflicts/:id           one conflict with its directives
 *  POST /api/authority/conflicts/:id/resolve   human escalation decision
 *  GET  /api/authority/targets/:kind/:id       directives + open conflict + paused flag
 *
 * The registry is the Authority check (who may order what). Policy and
 * Scheduler stay their own engines. Principal identity is asserted by the
 * caller and recorded in audit — it is not cryptographically verified here
 * (documented boundary).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  AuthorityConflictRegistry,
  type AuthorityAuditEvent,
  type AuthorityLevel,
  type DirectiveEffect,
  type AuthorityTargetKind,
} from '@ai-factory/policy';
import type { RouteContext } from './context';

/**
 * The registry emits its own audit events (registration, detection,
 * auto-resolution, human resolution, supersede, attach). They are buffered
 * here and flushed into the server audit log by each handler — the
 * registry itself stays storage-agnostic.
 */
const pendingAudit: AuthorityAuditEvent[] = [];
const registry = new AuthorityConflictRegistry({
  audit: (e) => pendingAudit.push(e),
});

function flushAudit(ctx: RouteContext): void {
  for (const e of pendingAudit.splice(0)) {
    ctx.audit.record(
      'system',
      e.event,
      'authority-conflict',
      String(e.details['conflictId'] ?? e.details['directiveId'] ?? 'authority'),
      e.details,
    );
  }
}

export async function handleAuthorityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/authority')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/authority'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg.length === 1 && seg[0] === 'directives') {
    const body = await ctx.readBody(req);
    const { principalId, authorityLevel, targetKind, targetId, effect, instruction } = body as Record<string, unknown>;
    try {
      const { directive, conflict, superseded } = registry.registerDirective({
        principalId: principalId as string,
        authorityLevel: authorityLevel as AuthorityLevel,
        targetKind: targetKind as AuthorityTargetKind,
        targetId: targetId as string,
        effect: effect as DirectiveEffect,
        instruction: typeof instruction === 'string' ? instruction : '',
      });
      flushAudit(ctx);
      ctx.json(res, 200, {
        directive,
        conflict,
        supersededDirectiveId: superseded?.directiveId ?? null,
        paused: conflict?.status === 'OPEN',
      });
    } catch (err) {
      ctx.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (method === 'GET' && seg.length === 1 && seg[0] === 'conflicts') {
    const status = url.searchParams.get('status');
    const list = registry.listConflicts(
      status === 'OPEN' || status === 'RESOLVED' ? status : undefined,
    );
    ctx.json(res, 200, { conflicts: list });
    return true;
  }

  if (method === 'GET' && seg.length === 2 && seg[0] === 'conflicts') {
    const c = registry.getConflict(seg[1]);
    if (!c) {
      ctx.json(res, 404, { error: 'unknown conflict' });
      return true;
    }
    ctx.json(res, 200, {
      conflict: c,
      directives: c.directiveIds
        .map((id) => registry.getDirective(id))
        .filter((d) => d !== null),
    });
    return true;
  }

  if (method === 'POST' && seg.length === 3 && seg[0] === 'conflicts' && seg[2] === 'resolve') {
    const body = await ctx.readBody(req);
    const { decidedByPrincipalId, decidedByLevel, winningDirectiveId, rationale } = body as Record<string, unknown>;
    const result = registry.resolveConflict(seg[1], {
      decidedByPrincipalId: decidedByPrincipalId as string,
      decidedByLevel: decidedByLevel as AuthorityLevel,
      winningDirectiveId: winningDirectiveId as string,
      rationale: typeof rationale === 'string' ? rationale : '',
    });
    if (!result.ok) {
      ctx.json(res, 400, { error: result.reason });
      return true;
    }
    flushAudit(ctx);
    ctx.json(res, 200, { conflict: result.conflict });
    return true;
  }

  if (method === 'GET' && seg.length === 3 && seg[0] === 'targets') {
    const kind = seg[1] as AuthorityTargetKind;
    const id = decodeURIComponent(seg[2]);
    if (kind !== 'run' && kind !== 'task') {
      ctx.json(res, 400, { error: 'target kind must be run or task' });
      return true;
    }
    const open = registry.listConflicts('OPEN').find(
      (c) => c.targetKind === kind && c.targetId === id,
    );
    ctx.json(res, 200, {
      targetKind: kind,
      targetId: id,
      paused: open != null,
      openConflict: open ?? null,
      directives: registry.listDirectives(kind, id),
    });
    return true;
  }

  return false;
}

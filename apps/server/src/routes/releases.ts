/**
 * Release routes — spec §40 (Environment Manager), §41 (Production Policy),
 * §77 (Snapshot/Recovery).
 *
 *   GET  /api/releases                        list releases (in-memory)
 *   POST /api/releases                         {version, artifacts?, commits?, changelog?, environmentId?, createdBy?}
 *   POST /api/releases/:id/deploy              {environmentId?, approvalId?, actor?}
 *   POST /api/releases/:id/rollback           {actor?}
 *
 * The deploy gate (environment exists → approval policy satisfied → §77
 * snapshot → deploy → health check → auto-rollback) lives in
 * @ai-factory/cicd's ReleaseManager. Approval *decisions* come from
 * @ai-factory/approvals: pass an already-APPROVED approvalId in the deploy
 * body and the route attaches it as the release's approval evidence (the
 * human gate only accepts human-level approvals). Without a sufficient
 * approval, PROD deploys return 409 and park the release at pending_approval.
 *
 * The coordinator wires this in: handleReleaseRoutes(req, res, url, ctx).
 * PROTOTYPE NOTE: releases/snapshots are in-memory (lost on restart);
 * deployFn and healthCheckFn are simulated.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ApprovalRequiredError,
  EnvironmentNotFoundError,
  ReleaseManager,
  ReleaseNotDeployableError,
  ReleaseNotFoundError,
  SnapshotStore,
  type ApprovalRef,
  type Release,
} from '@ai-factory/cicd';
import type { RouteContext } from './context';

const PREFIX = '/api/releases';

// Shared across requests (in-memory prototype state).
const releases = new Map<string, Release>();
const snapshotStore = new SnapshotStore();

/**
 * Build a per-request ReleaseManager: ctx-bound audit, and approval grants
 * resolved against the live @ai-factory/approvals store (the policy判定
 * itself stays in the approvals package).
 */
function releaseManager(ctx: RouteContext, actor: string): ReleaseManager {
  return new ReleaseManager({
    releases,
    snapshotStore,
    audit: (action, details) =>
      ctx.audit.record(
        actor,
        action,
        'release',
        String(details['releaseId'] ?? ''),
        details,
      ),
    isApprovalGranted: (approvalId) => {
      const a = ctx.fdb.approvals.get(approvalId);
      return a?.status === 'APPROVED';
    },
  });
}

/** Map an @ai-factory/approvals ticket onto a release ApprovalRef. */
function approvalRefFromTicket(
  ticket: { approval_id: string; decided_by: string; requester: string; required_approvers: string[]; decided_at: string | null },
): ApprovalRef {
  return {
    approvalId: ticket.approval_id,
    approver: ticket.decided_by || ticket.requester,
    decision: 'APPROVED',
    decidedAt: ticket.decided_at,
    level: ticket.required_approvers.some((r) => r === 'human' || r.startsWith('human:'))
      ? 'human'
      : 'ai',
  };
}

export async function handleReleaseRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/releases
  if (method === 'GET' && path === PREFIX) {
    const mgr = releaseManager(ctx, 'system');
    return ctx.json(res, 200, { releases: mgr.listReleases() }), true;
  }

  // POST /api/releases
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req);
    const actor = typeof body['actor'] === 'string' ? body['actor'] : 'human';
    const version = body['version'];
    if (typeof version !== 'string' || !version) {
      return ctx.json(res, 400, { error: 'version is required (semver)' }), true;
    }
    const mgr = releaseManager(ctx, actor);
    try {
      const release = mgr.createRelease({
        version,
        artifacts: Array.isArray(body['artifacts'])
          ? body['artifacts'].filter((a): a is string => typeof a === 'string')
          : [],
        commits: Array.isArray(body['commits'])
          ? body['commits'].filter((c): c is string => typeof c === 'string')
          : undefined,
        changelog: Array.isArray(body['changelog'])
          ? body['changelog'].filter((c): c is string => typeof c === 'string')
          : undefined,
        environmentId:
          typeof body['environmentId'] === 'string' ? body['environmentId'] : undefined,
        createdBy: typeof body['createdBy'] === 'string' ? body['createdBy'] : actor,
      });
      return ctx.json(res, 201, { release }), true;
    } catch (e) {
      const err = e as Error;
      const status =
        err.name === 'InvalidSemverError' || err.name === 'EnvironmentNotFoundError'
          ? 400
          : 500;
      return ctx.json(res, status, { error: err.message, name: err.name }), true;
    }
  }

  const idMatch = path.match(/^\/api\/releases\/([^/]+)(\/.*)?$/);
  if (!idMatch) return false;
  const id = idMatch[1];
  const rest = idMatch[2] ?? '';

  // POST /api/releases/:id/deploy
  if (method === 'POST' && rest === '/deploy') {
    const body = await ctx.readBody(req);
    const actor = typeof body['actor'] === 'string' ? body['actor'] : 'human';
    const environmentId =
      typeof body['environmentId'] === 'string' ? body['environmentId'] : undefined;
    const approvalId = body['approvalId'];
    const mgr = releaseManager(ctx, actor);

    // An already-APPROVED @ai-factory/approvals ticket can be attached as
    // the release's approval evidence in the same call.
    if (typeof approvalId === 'string' && approvalId) {
      const ticket = ctx.fdb.approvals.get(approvalId);
      if (!ticket) {
        return ctx.json(res, 404, { error: `approval ${approvalId} not found` }), true;
      }
      if (ticket.status !== 'APPROVED') {
        return ctx.json(
          res,
          409,
          { error: `approval is ${ticket.status}, not APPROVED` },
        ), true;
      }
      try {
        mgr.addApproval(id, approvalRefFromTicket(ticket));
      } catch (e) {
        const err = e as Error;
        const status = err instanceof ReleaseNotFoundError ? 404 : 409;
        return ctx.json(res, status, { error: err.message, name: err.name }), true;
      }
    }

    try {
      const out = await mgr.deployRelease(id, environmentId);
      return ctx.json(res, 200, {
        release: out.release,
        snapshotId: out.release.snapshotId,
        rolledBack: out.rolledBack,
      }), true;
    } catch (e) {
      const err = e as Error;
      let status = 409;
      if (err instanceof ReleaseNotFoundError) status = 404;
      else if (err instanceof EnvironmentNotFoundError) status = 400;
      const body: Record<string, unknown> = { error: err.message, name: err.name };
      if (err instanceof ApprovalRequiredError) {
        body['approvalPolicy'] = err.approvalPolicy;
        body['releaseId'] = err.releaseId;
        body['hint'] =
          'get a human approval via /api/approvals, then retry with { approvalId }';
      }
      if (err instanceof ReleaseNotDeployableError) {
        try {
          body['release'] = mgr.getRelease(id);
        } catch {
          // release truly gone; the 404 branch above already handled it
        }
      }
      return ctx.json(res, status, body), true;
    }
  }

  // POST /api/releases/:id/rollback
  if (method === 'POST' && rest === '/rollback') {
    const body = await ctx.readBody(req);
    const actor = typeof body['actor'] === 'string' ? body['actor'] : 'human';
    const mgr = releaseManager(ctx, actor);
    try {
      const release = mgr.rollbackRelease(id);
      return ctx.json(res, 200, { release }), true;
    } catch (e) {
      const err = e as Error;
      const status = err instanceof ReleaseNotFoundError ? 404 : 409;
      return ctx.json(res, status, { error: err.message, name: err.name }), true;
    }
  }

  return false;
}

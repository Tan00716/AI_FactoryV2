/**
 * Authorization ticket registry — SPEC v2 §17.2 (G-09, Batch 18).
 *
 *   POST /api/authorization-tickets            issue a ticket
 *   GET  /api/authorization-tickets            list (?status=, ?projectId=)
 *   GET  /api/authorization-tickets/:id        one ticket
 *   POST /api/authorization-tickets/:id/revoke revoke an ACTIVE ticket
 *
 * A ticket is the recorded Operational pre-authorization §17.2 asks
 * for: it names the triggering policy and its Rule ID, the scope it
 * covers, its issuer and its validity window. POLICY dispatches
 * (POST /api/tasks/:id/dispatch, in index.ts) may consume a ticket
 * by id instead of presenting a bare Rule ID; consumption is
 * single-use and recorded on the ticket itself (see
 * packages/db/src/authorization-tickets.ts for the semantics).
 *
 * Issuing and revoking are policy administration: the RBAC layer
 * classifies non-GET calls on this surface as admin (auth.ts),
 * reads as viewer — the same treatment as retention and policy.
 * Every issue/revoke writes an audit event; the dispatch-side
 * consumption and rejection events are written by the dispatch
 * handler itself, where the task context lives.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AuthorizationTicketError,
  AuthorizationTicketNotFoundError,
  type AuthorizationTicketScope,
  type AuthorizationTicketStatus,
} from '@ai-factory/db';
import type { RouteContext } from './context';

const PREFIX = '/api/authorization-tickets';
const TICKET_STATUSES: AuthorizationTicketStatus[] = [
  'ACTIVE',
  'USED',
  'REVOKED',
  'EXPIRED',
];

function parseScope(v: unknown): AuthorizationTicketScope | null {
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const scope: AuthorizationTicketScope = {};
  if (o['projectId'] !== undefined) {
    if (typeof o['projectId'] !== 'string' || !o['projectId']) return null;
    scope.projectId = o['projectId'];
  }
  for (const key of ['priorities', 'actions'] as const) {
    if (o[key] !== undefined) {
      if (
        !Array.isArray(o[key]) ||
        !(o[key] as unknown[]).every((e) => typeof e === 'string' && e)
      ) {
        return null;
      }
      scope[key] = [...(o[key] as string[])];
    }
  }
  return scope;
}

export async function handleAuthorizationTicketRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const store = ctx.fdb.authorizationTickets;

  // POST /api/authorization-tickets — issue.
  if (method === 'POST' && path === PREFIX) {
    const b = await ctx.readBody(req);
    const policyRuleId =
      typeof b['policyRuleId'] === 'string' && b['policyRuleId']
        ? b['policyRuleId']
        : undefined;
    if (!policyRuleId) {
      return (
        ctx.json(res, 400, {
          error:
            'policyRuleId is required (§17.2: a pre-authorization ticket records its triggering policy and Rule ID)',
        }),
        true
      );
    }
    const scope = parseScope(b['scope']);
    if (scope === null) {
      return (
        ctx.json(res, 400, {
          error:
            'scope must be an object with optional projectId (string), priorities (string[]), actions (string[])',
        }),
        true
      );
    }
    let expiresAt: string | null = null;
    if (b['expiresAt'] !== undefined && b['expiresAt'] !== null) {
      if (
        typeof b['expiresAt'] !== 'string' ||
        !Number.isFinite(Date.parse(b['expiresAt']))
      ) {
        return (
          ctx.json(res, 400, {
            error: 'expiresAt must be an ISO timestamp or null',
          }),
          true
        );
      }
      expiresAt = b['expiresAt'];
    }
    const issuedBy =
      typeof b['issuedBy'] === 'string' && b['issuedBy']
        ? b['issuedBy']
        : 'human';
    const ticket = store.create({ policyRuleId, scope, issuedBy, expiresAt });
    ctx.audit.record(issuedBy, 'AUTHORIZATION_TICKET_ISSUED', 'authorization_ticket', ticket.id, {
      ticketId: ticket.id,
      policyRuleId: ticket.policyRuleId,
      scope: ticket.scope,
      expiresAt: ticket.expiresAt,
    });
    return ctx.json(res, 201, ticket), true;
  }

  // GET /api/authorization-tickets — list with optional filters.
  if (method === 'GET' && path === PREFIX) {
    const status = url.searchParams.get('status');
    if (status !== null && !(TICKET_STATUSES as string[]).includes(status)) {
      return (
        ctx.json(res, 400, {
          error: `status must be ${TICKET_STATUSES.join('|')}`,
        }),
        true
      );
    }
    const projectId = url.searchParams.get('projectId') ?? undefined;
    return (
      ctx.json(
        res,
        200,
        store.list({
          status: (status ?? undefined) as AuthorizationTicketStatus | undefined,
          projectId,
        }),
      ),
      true
    );
  }

  const rest = path.slice(PREFIX.length + 1); // after '/api/authorization-tickets/'
  const [id, sub] = rest.split('/');

  // GET /api/authorization-tickets/:id
  if (method === 'GET' && id && !sub) {
    const ticket = store.get(id);
    if (!ticket) {
      return ctx.json(res, 404, { error: 'authorization ticket not found' }), true;
    }
    return ctx.json(res, 200, ticket), true;
  }

  // POST /api/authorization-tickets/:id/revoke
  if (method === 'POST' && id && sub === 'revoke') {
    const b = await ctx.readBody(req);
    const by =
      typeof b['actor'] === 'string' && b['actor'] ? b['actor'] : 'human';
    const reason =
      typeof b['reason'] === 'string' && b['reason'] ? b['reason'] : undefined;
    try {
      const ticket = store.revoke(id, { by, reason });
      ctx.audit.record(by, 'AUTHORIZATION_TICKET_REVOKED', 'authorization_ticket', id, {
        ticketId: id,
        policyRuleId: ticket.policyRuleId,
        ...(reason ? { reason } : {}),
      });
      return ctx.json(res, 200, ticket), true;
    } catch (e) {
      if (e instanceof AuthorizationTicketNotFoundError) {
        return ctx.json(res, 404, { error: e.message }), true;
      }
      if (e instanceof AuthorizationTicketError) {
        return (
          ctx.json(res, 409, {
            error: e.message,
            code: 'AUTHORIZATION_TICKET_STATE',
            status: e.status,
          }),
          true
        );
      }
      throw e;
    }
  }

  return false;
}

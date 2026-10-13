/**
 * Delegation HTTP surface — SPEC v2 §12.2 (Batch 32).
 *
 *   POST /api/delegations                  create a root delegation (DRAFT)
 *   POST /api/delegations/:id/children     create a child under an ACTIVE parent
 *   GET  /api/delegations                   live + INTERRUPTED history
 *   GET  /api/delegations/:id               one delegation (live or INTERRUPTED)
 *   POST /api/delegations/:id/activate      DRAFT -> ACTIVE
 *   POST /api/delegations/:id/complete      ACTIVE -> COMPLETED
 *   POST /api/delegations/:id/cancel        DRAFT|ACTIVE -> CANCELLED
 *   POST /api/delegations/:id/handoff       {actor} — owner moves to delegatee
 *   POST /api/delegations/:id/reparent      {newParentId}
 *
 * Every successful mutation is written through to fdb.delegations
 * the moment the DelegationManager accepts it, and audited
 * (DELEGATION_CREATED / _ACTIVATED / _COMPLETED / _CANCELLED /
 * _HANDOFF / _REPARENTED). A rule violation (SCOPE_VIOLATION,
 * BUDGET_EXCEEDED, DEPTH_EXCEEDED, CYCLE_VIOLATION, NOT_OWNER,
 * INVALID_STATE, …) throws before any write — the DB never sees a
 * rejected delegation — and is answered 409 with the domain error
 * code (never a 500: the request was understood, the rules said no).
 *
 * INTERRUPTED is terminal in the record layer: mutations on an
 * INTERRUPTED delegation are 409 ("never auto-resumed, never
 * re-activated — create a new delegation"). Children cannot be
 * created under an INTERRUPTED parent (it is not in the live
 * manager: DELEGATION_NOT_FOUND would be misleading, so the 409
 * names the real state).
 *
 * RBAC: reads are viewer, writes are operator (the auth gate default).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DelegationError, type CreateDelegationInput } from '@ai-factory/orchestrator';
import type { AuditLog } from '@ai-factory/core';
import type { FactoryDatabase } from '@ai-factory/db';
import type { RouteContext } from './context';
import {
  DELEGATION_ACTIVE_AT_RESTART_NOTE,
  initDelegationService,
  type DelegationService,
} from '../delegation-service';

let service: DelegationService | null = null;

/** Boot wiring (called from the coordinator in index.ts). */
export function initDelegationRoutes(fdb: FactoryDatabase, audit: AuditLog): void {
  const { service: s } = initDelegationService({ fdb, audit });
  service = s;
}

function requireService(): DelegationService {
  if (!service) throw new Error('delegation service not initialized');
  return service;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === 'string')) return null;
  return v as string[];
}

function parseCreateInput(b: Record<string, unknown>): { ok: true; input: CreateDelegationInput } | { ok: false; error: string } {
  const req = (k: string): string | null =>
    typeof b[k] === 'string' && (b[k] as string).length > 0 ? (b[k] as string) : null;
  const delegator = req('delegator');
  const delegatee = req('delegatee');
  const rootAuth = req('root_authorization_id');
  const taskId = req('task_id');
  const requirementVersion = req('requirement_version');
  const scope = asStringArray(b['scope']);
  if (!delegator || !delegatee || !rootAuth || !taskId || !requirementVersion || scope === null) {
    return {
      ok: false,
      error:
        'delegator, delegatee, root_authorization_id, task_id, requirement_version (strings) and scope (string[]) are required',
    };
  }
  const budget = b['budget_reservation'];
  if (typeof budget !== 'number' || !Number.isFinite(budget)) {
    return { ok: false, error: 'budget_reservation (number) is required' };
  }
  const input: CreateDelegationInput = {
    delegator,
    delegatee,
    root_authorization_id: rootAuth,
    task_id: taskId,
    requirement_version: requirementVersion,
    scope,
    budget_reservation: budget,
  };
  if (typeof b['delegation_id'] === 'string') input.delegation_id = b['delegation_id'] as string;
  if (typeof b['parent_delegation_id'] === 'string' || b['parent_delegation_id'] === null)
    input.parent_delegation_id = b['parent_delegation_id'] as string | null;
  const opt = (k: 'AC_refs' | 'allowed_outputs' | 'evidence_requirements' | 'capability_ceiling' | 'reporting_targets'): void => {
    const v = asStringArray(b[k]);
    if (v !== null) (input as unknown as Record<string, unknown>)[k] = v;
  };
  opt('AC_refs');
  opt('allowed_outputs');
  opt('evidence_requirements');
  opt('capability_ceiling');
  opt('reporting_targets');
  if (typeof b['due_at'] === 'string' || b['due_at'] === null) input.due_at = b['due_at'] as string | null;
  if (
    b['review_policy'] === 'manager-review' ||
    b['review_policy'] === 'independent-qa' ||
    b['review_policy'] === 'human-approval' ||
    b['review_policy'] === 'none'
  )
    input.review_policy = b['review_policy'];
  return { ok: true, input };
}

export async function handleDelegationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const p = url.pathname;
  if (p !== '/api/delegations' && !p.startsWith('/api/delegations/')) return false;
  const { json, readBody } = ctx;
  const method = req.method ?? 'GET';
  const svc = requireService();

  const domainError = (e: unknown): boolean => {
    if (e instanceof DelegationError) {
      json(res, 409, { error: e.message, code: e.code });
      return true;
    }
    return false;
  };

  // POST /api/delegations — create a root delegation.
  if (p === '/api/delegations' && method === 'POST') {
    const b = await readBody(req);
    const parsed = parseCreateInput(b);
    if (!parsed.ok) return json(res, 400, { error: parsed.error }), true;
    if (parsed.input.parent_delegation_id) {
      return json(res, 400, { error: 'use POST /api/delegations/:id/children for child delegations' }), true;
    }
    try {
      const d = svc.createRoot(parsed.input, 'delegation-service');
      return json(res, 201, { delegation: d }), true;
    } catch (e) {
      if (domainError(e)) return true;
      throw e;
    }
  }

  // GET /api/delegations — live + INTERRUPTED history.
  if (p === '/api/delegations' && method === 'GET') {
    const { live, interrupted, corrupt } = svc.listAll();
    return json(res, 200, {
      delegations: live,
      interrupted: interrupted.map((r) => ({
        delegation_id: r.delegationId,
        delegator: r.delegator,
        delegatee: r.delegatee,
        task_id: r.taskId,
        status: r.status,
        version: r.version,
        rehydrated_at: r.rehydratedAt,
        note: DELEGATION_ACTIVE_AT_RESTART_NOTE,
        record: JSON.parse(r.recordJson),
      })),
      corrupt,
    }), true;
  }

  const m = p.match(/^\/api\/delegations\/([^/]+)(?:\/(children|activate|complete|cancel|handoff|reparent))?$/);
  if (!m) return false;
  const id = decodeURIComponent(m[1]);
  const action = m[2] ?? '';

  const interruptedRow = svc.store.listByStatus('INTERRUPTED').find((r) => r.delegationId === id);

  // GET /api/delegations/:id
  if (action === '' && method === 'GET') {
    if (interruptedRow) {
      return json(res, 200, {
        delegation_id: interruptedRow.delegationId,
        status: interruptedRow.status,
        version: interruptedRow.version,
        rehydrated_at: interruptedRow.rehydratedAt,
        note: DELEGATION_ACTIVE_AT_RESTART_NOTE,
        record: JSON.parse(interruptedRow.recordJson),
      }), true;
    }
    try {
      return json(res, 200, { delegation: svc.manager.get(id) }), true;
    } catch (e) {
      if (e instanceof DelegationError && e.code === 'DELEGATION_NOT_FOUND') {
        return json(res, 404, { error: `unknown delegation ${id}`, code: e.code }), true;
      }
      throw e;
    }
  }

  if (method !== 'POST') return json(res, 405, { error: 'method not allowed' }), true;

  // Mutations on INTERRUPTED rows are refused loudly — they are
  // history, never auto-resumed, never re-activated.
  if (interruptedRow) {
    return json(res, 409, {
      error: `delegation ${id} is INTERRUPTED (${DELEGATION_ACTIVE_AT_RESTART_NOTE}); create a new delegation instead`,
      code: 'DELEGATION_INTERRUPTED',
    }), true;
  }

  try {
    if (action === 'children') {
      const b = await readBody(req);
      const parsed = parseCreateInput(b);
      if (!parsed.ok) return json(res, 400, { error: parsed.error }), true;
      const d = svc.createChild({ ...parsed.input, parent_delegation_id: id }, 'delegation-service');
      return json(res, 201, { delegation: d }), true;
    }
    if (action === 'activate') {
      return json(res, 200, { delegation: svc.activate(id, 'delegation-service') }), true;
    }
    if (action === 'complete') {
      return json(res, 200, { delegation: svc.complete(id, 'delegation-service') }), true;
    }
    if (action === 'cancel') {
      return json(res, 200, { delegation: svc.cancel(id, 'delegation-service') }), true;
    }
    if (action === 'handoff') {
      const b = await readBody(req);
      const actor = typeof b['actor'] === 'string' && b['actor'].length > 0 ? (b['actor'] as string) : null;
      if (!actor) return json(res, 400, { error: 'actor (string) is required' }), true;
      return json(res, 200, { delegation: svc.handoff(id, actor) }), true;
    }
    if (action === 'reparent') {
      const b = await readBody(req);
      const newParentId =
        typeof b['newParentId'] === 'string' && b['newParentId'].length > 0
          ? (b['newParentId'] as string)
          : null;
      if (!newParentId) return json(res, 400, { error: 'newParentId (string) is required' }), true;
      return json(res, 200, { delegation: svc.reparent(id, newParentId, 'delegation-service') }), true;
    }
    return json(res, 404, { error: 'unknown delegation action' }), true;
  } catch (e) {
    if (e instanceof DelegationError) {
      const status = e.code === 'DELEGATION_NOT_FOUND' ? 404 : 409;
      return json(res, status, { error: e.message, code: e.code }), true;
    }
    throw e;
  }
}

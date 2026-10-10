/**
 * Lease + lock routes — SPEC v2 §22.
 *
 *   POST /api/leases/acquire        {resource_id, owner_run_id, ttlMs}
 *   POST /api/leases/:id/renew     {fencing_token, ttlMs}
 *   POST /api/leases/:id/release   {fencing_token}
 *   POST /api/leases/reassign      {resource_id, owner_run_id, ttlMs}
 *   POST /api/leases/validate      {resource_id, fencing_token}
 *   POST /api/locks/acquire        {kind, key, owner, ttlMs}
 *   POST /api/locks/acquire-all    {requests: [...]}
 *   POST /api/locks/release        {kind, key, owner}
 *
 * The coordinator wires this in: handleLeaseRoutes(req, res, url, ctx).
 * NOTE: apps/server/src/index.ts is not touched by this module's author;
 * the coordinator must call this handler in the dispatch chain.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  LeaseConflictError,
  LeaseManager,
  LeaseNotFoundError,
  LockTimeoutError,
  ResourceLockManager,
  StaleOwnerError,
  type LockKind,
} from '@ai-factory/leases';
import type { RouteContext } from './context';

const PREFIX = '/api/leases';
const LOCK_PREFIX = '/api/locks';

const leases = new LeaseManager();
const locks = new ResourceLockManager();

function leaseErrorStatus(e: unknown): number {
  if (e instanceof LeaseNotFoundError) return 404;
  if (e instanceof LeaseConflictError) return 409;
  if (e instanceof StaleOwnerError) return 409;
  return 400;
}

const LOCK_KINDS: LockKind[] = ['task', 'file', 'resource', 'branch', 'environment', 'deployment'];

export async function handleLeaseRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const isLease = path === PREFIX || path.startsWith(PREFIX + '/');
  const isLock = path === LOCK_PREFIX || path.startsWith(LOCK_PREFIX + '/');
  if (!isLease && !isLock) return false;

  if (method === 'POST' && path === `${PREFIX}/acquire`) {
    const body = await ctx.readBody(req);
    const { resource_id, owner_run_id, ttlMs } = body as Record<string, unknown>;
    if (typeof resource_id !== 'string' || typeof owner_run_id !== 'string' || typeof ttlMs !== 'number') {
      return ctx.json(res, 400, { error: 'resource_id, owner_run_id and ttlMs are required' }), true;
    }
    try {
      return ctx.json(res, 201, leases.acquire(resource_id, owner_run_id, ttlMs)), true;
    } catch (e) {
      return ctx.json(res, leaseErrorStatus(e), { error: (e as Error).message, code: (e as { code?: string }).code }), true;
    }
  }

  const renewMatch = path.match(new RegExp(`^${PREFIX}/([^/]+)/renew$`));
  if (method === 'POST' && renewMatch) {
    const body = await ctx.readBody(req);
    try {
      return ctx.json(
        res,
        200,
        leases.renew(renewMatch[1], body['fencing_token'] as number, body['ttlMs'] as number),
      ), true;
    } catch (e) {
      return ctx.json(res, leaseErrorStatus(e), { error: (e as Error).message, code: (e as { code?: string }).code }), true;
    }
  }

  const releaseMatch = path.match(new RegExp(`^${PREFIX}/([^/]+)/release$`));
  if (method === 'POST' && releaseMatch) {
    const body = await ctx.readBody(req);
    try {
      leases.release(releaseMatch[1], body['fencing_token'] as number);
      return ctx.json(res, 200, { released: true }), true;
    } catch (e) {
      return ctx.json(res, leaseErrorStatus(e), { error: (e as Error).message, code: (e as { code?: string }).code }), true;
    }
  }

  if (method === 'POST' && path === `${PREFIX}/reassign`) {
    const body = await ctx.readBody(req);
    const { resource_id, owner_run_id, ttlMs } = body as Record<string, unknown>;
    if (typeof resource_id !== 'string' || typeof owner_run_id !== 'string' || typeof ttlMs !== 'number') {
      return ctx.json(res, 400, { error: 'resource_id, owner_run_id and ttlMs are required' }), true;
    }
    return ctx.json(res, 200, leases.reassign(resource_id, owner_run_id, ttlMs)), true;
  }

  if (method === 'POST' && path === `${PREFIX}/validate`) {
    const body = await ctx.readBody(req);
    try {
      return ctx.json(
        res,
        200,
        leases.validate(body['resource_id'] as string, body['fencing_token'] as number),
      ), true;
    } catch (e) {
      return ctx.json(res, leaseErrorStatus(e), { error: (e as Error).message, code: (e as { code?: string }).code }), true;
    }
  }

  if (method === 'POST' && path === `${LOCK_PREFIX}/acquire`) {
    const body = await ctx.readBody(req);
    const { kind, key, owner, ttlMs } = body as Record<string, unknown>;
    if (!LOCK_KINDS.includes(kind as LockKind) || typeof key !== 'string' || typeof owner !== 'string' || typeof ttlMs !== 'number') {
      return ctx.json(res, 400, { error: 'kind (task|file|resource|branch|environment|deployment), key, owner, ttlMs required' }), true;
    }
    try {
      return ctx.json(res, 201, locks.acquire(kind as LockKind, key, owner, ttlMs)), true;
    } catch (e) {
      const status = e instanceof LockTimeoutError ? 409 : 400;
      return ctx.json(res, status, { error: (e as Error).message, code: (e as { code?: string }).code }), true;
    }
  }

  if (method === 'POST' && path === `${LOCK_PREFIX}/acquire-all`) {
    const body = await ctx.readBody(req);
    const requests = body['requests'];
    if (!Array.isArray(requests) || requests.length === 0) {
      return ctx.json(res, 400, { error: 'requests (non-empty array) is required' }), true;
    }
    try {
      return ctx.json(res, 201, { grants: locks.acquireAll(requests as never) }), true;
    } catch (e) {
      const status = e instanceof LockTimeoutError ? 409 : 400;
      return ctx.json(res, status, { error: (e as Error).message, code: (e as { code?: string }).code }), true;
    }
  }

  if (method === 'POST' && path === `${LOCK_PREFIX}/release`) {
    const body = await ctx.readBody(req);
    const { kind, key, owner } = body as Record<string, unknown>;
    if (!LOCK_KINDS.includes(kind as LockKind) || typeof key !== 'string' || typeof owner !== 'string') {
      return ctx.json(res, 400, { error: 'kind, key and owner are required' }), true;
    }
    const released = locks.release(kind as LockKind, key, owner);
    return ctx.json(res, released ? 200 : 404, { released }), true;
  }

  return false;
}

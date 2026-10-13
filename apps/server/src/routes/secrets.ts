/**
 * Secret Broker routes — spec §46.2 (Batch 18).
 *
 *   GET    /api/secrets            metadata list (name/ref/backend/purpose/status)
 *   GET    /api/secrets/:name      metadata for one ref (exists:false on a miss)
 *   PUT    /api/secrets/:name      {value, purpose?} → store/rotate (admin)
 *   DELETE /api/secrets/:name      remove from every backend (admin)
 *
 * Values are NEVER served over HTTP: there is no endpoint that returns
 * a plaintext, and PUT responses are metadata only (the value is not
 * echoed). Resolution happens in-process at consumption points (see
 * routes/exec.ts secretEnv injection); the broker's audit hook —
 * wired in index.ts — records every set/delete/resolve by ref, and
 * those records never carry values either.
 *
 * RBAC (src/auth.ts requiredRoleFor): reads are viewer, mutations
 * admin. The coordinator wires this in: handleSecretRoutes(req, res,
 * url, ctx). ctx.secretBroker is injected by index.ts; without it the
 * surface answers 503 rather than inventing a store.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SecretNameError,
  SecretReadOnlyError,
  type SecretBroker,
} from '@ai-factory/secrets';
import type { RouteContext } from './context';

const PREFIX = '/api/secrets';

function brokerOr503(ctx: RouteContext, res: ServerResponse): SecretBroker | null {
  if (ctx.secretBroker) return ctx.secretBroker;
  ctx.json(res, 503, {
    error: 'secret broker is not configured on this server',
    code: 'SECRET_BROKER_UNAVAILABLE',
  });
  return null;
}

export async function handleSecretRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/secrets — metadata only.
  if (method === 'GET' && path === PREFIX) {
    const broker = brokerOr503(ctx, res);
    if (!broker) return true;
    const secrets = await broker.list();
    return ctx.json(res, 200, { backends: broker.backends, secrets }), true;
  }

  const nameMatch = path.match(new RegExp(`^${PREFIX}/([^/]+)$`));
  if (!nameMatch) return false;
  const name = decodeURIComponent(nameMatch[1]);

  // GET /api/secrets/:name — status of one ref; a miss is a 200 with
  // exists:false (this answers "does MY ref exist", and reveals
  // nothing about any other ref).
  if (method === 'GET') {
    const broker = brokerOr503(ctx, res);
    if (!broker) return true;
    try {
      return ctx.json(res, 200, await broker.describe(name)), true;
    } catch (e) {
      if (e instanceof SecretNameError) {
        return ctx.json(res, 400, { error: (e as Error).message, code: 'SECRET_NAME_INVALID' }), true;
      }
      throw e;
    }
  }

  // PUT /api/secrets/:name {value, purpose?} — store or rotate.
  if (method === 'PUT') {
    const broker = brokerOr503(ctx, res);
    if (!broker) return true;
    const body = await ctx.readBody(req);
    const value = body['value'];
    if (typeof value !== 'string' || value.length === 0) {
      return ctx.json(res, 400, { error: 'value (non-empty string) is required' }), true;
    }
    const actor = typeof body['actor'] === 'string' && body['actor'] ? (body['actor'] as string) : 'human';
    const purpose = typeof body['purpose'] === 'string' ? (body['purpose'] as string) : undefined;
    try {
      const meta = await broker.set(name, value, { actor, purpose });
      // Metadata only — the stored value is never echoed back.
      return ctx.json(res, 200, meta), true;
    } catch (e) {
      if (e instanceof SecretNameError) {
        return ctx.json(res, 400, { error: (e as Error).message, code: 'SECRET_NAME_INVALID' }), true;
      }
      if (e instanceof SecretReadOnlyError) {
        return ctx.json(res, 409, { error: (e as Error).message, code: e.code }), true;
      }
      throw e;
    }
  }

  // DELETE /api/secrets/:name
  if (method === 'DELETE') {
    const broker = brokerOr503(ctx, res);
    if (!broker) return true;
    const body = await ctx.readBody(req).catch(() => ({}) as Record<string, unknown>);
    const actor = typeof body['actor'] === 'string' && body['actor'] ? (body['actor'] as string) : 'human';
    try {
      const deleted = await broker.delete(name, { actor });
      return ctx.json(res, 200, { name, ref: `secret://${name}`, deleted }), true;
    } catch (e) {
      if (e instanceof SecretNameError) {
        return ctx.json(res, 400, { error: (e as Error).message, code: 'SECRET_NAME_INVALID' }), true;
      }
      throw e;
    }
  }

  return ctx.json(res, 405, { error: `${method} ${PREFIX}/:name is not supported` }), true;
}

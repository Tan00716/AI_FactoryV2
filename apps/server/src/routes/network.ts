/**
 * Network mode routes — the one-tap offline switch.
 *
 *   GET  /api/network/mode        { offline, updatedAt, updatedBy }
 *   POST /api/network/offline     { enabled: boolean } → flips the switch
 *
 * Every change is audited as NETWORK_MODE_CHANGED (actor 'human').
 * The env override FACTORY_NETWORK_OFFLINE=1 forces offline regardless
 * of the persisted file — the GET response reports both the persisted
 * state and the effective state so the UI never lies about which one
 * is in force.
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) already maps
 * GET → viewer and POST → operator for this prefix — flipping the
 * network switch is an operator action. No auth.ts change.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import {
  NETWORK_OFFLINE_ENV,
  networkMode,
  type NetworkModeStore,
} from '../network-mode';

const PREFIX = '/api/network';

/** Module singleton (lazy — mirrors scheduleStore's pattern). */
let store: NetworkModeStore | null = null;

function networkStore(): NetworkModeStore {
  if (!store) store = networkMode();
  return store;
}

/** Re-exported for tests: drop the cached store so the next call re-reads. */
export function resetNetworkRouteStoreForTests(): void {
  store = null;
}

export async function handleNetworkRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/network/mode
  if (method === 'GET' && path === `${PREFIX}/mode`) {
    const persisted = networkStore().get();
    const effective = networkStore().isOffline();
    const forced = (process.env[NETWORK_OFFLINE_ENV] ?? '').trim().length > 0;
    return ctx.json(res, 200, {
      offline: effective,
      persistedOffline: persisted.offline,
      envForced: forced,
      updatedAt: persisted.updatedAt,
      updatedBy: persisted.updatedBy,
    }), true;
  }

  // POST /api/network/offline { enabled: boolean }
  if (method === 'POST' && path === `${PREFIX}/offline`) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    if (typeof body['enabled'] !== 'boolean') {
      return ctx.json(res, 400, { error: 'enabled must be a boolean' }), true;
    }
    const forced = (process.env[NETWORK_OFFLINE_ENV] ?? '').trim().length > 0;
    const next = networkStore().setOffline(body['enabled'] as boolean, 'human');
    ctx.audit.record('human', 'NETWORK_MODE_CHANGED', 'network', 'mode', {
      offline: next.offline,
      envForced: forced,
    });
    return ctx.json(res, 200, {
      offline: networkStore().isOffline(),
      persistedOffline: next.offline,
      envForced: forced,
      updatedAt: next.updatedAt,
      updatedBy: next.updatedBy,
    }), true;
  }

  return false;
}

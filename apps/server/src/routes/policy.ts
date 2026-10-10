/**
 * Policy routes — spec §43 (Policy Engine), §44 (Permission Engine),
 * §98 (project.yaml), §99 (organization.yaml).
 *
 *  GET  /api/policy/effective?layer=project&project=MyApp&organization=Acme
 *       Resolve the effective policy for a scope (upper layers win;
 *       denied overrides are reported, never silent).
 *       Query: layer (required: global|organization|project|department|
 *       agent|task|tool) + scope ids (organization, project, department,
 *       agent, task, tool) selecting the document at each layer.
 *  POST /api/policy/validate  {kind: 'project'|'organization', yaml}
 *       Parse + validate a project.yaml / organization.yaml document.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handlePolicyRoutes } from './routes/policy';
 *   if (await handlePolicyRoutes(req, res, url, ctx)) return;
 *
 * PROTOTYPE NOTE: the PolicyStore is in-memory and module-local (empty
 * until policies are set through the package API); the coordinator may
 * seed it from stored project.yaml / organization.yaml documents later.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  GLOBAL_SCOPE_ID,
  POLICY_LAYERS,
  PolicyScope,
  parseOrganizationPolicy,
  parseProjectPolicy,
  PolicyStore,
} from '@ai-factory/policy';
import type { RouteContext } from './context';

/** In-memory prototype store — the coordinator may persist/seed this later. */
const store = new PolicyStore();

const SCOPE_ID_KEYS = ['organization', 'project', 'department', 'agent', 'task', 'tool'] as const;

export async function handlePolicyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/policy/')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/policy/'.length).split('/').filter(Boolean);

  // GET /api/policy/effective?layer=project&project=MyApp
  if (method === 'GET' && seg.length === 1 && seg[0] === 'effective') {
    const layer = url.searchParams.get('layer') ?? '';
    if (!(POLICY_LAYERS as readonly string[]).includes(layer)) {
      ctx.json(res, 400, {
        error: `layer must be one of: ${POLICY_LAYERS.join(', ')}`,
      });
      return true;
    }
    const scope: PolicyScope = { layer: layer as PolicyScope['layer'] };
    for (const key of SCOPE_ID_KEYS) {
      const v = url.searchParams.get(key);
      if (v) scope[key] = v;
    }
    const { policy, denials, attempts } = store.resolveEffectivePolicy(scope);
    ctx.audit.record('http', 'POLICY_EFFECTIVE_RESOLVED', 'policy_scope', layer, {
      layer,
      scopeIds: Object.fromEntries(SCOPE_ID_KEYS.map((k) => [k, scope[k] ?? null])),
      denialCount: denials.length,
    });
    ctx.json(res, 200, { scope, policy, denials, attemptCount: attempts.length });
    return true;
  }

  // POST /api/policy/validate  {kind: 'project'|'organization', yaml}
  if (method === 'POST' && seg.length === 1 && seg[0] === 'validate') {
    const body = await ctx.readBody(req);
    const kind = body['kind'] as string | undefined;
    const yaml = body['yaml'] as string | undefined;
    if (kind !== 'project' && kind !== 'organization') {
      ctx.json(res, 400, { error: `kind must be 'project' or 'organization'` });
      return true;
    }
    if (typeof yaml !== 'string' || yaml.trim() === '') {
      ctx.json(res, 400, { error: 'yaml must be a non-empty string' });
      return true;
    }
    const result = kind === 'project' ? parseProjectPolicy(yaml) : parseOrganizationPolicy(yaml);
    ctx.audit.record('http', 'POLICY_VALIDATED', 'policy_document', kind, {
      ok: result.ok,
      errorCount: result.errors.length,
    });
    ctx.json(res, 200, { kind, ok: result.ok, policy: result.policy ?? null, errors: result.errors });
    return true;
  }

  // GET /api/policy/layers — list the 7 layers + the prototype store contents
  if (method === 'GET' && seg.length === 1 && seg[0] === 'layers') {
    ctx.json(res, 200, {
      layers: POLICY_LAYERS,
      globalScopeId: GLOBAL_SCOPE_ID,
      eventCount: store.events.length,
    });
    return true;
  }

  return false;
}

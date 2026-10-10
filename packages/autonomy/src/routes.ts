/**
 * HTTP surface for @ai-factory/autonomy.
 *
 *   GET  /api/autonomy/mode?projectId=...   current project setting
 *   PUT  /api/autonomy/mode                {projectId, mode, updatedBy} → change setting
 *   POST /api/autonomy/verify-prod         {evidence} → independent §41 checklist verdict
 *
 * registerAutonomyRoutes(router, deps) takes a minimal structural router so
 * it works with any framework (Express-style, node:http, …). deps are all
 * optional — the module keeps its own in-memory store when none is passed.
 *
 * Adapting to the apps/server handle*Routes style (see routes/qa.ts):
 *
 *   const calls: Array<[string, string, AutonomyHandler]> = [];
 *   registerAutonomyRoutes({
 *     get: (p, h) => calls.push(['GET', p, h]),
 *     put: (p, h) => calls.push(['PUT', p, h]),
 *     post: (p, h) => calls.push(['POST', p, h]),
 *   }, { store });
 *   // then inside handleAutonomyRoutes: match method+pathname, build
 *   // { query, body }, call the handler, ctx.json(res, 200, result),
 *   // and map RouteError → ctx.json(res, err.status, { error: err.message }).
 */
import { decide } from './decide';
import { ProdReadinessEvidence, verifyProdReadiness } from './readiness';
import { ProjectAutonomyStore } from './store';
import { AutonomyMode, isAutonomyMode } from './types';

/** Normalized request handed to route handlers. */
export interface AutonomyHttpRequest {
  query: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}

/** A route handler: returns the JSON payload, or throws RouteError. */
export type AutonomyHandler = (
  req: AutonomyHttpRequest,
) => unknown | Promise<unknown>;

/** Minimal structural router — implement get/put/post with your framework. */
export interface AutonomyRouter {
  get(path: string, handler: AutonomyHandler): void;
  put(path: string, handler: AutonomyHandler): void;
  post(path: string, handler: AutonomyHandler): void;
}

/** All deps are optional ("deps 宽松"). */
export interface AutonomyRouteDeps {
  /** Project settings store; a module-level in-memory one is used by default. */
  store?: ProjectAutonomyStore;
  /** verifyProdReadiness implementation (injectable for tests). */
  verify?: typeof verifyProdReadiness;
  now?: () => number;
}

/** Error with an HTTP status; adapters map it to the response. */
export class RouteError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RouteError';
  }
}

const defaultStore = new ProjectAutonomyStore();

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function registerAutonomyRoutes(
  router: AutonomyRouter,
  deps: AutonomyRouteDeps = {},
): void {
  const store = deps.store ?? defaultStore;
  const verify = deps.verify ?? verifyProdReadiness;

  // GET /api/autonomy/mode?projectId=...
  router.get('/api/autonomy/mode', (req) => {
    const projectId = first(req.query['projectId']);
    if (!projectId) {
      throw new RouteError(400, 'query param projectId is required');
    }
    return { projectId, autonomy: store.get(projectId) };
  });

  // PUT /api/autonomy/mode  {projectId, mode, updatedBy?}
  router.put('/api/autonomy/mode', (req) => {
    const body = req.body ?? {};
    const projectId = body['projectId'];
    const mode = body['mode'];
    const updatedBy =
      typeof body['updatedBy'] === 'string' ? body['updatedBy'] : 'human';
    if (typeof projectId !== 'string' || !projectId) {
      throw new RouteError(400, 'body.projectId is required');
    }
    if (!isAutonomyMode(mode)) {
      throw new RouteError(
        400,
        `body.mode must be one of: assisted, semi, autonomous, full (got ${String(mode)})`,
      );
    }
    const autonomy = store.set(projectId, mode as AutonomyMode, updatedBy);
    return { projectId, autonomy };
  });

  // POST /api/autonomy/verify-prod  {evidence, projectId?, action?}
  // Independent §41 checklist — used by coordinators before any prod deploy,
  // in EVERY mode including full.
  router.post('/api/autonomy/verify-prod', (req) => {
    const body = req.body ?? {};
    const evidence = body['evidence'] as ProdReadinessEvidence | undefined;
    if (!evidence || typeof evidence !== 'object') {
      throw new RouteError(400, 'body.evidence is required');
    }
    const verdict = verify(evidence, { now: deps.now });
    const action = typeof body['action'] === 'string' ? body['action'] : 'deploy-prod';
    const modeRaw = body['mode'];
    const mode: AutonomyMode = isAutonomyMode(modeRaw) ? modeRaw : 'full';
    return {
      verdict,
      decision: decide(action, mode, { now: deps.now }),
      blocked: !verdict.ready,
    };
  });
}

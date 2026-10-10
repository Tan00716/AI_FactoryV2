/**
 * Coordination HTTP routes — spec §61–§63.
 *
 *  POST /api/coordination/schedule   {tasks, edges?, maxConcurrency?} → batches
 *  POST /api/coordination/overlap    {agentA, agentB, strategy?} → report + plan
 *
 * Style mirrors apps/server/src/routes/qa.ts (handleXxxRoutes predicate
 * handler). Deps are deliberately loose: the coordinator only supplies a
 * registration function and optional route deps.
 */

import {
  detectOverlap,
  mergeCheck,
  resolveOverlap,
  ResolutionStrategy,
  OverlapReport,
} from './overlap';
import {
  schedule,
  ScheduleCycleError,
  ScheduleEdge,
  ScheduleEdgeKind,
  ScheduleInput,
} from './schedule';
import { LockEvent, LockManager } from './locks';

/** Minimal context the coordinator must provide (matches qa.ts ctx shape). */
export interface CoordinationRouteContext {
  json: (res: unknown, status: number, body: unknown) => void;
  readBody: (req: unknown) => Promise<Record<string, unknown>>;
}

export interface CoordinationRouteDeps {
  maxConcurrency?: number;
  /** Shared LockManager instance; one is created per registration if omitted. */
  locks?: LockManager;
  /** Audit hook forwarded to the LockManager. */
  audit?: (event: LockEvent) => void;
}

export type CoordinationHandler = (
  req: unknown,
  res: unknown,
  url: URL,
  ctx: CoordinationRouteContext,
) => Promise<boolean>;

const EDGE_KINDS: ReadonlySet<string> = new Set([
  'depends_on',
  'blocked_by',
  'parallel_with',
  'child_of',
  'related_to',
]);

function parseScheduleBody(body: Record<string, unknown>, deps: CoordinationRouteDeps): ScheduleInput & { maxConcurrency?: number } {
  const tasks = body['tasks'];
  if (!Array.isArray(tasks) || !tasks.every((t) => typeof t === 'string')) {
    throw new HttpError(400, 'tasks must be an array of task id strings');
  }
  const edges: ScheduleEdge[] = [];
  const rawEdges = body['edges'];
  if (rawEdges !== undefined) {
    if (!Array.isArray(rawEdges)) throw new HttpError(400, 'edges must be an array');
    for (const e of rawEdges) {
      const edge = e as Record<string, unknown>;
      if (
        typeof edge?.['from'] !== 'string' ||
        typeof edge?.['to'] !== 'string' ||
        typeof edge?.['kind'] !== 'string' ||
        !EDGE_KINDS.has(edge['kind'] as string)
      ) {
        throw new HttpError(
          400,
          `each edge needs {from, to, kind} with kind in: ${[...EDGE_KINDS].join(', ')}`,
        );
      }
      edges.push({
        from: edge['from'] as string,
        to: edge['to'] as string,
        kind: edge['kind'] as ScheduleEdgeKind,
      });
    }
  }
  const maxConcurrency =
    body['maxConcurrency'] !== undefined
      ? Number(body['maxConcurrency'])
      : deps.maxConcurrency;
  if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1)) {
    throw new HttpError(400, 'maxConcurrency must be a positive integer');
  }
  return { tasks: tasks as string[], edges, maxConcurrency };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function handleCoordinationRoutes(
  req: unknown,
  res: unknown,
  url: URL,
  ctx: CoordinationRouteContext,
  deps: CoordinationRouteDeps = {},
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/coordination/')) return false;
  const method = ((req as { method?: string }).method ?? 'GET').toUpperCase();
  const seg = path.slice('/api/coordination/'.length).split('/').filter(Boolean);

  // POST /api/coordination/schedule  {tasks, edges?, maxConcurrency?}
  if (method === 'POST' && seg.length === 1 && seg[0] === 'schedule') {
    try {
      const body = await ctx.readBody(req);
      const { tasks, edges, maxConcurrency } = parseScheduleBody(body, deps);
      const result = schedule({ tasks, edges }, { maxConcurrency });
      ctx.json(res, 200, {
        batches: result.batches,
        level: result.level,
        batchCount: result.batches.length,
      });
    } catch (err) {
      if (err instanceof ScheduleCycleError) {
        ctx.json(res, 409, { error: err.message, cycle: err.cycle });
      } else if (err instanceof HttpError) {
        ctx.json(res, err.status, { error: err.message });
      } else {
        ctx.json(res, 400, { error: (err as Error).message });
      }
    }
    return true;
  }

  // POST /api/coordination/overlap  {agentA, agentB, strategy?, runTests?}
  if (method === 'POST' && seg.length === 1 && seg[0] === 'overlap') {
    const body = await ctx.readBody(req);
    const agentA = body['agentA'];
    const agentB = body['agentB'];
    if (
      !Array.isArray(agentA) ||
      !agentA.every((f) => typeof f === 'string') ||
      !Array.isArray(agentB) ||
      !agentB.every((f) => typeof f === 'string')
    ) {
      ctx.json(res, 400, { error: 'agentA and agentB must be arrays of file path strings' });
      return true;
    }
    const rawStrategy = body['strategy'];
    const strategies: readonly string[] = ['warn', 'serialize', 'partition', 'merge_test'];
    const strategy: ResolutionStrategy =
      typeof rawStrategy === 'string' && (strategies as readonly string[]).includes(rawStrategy)
        ? (rawStrategy as ResolutionStrategy)
        : 'warn';

    const report: OverlapReport = detectOverlap(agentA as string[], agentB as string[]);
    const plan = resolveOverlap(report, strategy);
    // mergeCheck gating: never release overlapped files without a test hook.
    // runTests=true simulates the post-merge test hook; absent → blocked.
    const verdict = mergeCheck(
      report,
      body['runTests'] === true ? () => true : undefined,
    );
    ctx.json(res, 200, {
      hasOverlap: report.hasOverlap,
      overlaps: report.overlaps,
      plan,
      merge: verdict,
    });
    return true;
  }

  return false;
}

/**
 * Register coordination routes with the coordinator.
 *
 * The coordinator passes a registration function (e.g. one that stores the
 * predicate handler alongside the other route handlers, like
 * `handleQaRoutes` from apps/server/src/routes/qa.ts) plus loose deps.
 */
export function registerCoordinationRoutes(
  register: (handler: CoordinationHandler) => void,
  deps: CoordinationRouteDeps = {},
): void {
  const locks = deps.locks ?? new LockManager({ audit: deps.audit });
  register((req, res, url, ctx) => handleCoordinationRoutes(req, res, url, ctx, { ...deps, locks }));
}

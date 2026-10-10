/**
 * Factory control routes — SPEC v2 §24.
 *
 *   GET  /api/factory/status              3-axis status (ACK-gated display)
 *   POST /api/factory/control             {operation, requested_by, scope, mode?}
 *   POST /api/factory/workers             {worker_id} → register
 *   DELETE /api/factory/workers/:id       unregister
 *   POST /api/factory/ack                WorkerAck
 *   POST /api/factory/health              {health: HEALTHY|DEGRADED|RECOVERING}
 *   POST /api/factory/capacity            {capacity: AVAILABLE|QUOTA_LIMITED|RESOURCE_LIMITED}
 *   GET  /api/factory/semantics           §24.2 operation matrix + prohibitions
 *
 * The coordinator wires this in: handleFactoryControlRoutes(req, res, url, ctx).
 * NOTE: apps/server/src/index.ts is not touched by this module's author;
 * the coordinator must call this handler in the dispatch chain.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ControlError,
  FactoryController,
  OPERATION_SEMANTICS,
  type CapacityState,
  type ControlOperation,
  type HealthState,
  type WorkerAck,
} from '@ai-factory/factory-control';
import type { RouteContext } from './context';

const PREFIX = '/api/factory';

const controller = new FactoryController();

const OPERATIONS: ControlOperation[] = [
  'START',
  'PAUSE_NEW_WORK',
  'PAUSE_AI_WORK',
  'FREEZE',
  'RESUME',
  'DRAIN',
  'GRACEFUL_STOP',
  'EMERGENCY_STOP',
];

export async function handleFactoryControlRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  if (method === 'GET' && path === `${PREFIX}/status`) {
    return ctx.json(res, 200, controller.status()), true;
  }

  if (method === 'GET' && path === `${PREFIX}/semantics`) {
    return ctx.json(res, 200, {
      operations: OPERATION_SEMANTICS,
      prohibitions: controller.prohibitions(),
      defaultPause: 'PAUSE_NEW_WORK',
    }), true;
  }

  if (method === 'POST' && path === `${PREFIX}/control`) {
    const body = await ctx.readBody(req);
    const operation = body['operation'];
    const requested_by = body['requested_by'];
    const scope = body['scope'];
    if (!OPERATIONS.includes(operation as ControlOperation)) {
      return ctx.json(res, 400, { error: `operation must be one of ${OPERATIONS.join(', ')}` }), true;
    }
    if (typeof requested_by !== 'string' || typeof scope !== 'string') {
      return ctx.json(res, 400, { error: 'requested_by and scope are required' }), true;
    }
    try {
      const epoch = controller.request(operation as ControlOperation, {
        requested_by,
        scope,
        mode: typeof body['mode'] === 'string' ? (body['mode'] as string) : undefined,
      });
      return ctx.json(res, 200, { control_epoch: epoch, status: controller.status() }), true;
    } catch (e) {
      if (e instanceof ControlError) {
        const status = e.reasonCode === 'UNAUTHORIZED' ? 403 : 400;
        return ctx.json(res, status, { error: e.message, reasonCode: e.reasonCode }), true;
      }
      throw e;
    }
  }

  if (method === 'POST' && path === `${PREFIX}/workers`) {
    const body = await ctx.readBody(req);
    const worker_id = body['worker_id'];
    if (typeof worker_id !== 'string' || !worker_id) {
      return ctx.json(res, 400, { error: 'worker_id is required' }), true;
    }
    controller.registerWorker(worker_id);
    return ctx.json(res, 201, { registered: worker_id }), true;
  }

  const unregMatch = path.match(new RegExp(`^${PREFIX}/workers/([^/]+)$`));
  if (method === 'DELETE' && unregMatch) {
    controller.unregisterWorker(decodeURIComponent(unregMatch[1]));
    return ctx.json(res, 200, { unregistered: true }), true;
  }

  if (method === 'POST' && path === `${PREFIX}/ack`) {
    const body = await ctx.readBody(req);
    const ack = body as Partial<WorkerAck>;
    if (typeof ack.worker_id !== 'string' || typeof ack.control_epoch !== 'number') {
      return ctx.json(res, 400, { error: 'worker_id and control_epoch are required' }), true;
    }
    controller.ack({
      worker_id: ack.worker_id,
      control_epoch: ack.control_epoch,
      stopped_at: typeof ack.stopped_at === 'string' ? ack.stopped_at : '',
      active_tools: Array.isArray(ack.active_tools) ? (ack.active_tools as string[]) : [],
      live_processes: Array.isArray(ack.live_processes) ? (ack.live_processes as number[]) : [],
      acked_at: '',
    });
    return ctx.json(res, 200, controller.status()), true;
  }

  if (method === 'POST' && path === `${PREFIX}/health`) {
    const body = await ctx.readBody(req);
    const health = body['health'];
    if (!['HEALTHY', 'DEGRADED', 'RECOVERING'].includes(health as string)) {
      return ctx.json(res, 400, { error: 'health must be HEALTHY|DEGRADED|RECOVERING' }), true;
    }
    controller.setHealth(health as HealthState);
    return ctx.json(res, 200, controller.status()), true;
  }

  if (method === 'POST' && path === `${PREFIX}/capacity`) {
    const body = await ctx.readBody(req);
    const capacity = body['capacity'];
    if (!['AVAILABLE', 'QUOTA_LIMITED', 'RESOURCE_LIMITED'].includes(capacity as string)) {
      return ctx.json(res, 400, { error: 'capacity must be AVAILABLE|QUOTA_LIMITED|RESOURCE_LIMITED' }), true;
    }
    controller.setCapacity(capacity as CapacityState);
    return ctx.json(res, 200, controller.status()), true;
  }

  return false;
}

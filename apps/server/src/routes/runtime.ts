/**
 * Agent Runtime routes — spec §24–§27.
 *
 *  POST /api/runtime/runs        {agentId, taskId, script?, routeRequest?}
 *                               → executes an agent loop with the StubAdapter
 *  GET  /api/runtime/runs        list runs (in-memory)
 *  GET  /api/runtime/runs/:id    one run
 *
 * PROTOTYPE NOTE: runs use the scripted StubAdapter (no real LLM). `script`
 * is an array of {text, toolCalls[]} adapter outputs; when omitted, a
 * default 3-step script completes the run. Tool calls are executed against
 * a tiny safe toolset (echo/add) inside the harness filesystem boundary.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleRuntimeRoutes } from './routes/runtime';
 *   if (await handleRuntimeRoutes(req, res, url, ctx)) return;
 */
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  AgentLoop,
  Harness,
  StubAdapter,
  runAgent,
} from '@ai-factory/runtime';
import type { RouteContext } from './context';

export interface RuntimeRunRecord {
  id: string;
  agentId: string;
  taskId: string;
  status: 'RUNNING' | 'COMPLETED' | 'ESCALATED' | 'FAILED';
  outcome: string | null;
  steps: number;
  evidence: unknown[];
  handoffs: string[];
  trace: unknown[];
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}

/** In-memory run store — the coordinator may persist this later. */
const runs = new Map<string, RuntimeRunRecord>();

/** Accessor for the Activity/run-detail aggregation (§67–§68). */
export function listRuntimeRuns(): RuntimeRunRecord[] {
  return [...runs.values()];
}

export function getRuntimeRun(id: string): RuntimeRunRecord | undefined {
  return runs.get(id);
}

const DEFAULT_SCRIPT = [
  { text: 'observing task', toolCalls: [] },
  { text: 'acting', toolCalls: [{ tool: 'echo', args: { msg: 'hello' } }] },
  { text: 'verifying', toolCalls: [] },
];

function slim(r: RuntimeRunRecord) {
  return r;
}

export async function handleRuntimeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith('/api/runtime/')) return false;

  if (method === 'GET' && path === '/api/runtime/runs') {
    return ctx.json(res, 200, { runs: [...runs.values()].map(slim) }), true;
  }

  const one = path.match(/^\/api\/runtime\/runs\/([^/]+)$/);
  if (method === 'GET' && one) {
    const r = runs.get(one[1]);
    if (!r) return ctx.json(res, 404, { error: 'run not found' }), true;
    return ctx.json(res, 200, slim(r)), true;
  }

  if (method === 'POST' && path === '/api/runtime/runs') {
    const b = await ctx.readBody(req);
    const agentId = b['agentId'];
    const taskId = b['taskId'];
    if (typeof agentId !== 'string' || typeof taskId !== 'string') {
      ctx.json(res, 400, { error: 'agentId and taskId are required' });
      return true;
    }
    let agent;
    let task;
    try {
      agent = ctx.agents.get(agentId);
    } catch {
      ctx.json(res, 404, { error: 'agent not found' });
      return true;
    }
    try {
      task = ctx.tasks.get(taskId);
    } catch {
      ctx.json(res, 404, { error: 'task not found' });
      return true;
    }

    const id = randomUUID();
    const rec: RuntimeRunRecord = {
      id,
      agentId,
      taskId,
      status: 'RUNNING',
      outcome: null,
      steps: 0,
      evidence: [],
      handoffs: [],
      trace: [],
      createdAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    runs.set(id, rec);
    // §91 — agent runs are first-class bus events.
    ctx.bus.emit(
      'RUN_STARTED',
      { runId: id, agentId, taskId, agent: agent.displayName },
      'runtime',
    );

    // Run async; the record is updated on completion. Prototype only.
    void (async () => {
      try {
        const script = Array.isArray(b['script'])
          ? (b['script'] as Array<{ text: string; toolCalls: Array<{ tool: string; args: unknown }> }>)
          : DEFAULT_SCRIPT;
        const sandbox = join(tmpdir(), `ai-factory-run-${id}`);
        const harness = new Harness({
          allowedRoots: [sandbox],
          stepTimeoutMs: 5000,
          permissions: agent.permissions,
          evidence: {
            collect: (e) => {
              rec.evidence.push(e);
            },
          },
          onAudit: (event) => {
            ctx.audit.record(
              agentId,
              'RUNTIME_' + event.action.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
              'runtime_run',
              id,
              { detail: event.detail },
            );
          },
        });
        const result = await runAgent({
          agent,
          task,
          harness,
          // §28.1 (G-59) — intents go to the coordinator-injected store:
          // SQLite-backed in this server, so they survive restarts and
          // the next boot's startup scan can see what a dead process
          // left uncommitted. (runAgent's own default remains a fresh
          // in-memory store for embedders that inject none.)
          intentStore: ctx.stepIntentStore,
          adapter: new StubAdapter(script),
          loop: new AgentLoop({
            budgets: { maxSteps: 40, timeMs: 60000, maxRetries: 3 },
          }),
          tools: {
            echo: async (args) => ({ ok: true, echo: (args as { msg?: string }).msg ?? '' }),
            add: async (args) => {
              const a = args as { a?: number; b?: number };
              return { ok: true, sum: (a.a ?? 0) + (a.b ?? 0) };
            },
          },
          routeRequest:
            b['routeRequest'] != null
              ? (b['routeRequest'] as never)
              : undefined,
        });
        rec.status =
          result.outcome === 'completed'
            ? 'COMPLETED'
            : result.outcome === 'escalated'
              ? 'ESCALATED'
              : 'FAILED';
        rec.outcome = result.outcome;
        rec.steps = result.steps;
        rec.trace = result.trace;
        rec.handoffs = result.handoffs;
        rec.finishedAt = new Date().toISOString();
        // §91 — the finishing step of every run is on the bus.
        ctx.bus.emit(
          'RUN_STEP',
          {
            runId: id,
            agentId,
            taskId,
            phase: 'FINISH',
            outcome: result.outcome,
            steps: result.steps,
          },
          'runtime',
        );
      } catch (e) {
        rec.status = 'FAILED';
        rec.error = e instanceof Error ? e.message : String(e);
        rec.finishedAt = new Date().toISOString();
        ctx.bus.emit(
          'RUN_STEP',
          { runId: id, agentId, taskId, phase: 'FINISH', outcome: 'failed', error: rec.error },
          'runtime',
        );
      }
    })();

    return ctx.json(res, 202, { id, status: 'RUNNING' }), true;
  }

  return false;
}

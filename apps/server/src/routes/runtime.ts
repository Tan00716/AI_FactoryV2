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
 * default 3-step script completes the run.
 *
 * TOOL PERMISSIONS (§26, fail-closed): this route registers a tiny safe
 * toolset (echo/add — pure in-process functions with no filesystem,
 * shell, git or network effects), but registration is NOT a grant. The
 * harness permission gate denies every tool that has no tool→permission
 * mapping, and echo/add have none by default — so out of the box an HTTP
 * run executes NO tools and persists NO step intents (the gate fires
 * before the intent write). The operator opts tools in explicitly via
 * the FACTORY_RUNTIME_TOOLS env allowlist (comma-separated tool names;
 * unset/empty = no tools granted): each allowlisted tool is granted for
 * the run through the harness's toolPermissions override, and every
 * run's grant is written to the audit log (RUNTIME_RUN_STARTED, with the
 * grantedTools list). An allowlist entry naming an unregistered tool is
 * a configuration error — refused at startup (index.ts) and rejected
 * per request with an audit record, never silently ignored.
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
  type ToolImpl,
} from '@ai-factory/runtime';
import type { Permission } from '@ai-factory/core';
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

/**
 * The tools this route can execute. Registration is not a grant — see
 * the header note. The implementations are pure in-process functions:
 * no filesystem, shell, git or network effects, which is why the grant
 * below can hang them on the least-privilege read-only capability.
 */
const RUNTIME_TOOLS: Record<string, ToolImpl> = {
  echo: async (args) => ({ ok: true, echo: (args as { msg?: string }).msg ?? '' }),
  add: async (args) => {
    const a = args as { a?: number; b?: number };
    return { ok: true, sum: (a.a ?? 0) + (a.b ?? 0) };
  },
};

/** Names of the tools registered above — the allowlist's whole universe. */
export const RUNTIME_TOOL_NAMES: readonly string[] = Object.keys(RUNTIME_TOOLS);

/** Env var carrying the operator's tool allowlist for HTTP runs. */
export const RUNTIME_TOOLS_ENV = 'FACTORY_RUNTIME_TOOLS';

/**
 * The capability a whitelisted tool is granted under. echo/add are pure
 * functions, so the grant hangs them on 'filesystem.read' — the
 * read-only floor every role default already holds — purely as the
 * capability token the harness gate checks (the same admission pattern
 * the server tests used before this allowlist existed). The route adds
 * this permission to the harness's permission set for a run ONLY when
 * at least one tool is allowlisted, and only tools present in
 * RUNTIME_TOOLS can ever be invoked — the runner refuses a tool call
 * with no implementation before the gate is even consulted — so the
 * grant cannot widen into real filesystem access through this route.
 */
const RUNTIME_TOOL_GRANT_PERMISSION: Permission = 'filesystem.read';

/**
 * Parse FACTORY_RUNTIME_TOOLS: comma-separated tool names, whitespace
 * tolerated, duplicates collapsed. Unset/empty/blank = empty allowlist
 * = no tool is granted (the pre-allowlist behavior, fail-closed).
 */
export function resolveRuntimeToolAllowlist(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env[RUNTIME_TOOLS_ENV];
  if (raw === undefined) return [];
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set(names)];
}

/** Allowlist entries that name no registered tool of this route. */
export function unknownRuntimeTools(allowlist: readonly string[]): string[] {
  return allowlist.filter((n) => !RUNTIME_TOOL_NAMES.includes(n));
}

/**
 * Startup policy, mirroring auth.ts's startupAuthError: a fatal message
 * when the allowlist names unregistered tools (an operator typo must
 * refuse startup rather than silently grant a different tool set than
 * configured), or null when startup may proceed.
 */
export function runtimeToolsStartupError(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const unknown = unknownRuntimeTools(resolveRuntimeToolAllowlist(env));
  if (unknown.length === 0) return null;
  return (
    `[ai-factory] FATAL: ${RUNTIME_TOOLS_ENV} names unregistered tool(s): ` +
    `${unknown.join(', ')}. Registered runtime tools: ${RUNTIME_TOOL_NAMES.join(', ')}. ` +
    `Fix or unset ${RUNTIME_TOOLS_ENV}.`
  );
}

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

    // §26 — resolve the operator tool allowlist for this run. An entry
    // naming an unregistered tool is a configuration error: audit it
    // and refuse the run (500) instead of silently granting less than
    // the operator configured. Startup refuses this state too
    // (runtimeToolsStartupError, wired in index.ts); the per-request
    // check keeps the route fail-closed when used standalone.
    const allowlist = resolveRuntimeToolAllowlist();
    const unknownTools = unknownRuntimeTools(allowlist);
    if (unknownTools.length > 0) {
      ctx.audit.record(
        agentId,
        'RUNTIME_TOOLS_CONFIG_ERROR',
        'runtime_config',
        RUNTIME_TOOLS_ENV,
        {
          actor: agentId,
          agentId,
          taskId,
          allowlist,
          unknownTools,
          registeredTools: [...RUNTIME_TOOL_NAMES],
        },
      );
      ctx.json(res, 500, {
        error:
          `${RUNTIME_TOOLS_ENV} names unregistered tool(s): ${unknownTools.join(', ')} ` +
          `(registered: ${RUNTIME_TOOL_NAMES.join(', ')})`,
      });
      return true;
    }
    const grantedTools = allowlist;

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
    // §26 — every run's tool grant is on the audit record: which tools
    // the operator allowlist granted this run (possibly none). Tool
    // executions and denials are audited separately through the
    // harness onAudit hook below and the run's intent/evidence records.
    ctx.audit.record(agentId, 'RUNTIME_RUN_STARTED', 'runtime_run', id, {
      runId: id,
      actor: agentId,
      agentId,
      taskId,
      grantedTools,
    });

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
          // §26 — the allowlist grant: when at least one tool is
          // granted, the grant capability joins this run's permission
          // set (the agent's own permissions are never mutated, and
          // with no grant this is exactly agent.permissions, as before).
          permissions:
            grantedTools.length > 0 &&
            !agent.permissions.includes(RUNTIME_TOOL_GRANT_PERMISSION)
              ? [...agent.permissions, RUNTIME_TOOL_GRANT_PERMISSION]
              : agent.permissions,
          // §26 — each granted tool is mapped to the grant capability
          // via the harness's supported toolPermissions override. No
          // allowlist → no override → the gate denies every tool,
          // exactly as before this mechanism existed.
          ...(grantedTools.length > 0
            ? {
                toolPermissions: Object.fromEntries(
                  grantedTools.map((t) => [t, RUNTIME_TOOL_GRANT_PERMISSION]),
                ),
              }
            : {}),
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
          tools: RUNTIME_TOOLS,
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

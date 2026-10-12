/**
 * Agent Runtime routes — spec §24–§27.
 *
 *  POST /api/runtime/runs        {agentId, taskId, script?, routeRequest?}
 *                               → executes an agent loop with the StubAdapter
 *  GET  /api/runtime/runs        list runs
 *  GET  /api/runtime/runs/:id    one run
 *  GET  /api/runtime/runs/:id/checkpoints         the run's §28.3 checkpoints
 *  GET  /api/runtime/runs/:id/checkpoints/latest  the resume point
 *
 * RUN RECORDS (walkthrough F4): run records live in a RuntimeRunStore
 * (see @ai-factory/db — the seam sits there because this record is the
 * route's HTTP projection, not a runtime domain type). The module
 * default is in-memory; the coordinator installs the SQLite store
 * (FactoryDatabase.runs) at startup via setRuntimeRunStore, so in the
 * real server a run's record survives restarts — GET after a restart
 * no longer 404s a run whose intents and evidence were already durable.
 * The route persists at EVERY record change (creation, each evidence
 * append, the terminal write, the error write), so a process that dies
 * mid-run leaves its last persisted state behind — possibly still
 * RUNNING, which is the honest record of an interrupted run.
 *
 * CHECKPOINTS (§28.3, Batch 13): the run path is now the first
 * production consumer of the runtime CheckpointLog. The AgentLoop the
 * route builds carries an onTrace callback (createRunCheckpointCapture
 * below): AgentLoop.run() records a trace entry exactly once per
 * executed phase step — after its step counter increments, before any
 * decision handling — so the callback IS a step boundary of the run's
 * state machine, and each firing captures one CheckpointV2 into the
 * installed log (SQLite in this server, via setRuntimeCheckpointLog —
 * the same install pattern as the run store). Fields are assembled
 * from the run's live facts (see assembleRunCheckpoint): agent/task
 * re-read at capture time, budget usage from the run's real
 * BudgetTracker, active tools from the run's committed step intents,
 * pending approvals from the approvals store. What this path does not
 * have stays absent or truthfully empty: no model session, no
 * workspace snapshot, no git operation, no lease (generation 0 = no
 * lease held), no child processes, no external side effects. Read
 * surface: GET /api/runtime/runs/:id/checkpoints and .../latest —
 * the recovery entry point. Nothing auto-resumes: a restart serves
 * the checkpoints of an interrupted run back as its recovery point
 * and leaves the decision to a human/controller (§28.4).
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
 * run executes NO tools (a denied call persists a DENIED step intent,
 * §28.1, but the tool itself never runs). The operator opts tools in explicitly via
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
import { createHash, randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  AgentLoop,
  CheckpointLog,
  Harness,
  StubAdapter,
  runAgent,
  type CheckpointV2,
  type ToolImpl,
  type TraceStep,
} from '@ai-factory/runtime';
import type { Agent, Permission, Task } from '@ai-factory/core';
import {
  InMemoryRuntimeRunStore,
  type RuntimeRunRecord,
  type RuntimeRunStore,
} from '@ai-factory/db';
import type { RouteContext } from './context';

// The record type is owned by @ai-factory/db (see the header note);
// re-exported so existing imports from this module keep working.
export type { RuntimeRunRecord } from '@ai-factory/db';

/**
 * The active run-record store. Module-level because the registry
 * itself is module-level: the Activity aggregation (§67–§68) reads it
 * through the accessors below, across route modules. Starts as the
 * in-memory default (standalone use, tests); the coordinator replaces
 * it with the SQLite store at startup.
 */
let runStore: RuntimeRunStore = new InMemoryRuntimeRunStore();

/**
 * Install the run-record store. Called once by the coordinator
 * (apps/server/src/index.ts) with FactoryDatabase.runs before the
 * server takes traffic; embedders and tests may install their own.
 */
export function setRuntimeRunStore(store: RuntimeRunStore): void {
  runStore = store;
}

/** Accessor for the Activity/run-detail aggregation (§67–§68). */
export function listRuntimeRuns(): RuntimeRunRecord[] {
  return runStore.list();
}

export function getRuntimeRun(id: string): RuntimeRunRecord | undefined {
  return runStore.get(id);
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

/* ------------------------------------------------------------------ */
/* Checkpoints (§28.3) — the run path's capture + read surface          */
/* ------------------------------------------------------------------ */

/**
 * The active checkpoint log. Module-level for the same reason as the
 * run registry above: the coordinator installs the durable log
 * (CheckpointLog over FactoryDatabase.checkpoints) at startup via
 * setRuntimeCheckpointLog; the default is a fresh in-memory log
 * (standalone use, tests — wiring only, no durability).
 */
let checkpointLog: CheckpointLog = new CheckpointLog();

/**
 * Install the checkpoint log. Called once by the coordinator
 * (apps/server/src/index.ts) before the server takes traffic, with
 * the same CheckpointLog its /api/health block counts — so the health
 * count is the live count of what this route captures and serves.
 */
export function setRuntimeCheckpointLog(log: CheckpointLog): void {
  checkpointLog = log;
}

/** Every checkpoint captured for one run, in first-capture order. */
export function listRuntimeCheckpoints(runId: string): CheckpointV2[] {
  return checkpointLog.list(runId);
}

/** The resume entry point for one run: its highest-position capture. */
export function latestRuntimeCheckpoint(runId: string): CheckpointV2 | undefined {
  return checkpointLog.latest(runId);
}

/**
 * §28.3 — the workflow version stamped on every HTTP-run checkpoint.
 * The workflow an HTTP run executes is the runtime AgentLoop's phase
 * machine (§24: OBSERVE → UNDERSTAND → PLAN → ACT → VERIFY →
 * EVALUATE); its resumable-state format is the loop's checkpoint
 * token, version 1 (packages/runtime/src/loop.ts, CheckpointState.v).
 * Bump this when the phase set or the token format changes.
 */
export const RUN_WORKFLOW_VERSION = 'agent-loop@1';

/** The live facts one step-boundary capture is assembled from. */
export interface RunCheckpointFacts {
  runId: string;
  stepPosition: number;
  agent: Agent;
  task: Task;
  grantedTools: readonly string[];
  /** The run BudgetTracker's usage at capture time (all numbers). */
  budgetUsage: Record<string, number>;
  /** Tools this run has actually engaged so far (see the factory). */
  activeTools: string[];
  /** approval_ids of the task's PENDING approvals at capture time. */
  pendingApprovals: string[];
}

/**
 * §28.3 — assemble the capture input for one step boundary of an HTTP
 * run from its real facts. Pure: every fact is collected by the caller
 * (createRunCheckpointCapture), so this is the single place that
 * decides what the fields MEAN on this run path:
 *
 *  - taskVersion: the task's real current revision marker — the v2
 *    engine's optimistic-concurrency counter when the task carries
 *    one, else the task row's updatedAt (TaskManager bumps it on
 *    every mutation). Either way a resume can tell whether the task
 *    changed underneath the checkpoint.
 *  - contextManifestHash: sha256 over exactly the inputs the runner
 *    assembles the run's context from (buildPrompt: agent name /
 *    jobTitle / mission, task title / goal / acceptance criteria)
 *    plus the run's tool surface (granted + registered tools). The
 *    manifest itself is hashed, never stored.
 *  - modelSessionRef / workspaceSnapshotHash / gitBase /
 *    gitCandidate stay ABSENT: this path invokes its adapter
 *    statelessly, takes no workspace snapshot (the sandbox is a
 *    scratch tmpdir and its tools write nothing) and performs no git
 *    operation. Absent, not invented.
 *  - activeProcesses is []: the path spawns no child processes; its
 *    tools are pure in-process functions.
 *  - leaseGeneration / fencingToken are 0: this path acquires no
 *    workspace lease, and 0 is the recorded "no lease held" value.
 *  - pendingSideEffects is []: runs on this path prepare no external
 *    operations (the OperationLedger is never touched by a run).
 */
export function assembleRunCheckpoint(
  facts: RunCheckpointFacts,
): Omit<CheckpointV2, 'schemaVersion' | 'capturedAt'> {
  const { agent, task } = facts;
  const taskVersion =
    task.v2?.taskVersion !== undefined
      ? `task-v2@${task.v2.taskVersion}`
      : `task@${task.updatedAt}`;
  const contextManifestHash = createHash('sha256')
    .update(
      JSON.stringify({
        agentId: agent.id,
        agentName: agent.name,
        jobTitle: agent.jobTitle,
        mission: agent.mission,
        taskId: task.id,
        title: task.title,
        goal: task.goal,
        acceptanceCriteria: task.acceptanceCriteria,
        grantedTools: [...facts.grantedTools].sort(),
        registeredTools: [...RUNTIME_TOOL_NAMES].sort(),
      }),
      'utf8',
    )
    .digest('hex');
  return {
    runId: facts.runId,
    stepPosition: facts.stepPosition,
    workflowVersion: RUN_WORKFLOW_VERSION,
    taskVersion,
    contextManifestHash,
    activeTools: facts.activeTools,
    activeProcesses: [],
    leaseGeneration: 0,
    fencingToken: 0,
    pendingApprovals: facts.pendingApprovals,
    budgetUsage: facts.budgetUsage,
    pendingSideEffects: [],
    resumePreconditions: [
      `task ${task.id} must still exist at ${taskVersion}`,
      `agent ${agent.id} must still be registered`,
      'PENDING step intents of this run must be reconciled before resume (§28.1/§28.2 — never blind-replay)',
      'no automatic resume: recovery is manual/controlled (§28.4)',
    ],
  };
}

export interface RunCheckpointCaptureDeps {
  ctx: RouteContext;
  runId: string;
  agentId: string;
  taskId: string;
  /** POST-time snapshots: the fallback when a live re-read fails. */
  agentSnapshot: Agent;
  taskSnapshot: Task;
  grantedTools: readonly string[];
  harness: Harness;
}

/**
 * §28.3 — build the AgentLoop onTrace callback that captures one
 * checkpoint per executed step of an HTTP run.
 *
 * Why onTrace is a real step boundary: AgentLoop.run() calls its
 * recordTrace exactly once per executed phase step — after the step
 * counter increments and the phase result is known, before decision
 * handling (loop.ts). A firing therefore means "this step has
 * executed", firings arrive in step order, and counting them gives
 * the loop's own step position. A step whose failure then throws out
 * of the loop (budget/stagnation) has already been traced, so its
 * checkpoint exists too — the last checkpoint of a dead run is the
 * last step it actually executed.
 *
 * Facts are collected live at each firing: agent/task re-read from
 * their stores (falling back to the POST-time snapshots if one was
 * deleted mid-run), budget usage from the run's real BudgetTracker
 * (runAgent attaches it to the harness before the loop starts),
 * active tools from the run's step intents in the shared intent store
 * (a DENIED intent's tool never ran, so it is not "active"; every
 * other committed or in-flight intent's tool is), pending approvals
 * from the approvals store for this task.
 *
 * A failed capture never fails the run it describes: the error is
 * audited (RUNTIME_CHECKPOINT_FAILED) and the run continues — the
 * alternative would let a checkpoint-store fault kill healthy runs.
 */
export function createRunCheckpointCapture(
  deps: RunCheckpointCaptureDeps,
): (step: TraceStep) => void {
  const { ctx, runId, agentId, taskId } = deps;
  let stepPosition = 0;
  return (_step: TraceStep): void => {
    stepPosition += 1;
    try {
      let agent = deps.agentSnapshot;
      try {
        agent = ctx.agents.get(agentId);
      } catch {
        /* agent deleted mid-run: keep the POST-time snapshot */
      }
      let task = deps.taskSnapshot;
      try {
        task = ctx.tasks.get(taskId);
      } catch {
        /* task deleted mid-run: keep the POST-time snapshot */
      }
      const activeTools: string[] = [];
      for (const intent of ctx.stepIntentStore.listIntents(runId)) {
        if (intent.status === 'DENIED') continue;
        if (!activeTools.includes(intent.tool)) activeTools.push(intent.tool);
      }
      const pendingApprovals = ctx.fdb.approvals
        .listByTask(taskId)
        .filter((a) => a.status === 'PENDING')
        .map((a) => a.approval_id);
      checkpointLog.capture(
        assembleRunCheckpoint({
          runId,
          stepPosition,
          agent,
          task,
          grantedTools: deps.grantedTools,
          budgetUsage: { ...(deps.harness.tracker?.usage ?? {}) },
          activeTools,
          pendingApprovals,
        }),
      );
    } catch (e) {
      try {
        ctx.audit.record(agentId, 'RUNTIME_CHECKPOINT_FAILED', 'runtime_run', runId, {
          runId,
          stepPosition,
          error: e instanceof Error ? e.message : String(e),
        });
      } catch {
        /* the audit sink is best-effort here by design */
      }
    }
  };
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
    return ctx.json(res, 200, { runs: runStore.list().map(slim) }), true;
  }

  const one = path.match(/^\/api\/runtime\/runs\/([^/]+)$/);
  if (method === 'GET' && one) {
    const r = runStore.get(one[1]);
    if (!r) return ctx.json(res, 404, { error: 'run not found' }), true;
    return ctx.json(res, 200, slim(r)), true;
  }

  // §28.3 — the checkpoint read surface (the recovery entry point):
  // every capture for the run, in first-capture order. A run that
  // exists but has no captures (started before this wiring, or not
  // yet stepped) reads as an empty list; only a run that is unknown
  // to BOTH the registry and the checkpoint log is a 404.
  const ckptList = path.match(/^\/api\/runtime\/runs\/([^/]+)\/checkpoints$/);
  if (method === 'GET' && ckptList) {
    const id = ckptList[1];
    const checkpoints = checkpointLog.list(id);
    if (!runStore.get(id) && checkpoints.length === 0) {
      return ctx.json(res, 404, { error: 'run not found' }), true;
    }
    return ctx.json(res, 200, { runId: id, checkpoints }), true;
  }

  // §28.3 — the resume point: the run's highest-position checkpoint.
  const ckptLatest = path.match(/^\/api\/runtime\/runs\/([^/]+)\/checkpoints\/latest$/);
  if (method === 'GET' && ckptLatest) {
    const id = ckptLatest[1];
    const latest = checkpointLog.latest(id);
    if (!latest) {
      if (!runStore.get(id)) return ctx.json(res, 404, { error: 'run not found' }), true;
      return ctx.json(res, 404, { error: 'no checkpoint captured for run' }), true;
    }
    return ctx.json(res, 200, latest), true;
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
    // F4 — the record is persisted at creation and at every later
    // change (evidence appends in the harness sink below, the terminal
    // write, the error write), so the store always holds the run's
    // last state even if this process dies mid-run.
    const persistRun = () => runStore.put(rec);
    persistRun();
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
          // §28.1 — stamp this run's id onto its step intents. The
          // harness supports the option but this route never passed
          // it, so HTTP-run intents were all stamped 'unknown-run' —
          // durable, but attributable to no run (the startup scan
          // could not say WHICH run a leftover intent belonged to,
          // and the checkpoint capture below reads a run's active
          // tools from its intents). One line; no behavior change
          // beyond the stamp itself.
          runId: id,
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
              // Step-by-step durability: each appended evidence entry
              // is persisted as it lands, not held until the run ends.
              persistRun();
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
        // §28.3 — the loop this run executes, carrying the per-step
        // checkpoint capture (see createRunCheckpointCapture). The
        // capture reads this harness's BudgetTracker, which runAgent
        // attaches before the loop starts.
        const loop = new AgentLoop({
          budgets: { maxSteps: 40, timeMs: 60000, maxRetries: 3 },
          onTrace: createRunCheckpointCapture({
            ctx,
            runId: id,
            agentId,
            taskId,
            agentSnapshot: agent,
            taskSnapshot: task,
            grantedTools,
            harness,
          }),
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
          loop,
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
        persistRun();
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
        persistRun();
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

/**
 * Agent Runtime routes — spec §24–§27.
 *
 *  POST /api/runtime/runs        {agentId, taskId, script?, routeRequest?}
 *                               → executes an agent loop with the StubAdapter
 *  GET  /api/runtime/runs        list runs — each record joined server-side
 *                               with its manifest's key columns, the live
 *                               checkpoint count, the process-live flag and
 *                               the resolved project (Batch 16, below)
 *  GET  /api/runtime/runs/:id    one run
 *  GET  /api/runtime/runs/:id/checkpoints         the run's §28.3 checkpoints
 *  GET  /api/runtime/runs/:id/checkpoints/latest  the resume point
 *  POST /api/runtime/runs/:id/resume              §28.4 controlled resume:
 *                               {script?, routeRequest?} → revalidate against
 *                               the latest checkpoint, then start a NEW run
 *                               carrying its budget baseline + step positions
 *  GET  /api/runtime/runs/:id/manifest            the run's manifest (Batch 15)
 *
 * RUN MANIFESTS (Batch 15): every run also gets a manifest — the one
 * record that answers for the run. It is written at creation with
 * what is knowable then (identity incl. the task's project, the
 * driver: caller-supplied script vs the default script + the adapter
 * that will drive it + whether a routeRequest was supplied, the
 * granted tools, a snapshot of the budget limits, and the
 * context-manifest hash assembled by the checkpoint capture's own
 * assembly, so manifest and checkpoints cross-check hash-for-hash)
 * and completed at the run's terminal/error write from the run's
 * real records (outcome, the effective model read back from the
 * run's routing/context evidence, budget usage, step intents
 * bucketed by status — DENIED its own bucket — evidence accounted
 * by count/type, the checkpoint step range). Manifests live in a
 * RunManifestStore (@ai-factory/db owns the shape, same reasoning
 * as the run record): in-memory by default, the coordinator installs
 * the SQLite store (FactoryDatabase.runManifests) at startup via
 * setRuntimeManifestStore. A run created before this wiring has NO
 * manifest: its manifest query answers an honest 404 instead of a
 * fabricated backfill. A manifest write failure never fails the run
 * it describes (audited RUNTIME_MANIFEST_FAILED instead).
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
 * RESUME (§28.4, Batch 15): POST /api/runtime/runs/:id/resume is the
 * controlled recovery action behind that read surface. It NEVER
 * revives the dead run and never hot-continues a loop mid-flight:
 * it revalidates the world against the run's latest checkpoint
 * (task still exists at the checkpoint's task version, agent still
 * registered, no unreconciled PENDING step intents, project not
 * archived, run not live in this process — every outcome reported
 * per-item in the response and in the RESUME_* audit records), and
 * only then starts a NEW run for the same agent/task. The new run's
 * loop still starts at its own first phase; what carries over is
 * recorded state, not a process image: the BudgetTracker is seeded
 * with the checkpoint's budgetUsage (counts replayed exactly,
 * wall-clock elapsed carried as the baseline), checkpoint captures
 * continue at checkpoint.stepPosition + 1, and the linkage is
 * durable — a resume_link evidence entry on the new run's record,
 * the RESUME_STARTED audit, and the response's resumedFrom field.
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
  BudgetTracker,
  CheckpointLog,
  DEFAULT_EXTENDED_BUDGETS,
  Harness,
  StubAdapter,
  runAgent,
  type CheckpointV2,
  type StepIntent,
  type ToolImpl,
  type TraceStep,
} from '@ai-factory/runtime';
import type { Agent, Permission, Task } from '@ai-factory/core';
import { effectiveAuthorizationStatus } from '@ai-factory/core';
import { needsHuman } from '@ai-factory/autonomy';
import {
  InMemoryRunManifestStore,
  InMemoryRuntimeRunStore,
  type NeedsHumanDbRecord,
  type RunManifest,
  type RunManifestBudgetUsage,
  type RunManifestStatus,
  type RunManifestStore,
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
 * Runs executing in THIS process right now. A run record's status
 * alone cannot say "live": a record left RUNNING by a dead process
 * (the §28.4 restart case) and a run executing this second both read
 * RUNNING. This set is the discovery step §28.4 requires before
 * resume ("first discover live workers"): executeRuntimeRun marks
 * a run on entry and unmarks it in a finally, so membership means
 * an execution is genuinely in flight here; a RUNNING record NOT in
 * the set is an interrupted leftover, which is exactly what resume
 * exists for.
 */
const liveRunIds = new Set<string>();

/** True while a run is executing in this process (see liveRunIds). */
export function isRuntimeRunLive(runId: string): boolean {
  return liveRunIds.has(runId);
}

/* ------------------------------------------------------------------ */
/* Run manifests (Batch 15) — the run's accountability record           */
/* ------------------------------------------------------------------ */

/**
 * The AgentLoop budgets every HTTP run is built with. One source for
 * both the loop construction in the POST handler and the manifest's
 * budget-limit snapshot, so the snapshot can never drift from the
 * budgets the run actually executes under.
 */
export const RUN_LOOP_BUDGETS = { maxSteps: 40, timeMs: 60_000, maxRetries: 3 } as const;

/**
 * The active manifest store. Module-level for the same reason as the
 * run registry: the coordinator installs the SQLite store
 * (FactoryDatabase.runManifests) at startup via
 * setRuntimeManifestStore; the default is in-memory (standalone use,
 * tests — wiring only, no durability).
 */
let manifestStore: RunManifestStore = new InMemoryRunManifestStore();

/**
 * Install the manifest store. Called once by the coordinator
 * (apps/server/src/index.ts) with FactoryDatabase.runManifests before
 * the server takes traffic; embedders and tests may install their own.
 */
export function setRuntimeManifestStore(store: RunManifestStore): void {
  manifestStore = store;
}

/** The manifest for one run, or undefined when the run has none. */
export function getRuntimeManifest(runId: string): RunManifest | undefined {
  return manifestStore.get(runId);
}

/** The facts a manifest is completed from at the run's terminal write. */
export interface RunManifestCompletion {
  status: RunManifestStatus;
  outcome: string | null;
  finishedAt: string | null;
  error: string | null;
  steps: number;
  /**
   * The run's evidence entries — on the runAgent return path the
   * result's full list (harness-collected entries plus the runner's
   * model_routing record); on the route's error path the run record's
   * (partial) list. Only type + payload are read.
   */
  evidence: readonly { type: string; payload: Record<string, unknown> }[];
  /**
   * RunResult.budgetUsage on the return path; null when runAgent
   * rejected before returning one (routing refusal, setup failure) —
   * the usage was never reported, so the manifest says so.
   */
  budgetUsage: RunManifestBudgetUsage | null;
  /** The run's step intents, read back from the shared intent store. */
  intents: readonly StepIntent[];
  /** The run's checkpoints, read back from the checkpoint log. */
  checkpoints: readonly CheckpointV2[];
}

/**
 * Complete a creation-time manifest from a finished run's real
 * records. Pure: every fact is collected by the caller, so this is
 * the single place that decides what the completion fields MEAN:
 *
 *  - model / modelSource: the routing decision is the authority when
 *    the run recorded one (its model_routing evidence names the
 *    primary); otherwise the OBSERVE context evidence records the
 *    model the runner used — on this path the adapter's own name —
 *    and the source is 'adapter'. Neither recorded → both null: the
 *    run never established an effective model on record.
 *  - intents: bucketed by status out of the shared store, ids kept
 *    as the cross-reference. DENIED counts separately — the tool
 *    never ran.
 *  - evidence: counted and typed. The entries carry no ids on this
 *    path, so none are listed (see the db module's header).
 *  - checkpoints: count + step range out of the checkpoint log —
 *    the reference; the captures themselves stay in the log.
 */
export function completeRunManifest(
  manifest: RunManifest,
  c: RunManifestCompletion,
): RunManifest {
  const routingEv = c.evidence.find((e) => e.type === 'model_routing');
  const contextEv = c.evidence.find((e) => e.type === 'context');
  let model: string | null = null;
  let modelSource: RunManifest['modelSource'] = null;
  if (routingEv) {
    const primary = routingEv.payload['primary'];
    model = typeof primary === 'string' ? primary : null;
    modelSource = 'model-router';
  } else if (contextEv) {
    const recorded = contextEv.payload['model'];
    model = typeof recorded === 'string' ? recorded : null;
    modelSource = 'adapter';
  }
  const byStatus = { PENDING: 0, EXECUTED: 0, FAILED: 0, DENIED: 0 };
  for (const intent of c.intents) byStatus[intent.status] += 1;
  const byType: Record<string, number> = {};
  for (const e of c.evidence) byType[e.type] = (byType[e.type] ?? 0) + 1;
  const positions = c.checkpoints.map((k) => k.stepPosition);
  return {
    ...manifest,
    status: c.status,
    outcome: c.outcome,
    finishedAt: c.finishedAt,
    error: c.error,
    steps: c.steps,
    model,
    modelSource,
    budgetUsage: c.budgetUsage ? { ...c.budgetUsage } : null,
    intents: {
      total: c.intents.length,
      ids: c.intents.map((i) => i.id),
      byStatus,
    },
    evidence: { count: c.evidence.length, byType },
    checkpoints: {
      count: c.checkpoints.length,
      firstStep: positions.length > 0 ? Math.min(...positions) : null,
      lastStep: positions.length > 0 ? Math.max(...positions) : null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* §81 emission (Batch 38) — run-terminal needsHuman upgrades          */
/* ------------------------------------------------------------------ */

/**
 * Build the §81 upgrade record for a run that terminated on a determinate
 * trigger: reasonCode 'BUDGET_EXCEEDED' → 'budget-exceeded',
 * 'LOOP_STAGNATION' → 'repeated-failure'. The reasonCode is the
 * machine-readable FactoryError.code carried through RunResult by
 * runAgent (Batch 38) — classification never matches on the
 * human-readable message.
 *
 * recipient is null: the server has coarse-grained token RBAC with no
 * named human accounts, so we record the required level instead of
 * inventing a person. 'operator' is the API role that does daily run
 * work (tasks, runs, approvals) — the honest minimum level that can
 * re-budget, fix, or abandon the run.
 */
export function buildRunUpgradeRecord(args: {
  runId: string;
  taskId: string;
  agentId: string;
  reasonCode: 'BUDGET_EXCEEDED' | 'LOOP_STAGNATION';
  reason: string | undefined;
  steps: number;
}): NeedsHumanDbRecord {
  const trigger =
    args.reasonCode === 'BUDGET_EXCEEDED' ? 'budget-exceeded' : 'repeated-failure';
  const what =
    args.reasonCode === 'BUDGET_EXCEEDED'
      ? `run ${args.runId} exhausted its execution budget after ${args.steps} steps`
      : `run ${args.runId} stagnated: the same error repeated with no progress for ${args.steps} steps`;
  const rec = needsHuman(trigger, {
    detail: `${what} (agent ${args.agentId}, task ${args.taskId}). ${args.reason ?? 'no reason recorded'}`,
    context: {
      runId: args.runId,
      taskId: args.taskId,
      agentId: args.agentId,
      reasonCode: args.reasonCode,
      steps: String(args.steps),
    },
    impactScope: `run ${args.runId} is terminal; task ${args.taskId} made no further progress`,
    stoppedActions: [`run ${args.runId} — terminated on ${args.reasonCode}`],
    suggestion:
      args.reasonCode === 'BUDGET_EXCEEDED'
        ? 'Raise the run budgets (maxSteps/timeMs/maxRetries) and re-run, revise the task, or abandon it. Mark this upgrade resolved via POST /api/needs-human/:id/resolve.'
        : 'Inspect the run trace for the repeating error signature, fix the underlying cause, then re-run. Mark this upgrade resolved via POST /api/needs-human/:id/resolve.',
  });
  return {
    id: rec.id,
    reason: rec.reason,
    reasonZh: rec.reasonZh,
    severity: rec.severity,
    source: `runtime-run:${args.runId}`,
    recipient: null,
    requiredDeciderLevel: 'operator',
    detailJson: JSON.stringify({
      runId: args.runId,
      taskId: args.taskId,
      agentId: args.agentId,
      reasonCode: args.reasonCode,
      steps: args.steps,
      reason: args.reason ?? null,
      suggestion: rec.suggestion,
    }),
    contextJson: JSON.stringify(rec.context ?? {}),
    raisedAt: Date.now(),
    status: 'open',
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  };
}

/**
 * Write-through for run-terminal §81 upgrades (Batch 38): insert-only
 * into fdb.needsHuman, audited NEEDS_HUMAN_RAISED. A failed
 * write-through is audited NEEDS_HUMAN_PERSIST_FAILED — it never rolls
 * back the already-committed run record.
 */
export function emitRunNeedsHuman(ctx: RouteContext, record: NeedsHumanDbRecord): void {
  try {
    ctx.fdb.needsHuman.submit(record);
    ctx.audit.record('system', 'NEEDS_HUMAN_RAISED', 'needs-human', record.id, {
      reason: record.reason,
      source: record.source,
      requiredDeciderLevel: record.requiredDeciderLevel,
    });
  } catch (err) {
    ctx.audit.record('system', 'NEEDS_HUMAN_PERSIST_FAILED', 'needs-human', record.id, {
      error: err instanceof Error ? err.message : String(err),
      source: record.source,
    });
  }
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
/**
 * The task revision marker a checkpoint is stamped with (see
 * assembleRunCheckpoint): the v2 engine's optimistic-concurrency
 * counter when the task carries one, else the task row's updatedAt.
 * One source for the rule — the resume revalidation (§28.4) recomputes
 * the marker from the CURRENT task through this same function and
 * compares it against the checkpoint's stamp, so "the task changed
 * underneath the checkpoint" means exactly what capture meant.
 */
export function checkpointTaskVersion(task: Task): string {
  return task.v2?.taskVersion !== undefined
    ? `task-v2@${task.v2.taskVersion}`
    : `task@${task.updatedAt}`;
}

export function assembleRunCheckpoint(
  facts: RunCheckpointFacts,
): Omit<CheckpointV2, 'schemaVersion' | 'capturedAt'> {
  const { agent, task } = facts;
  const taskVersion = checkpointTaskVersion(task);
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
  /**
   * §28.4 — step-position base for a resumed run: the source
   * checkpoint's stepPosition, so the new run's captures continue at
   * source+1 instead of restarting the count at 1 (the continuity is
   * visible on the run's checkpoint list). Absent/0 for a fresh run.
   */
  initialStepPosition?: number;
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
  let stepPosition = deps.initialStepPosition ?? 0;
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

/* ------------------------------------------------------------------ */
/* Resume (§28.4) — revalidation, budget seeding, shared execution      */
/* ------------------------------------------------------------------ */

/**
 * §28.4 — build the resumed run's BudgetTracker with the source
 * checkpoint's budgetUsage as its baseline ("recovery budgets are
 * finite": the new run does not get a fresh allowance on top of what
 * the dead run already spent).
 *
 * BudgetTracker's counters have no setter — by design, the only way
 * in is through the consume APIs, so the baseline is REPLAYED through
 * them: each consume increments first and throws only after crossing
 * its bound, so replaying the recorded counts reproduces the recorded
 * usage exactly (including a final over-limit increment when the
 * dead run died of budget exhaustion; the throw is swallowed per
 * call precisely because the counter has already landed). The
 * wall-clock baseline is carried as an offset clock: elapsed keeps
 * counting from the checkpoint's elapsedMs. What a checkpoint did
 * not record (the key is absent) seeds as zero — never invented.
 */
export function seedBudgetTracker(usage: Record<string, number>): BudgetTracker {
  const elapsedMs = Math.max(0, Math.floor(usage['elapsedMs'] ?? 0));
  const clock =
    elapsedMs > 0 ? { now: () => Date.now() - elapsedMs } : undefined;
  const tracker = new BudgetTracker({}, clock);
  const replay = (count: number, consume: () => void): void => {
    const n = Math.max(0, Math.floor(count));
    for (let i = 0; i < n; i += 1) {
      try {
        consume();
      } catch {
        /* the counter already incremented past its bound — that exact
           over-limit value is the faithful baseline */
      }
    }
  };
  replay(usage['modelCalls'] ?? 0, () => tracker.consumeModelCall());
  replay(usage['toolCalls'] ?? 0, () => tracker.consumeToolCall());
  replay(usage['repairLoops'] ?? 0, () => tracker.consumeRepairLoop());
  replay(usage['noProgressSteps'] ?? 0, () => tracker.noteProgress(false));
  return tracker;
}

/** One §28.4 revalidation item: the verdict plus the evidence for it. */
export interface ResumeCheck {
  ok: boolean;
  detail: string;
}

/**
 * The full §28.4 revalidation result for one resume attempt. Every
 * item is always present (an item that could not be evaluated says
 * so and is not ok — fail-closed), so the response and the
 * RESUME_REJECTED audit can report the whole picture at once instead
 * of failing one item at a time.
 */
export interface ResumeChecks {
  checkpointExists: ResumeCheck & { stepPosition?: number; capturedAt?: number };
  taskExists: ResumeCheck;
  taskVersionCurrent: ResumeCheck & { expected?: string; actual?: string };
  /**
   * §17.2 (Batch 18) — the task's authorization axis: AUTHORIZED is
   * the only state under which a run may (re)start. The status that
   * was found rides along so a refusal names it.
   */
  taskAuthorized: ResumeCheck & { authorizationStatus?: string };
  agentRegistered: ResumeCheck;
  noPendingIntents: ResumeCheck & { pending: { id: string; tool: string }[] };
  projectNotArchived: ResumeCheck & { projectId?: string };
  runNotLive: ResumeCheck;
}

/**
 * §28.4 / §28.3 — revalidate the world against a run's latest
 * checkpoint before a resume may create anything. Pure evaluation:
 * reads stores, mutates nothing. The items are the checkpoint's own
 * recorded resumePreconditions made executable, plus the live-run
 * exclusion §28.4's restart procedure implies:
 *
 *  - the task still exists AND is still at the checkpoint's task
 *    version (the marker is recomputed through checkpointTaskVersion,
 *    the capture side's own rule — any task mutation since the last
 *    capture, even a rename, counts as drift and refuses);
 *  - the agent is still registered (§28.3: resume revalidates
 *    authorization/policy/credentials — on this path the agent's
 *    registration and current permissions are what the new run will
 *    execute under, and they are re-read at execution time);
 *  - the run has no PENDING step intents left unreconciled (§28.2:
 *    an intent with no committed result is an action whose outcome
 *    is UNKNOWN; resuming past it would blind-replay it);
 *  - the task's project is not archived (the Batch 14 guard, via the
 *    coordinator-injected evaluator; an embedder that wires no guard
 *    cannot verify this and fails closed);
 *  - the task is currently AUTHORIZED on the §17.2 axis (Batch 18 —
 *    §28.3's "resume revalidates authorization" applied to the task
 *    axis, so resume is not a side door around the run-creation
 *    gate);
 *  - the run is not live in this process (isRuntimeRunLive).
 *
 * `opts.isLive` exists so tests can pin the live branch without a
 * race against a real execution; the route omits it and the module's
 * live set decides.
 */
export function evaluateResumeChecks(
  ctx: RouteContext,
  rec: RuntimeRunRecord,
  checkpoint: CheckpointV2 | undefined,
  opts?: { isLive?: boolean },
): ResumeChecks {
  const checks: ResumeChecks = {
    checkpointExists: checkpoint
      ? {
          ok: true,
          detail: `latest checkpoint at step ${checkpoint.stepPosition}`,
          stepPosition: checkpoint.stepPosition,
          capturedAt: checkpoint.capturedAt,
        }
      : { ok: false, detail: 'no checkpoint captured for this run' },
    taskExists: { ok: false, detail: 'not evaluated' },
    taskVersionCurrent: { ok: false, detail: 'not evaluated' },
    taskAuthorized: { ok: false, detail: 'not evaluated' },
    agentRegistered: { ok: false, detail: 'not evaluated' },
    noPendingIntents: { ok: false, detail: 'not evaluated', pending: [] },
    projectNotArchived: { ok: false, detail: 'not evaluated' },
    runNotLive: { ok: false, detail: 'not evaluated' },
  };

  let task: Task | undefined;
  try {
    task = ctx.tasks.get(rec.taskId);
    checks.taskExists = { ok: true, detail: `task ${rec.taskId} exists` };
  } catch {
    checks.taskExists = {
      ok: false,
      detail: `task ${rec.taskId} no longer exists`,
    };
  }

  if (!checkpoint) {
    checks.taskVersionCurrent = {
      ok: false,
      detail: 'no checkpoint to compare the task version against',
    };
  } else if (!task) {
    checks.taskVersionCurrent = {
      ok: false,
      detail: 'task missing — its current version marker cannot be recomputed',
      expected: checkpoint.taskVersion,
    };
  } else {
    const actual = checkpointTaskVersion(task);
    checks.taskVersionCurrent =
      actual === checkpoint.taskVersion
        ? {
            ok: true,
            detail: `task still at ${actual}`,
            expected: checkpoint.taskVersion,
            actual,
          }
        : {
            ok: false,
            detail:
              `task changed underneath the checkpoint: checkpoint recorded ` +
              `${checkpoint.taskVersion}, task is now at ${actual}`,
            expected: checkpoint.taskVersion,
            actual,
          };
  }

  // §17.2 (Batch 18) — the task's authorization axis joins the
  // revalidation: a resume restarts work under the task, so the task
  // must currently be AUTHORIZED (§28.3's "resume revalidates
  // authorization" made concrete for the task axis — run creation
  // has refused non-AUTHORIZED tasks since Batch 17, and a resume
  // must not be a side door around that gate). Tasks recorded
  // before the axis existed read AUTHORIZED (core's
  // effectiveAuthorizationStatus rule), so legacy runs are
  // unaffected. A missing task fails here too — its authorization
  // cannot be verified — alongside taskExists.
  if (!task) {
    checks.taskAuthorized = {
      ok: false,
      detail: 'task missing — its authorization_status cannot be verified',
    };
  } else {
    const status = effectiveAuthorizationStatus(task);
    checks.taskAuthorized =
      status === 'AUTHORIZED'
        ? {
            ok: true,
            detail: 'task authorization_status is AUTHORIZED (§17.2)',
            authorizationStatus: status,
          }
        : {
            ok: false,
            detail:
              `task authorization_status is ${status} — resume requires AUTHORIZED (§17.2)`,
            authorizationStatus: status,
          };
  }

  try {
    ctx.agents.get(rec.agentId);
    checks.agentRegistered = {
      ok: true,
      detail: `agent ${rec.agentId} is registered`,
    };
  } catch {
    checks.agentRegistered = {
      ok: false,
      detail: `agent ${rec.agentId} is no longer registered`,
    };
  }

  const pending = ctx.stepIntentStore.pendingIntents(rec.id);
  checks.noPendingIntents =
    pending.length === 0
      ? { ok: true, detail: 'no PENDING step intents for this run', pending: [] }
      : {
          ok: false,
          detail:
            `${pending.length} PENDING step intent(s) never reconciled — ` +
            `their outcomes are UNKNOWN and a resume must not blind-replay them (§28.2)`,
          pending: pending.map((i) => ({ id: i.id, tool: i.tool })),
        };

  if (!ctx.archivedTaskBody) {
    checks.projectNotArchived = {
      ok: false,
      detail:
        'archive guard not wired in this embedder — the project state ' +
        'cannot be verified (fail-closed)',
    };
  } else {
    const archivedBody = ctx.archivedTaskBody(rec.taskId);
    checks.projectNotArchived = archivedBody
      ? { ok: false, detail: archivedBody.error, projectId: archivedBody.projectId }
      : { ok: true, detail: 'the task’s project is not archived' };
  }

  const live = opts?.isLive ?? liveRunIds.has(rec.id);
  checks.runNotLive = live
    ? {
        ok: false,
        detail: 'this run is executing in this process right now — a live run is never resumed',
      }
    : {
        ok: true,
        detail:
          rec.status === 'RUNNING'
            ? 'record is RUNNING but no execution is live in this process — an interrupted leftover'
            : `run is ${rec.status} (not executing)`,
      };

  return checks;
}

export interface ExecuteRuntimeRunDeps {
  ctx: RouteContext;
  rec: RuntimeRunRecord;
  persistRun: () => void;
  agent: Agent;
  task: Task;
  grantedTools: readonly string[];
  adapter: StubAdapter;
  routeRequest: unknown;
  completeManifest: (facts: RunManifestCompletion) => void;
  /** §28.4 — a resumed run's seeded budget baseline (seedBudgetTracker). */
  budgetTracker?: BudgetTracker;
  /** §28.4 — the source checkpoint's stepPosition; captures continue at +1. */
  initialStepPosition?: number;
  /** §28.4 — the lineage written onto the new run's record (see below). */
  resumeLink?: {
    resumeOf: { runId: string; stepPosition: number };
    budgetBaseline: Record<string, number>;
  };
}

/**
 * Execute one HTTP run to its terminal write — the single execution
 * path behind POST /runs and POST /runs/:id/resume, so a resumed run
 * is driven by exactly the same machinery as a fresh one (same
 * harness wiring, same checkpoint capture, same manifest
 * completion). The resume differences are precisely the three
 * optional deps: a seeded BudgetTracker, a step-position base for
 * the capture, and the resume lineage. Marks the run live for the
 * duration and always unmarks it (finally), whatever the outcome.
 */
export function executeRuntimeRun(deps: ExecuteRuntimeRunDeps): void {
  const { ctx, rec, persistRun, agent, task, grantedTools, adapter } = deps;
  const id = rec.id;
  const agentId = rec.agentId;
  const taskId = rec.taskId;
  liveRunIds.add(id);
  // Run async; the record is updated on completion. Prototype only.
  void (async () => {
    try {
      const sandbox = join(tmpdir(), `ai-factory-run-${id}`);
      const harness = new Harness({
        allowedRoots: [sandbox],
        stepTimeoutMs: 5000,
        // §28.1 — stamp this run's id onto its step intents (see the
        // note in the POST handler's history: HTTP-run intents used
        // to all be 'unknown-run'; the checkpoint capture reads a
        // run's active tools from its intents).
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
      // §28.4 — a resumed run carries its lineage on its own record:
      // a resume_link evidence entry, collected through the same sink
      // as every other entry, so it is persisted with the record and
      // reads back through GET /runs/:id. (The run record's column
      // shape is owned by @ai-factory/db and has no resume column;
      // the record's evidence list is its own durable place for the
      // link, next to the RESUME_STARTED audit and the response's
      // resumedFrom field.)
      if (deps.resumeLink) {
        harness.collectEvidence({
          type: 'resume_link',
          title: 'run resumed from a checkpoint of a previous run',
          payload: {
            resumeOf: deps.resumeLink.resumeOf,
            budgetBaseline: deps.resumeLink.budgetBaseline,
          },
        });
      }
      // §28.3 — the loop this run executes, carrying the per-step
      // checkpoint capture (see createRunCheckpointCapture). The
      // capture reads this harness's BudgetTracker, which runAgent
      // attaches before the loop starts.
      const loop = new AgentLoop({
        budgets: { ...RUN_LOOP_BUDGETS },
        onTrace: createRunCheckpointCapture({
          ctx,
          runId: id,
          agentId,
          taskId,
          agentSnapshot: agent,
          taskSnapshot: task,
          grantedTools,
          harness,
          initialStepPosition: deps.initialStepPosition,
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
        adapter,
        loop,
        tools: RUNTIME_TOOLS,
        routeRequest:
          deps.routeRequest != null ? (deps.routeRequest as never) : undefined,
        // §28.4 — the resumed run's seeded baseline; absent for a
        // fresh run, where runAgent builds the tracker itself.
        ...(deps.budgetTracker ? { budgetTracker: deps.budgetTracker } : {}),
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
      // Batch 15 — complete the manifest from the run's real
      // records: the result's evidence (incl. the routing record),
      // its reported budget usage, the intents the shared store
      // holds for this run, and the checkpoints the log captured.
      deps.completeManifest({
        status: rec.status,
        outcome: rec.outcome,
        finishedAt: rec.finishedAt,
        error: rec.error,
        steps: rec.steps,
        evidence: result.evidence,
        budgetUsage: result.budgetUsage ?? null,
        intents: ctx.stepIntentStore.listIntents(id),
        checkpoints: checkpointLog.list(id),
      });
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
      // §81 emission (Batch 38): the run terminated on a determinate
      // trigger — 'BUDGET_EXCEEDED' → 'budget-exceeded',
      // 'LOOP_STAGNATION' → 'repeated-failure'. The reasonCode is the
      // machine-readable FactoryError.code from runAgent, never a
      // message match. Write-through failures are audited, never
      // rolled back — the run record above is already committed.
      if (
        result.reasonCode === 'BUDGET_EXCEEDED' ||
        result.reasonCode === 'LOOP_STAGNATION'
      ) {
        emitRunNeedsHuman(
          ctx,
          buildRunUpgradeRecord({
            runId: id,
            taskId,
            agentId,
            reasonCode: result.reasonCode,
            reason: result.reason,
            steps: result.steps,
          }),
        );
      }
    } catch (e) {
      rec.status = 'FAILED';
      rec.error = e instanceof Error ? e.message : String(e);
      rec.finishedAt = new Date().toISOString();
      persistRun();
      // Batch 15 — runAgent rejected before returning a result:
      // complete the manifest from what the run still recorded
      // (its partial evidence on the run record, its intents and
      // checkpoints in their stores). Budget usage was never
      // reported on this path, so it stays null — not reconstructed.
      deps.completeManifest({
        status: rec.status,
        outcome: rec.outcome,
        finishedAt: rec.finishedAt,
        error: rec.error,
        steps: rec.steps,
        evidence: rec.evidence as { type: string; payload: Record<string, unknown> }[],
        budgetUsage: null,
        intents: ctx.stepIntentStore.listIntents(id),
        checkpoints: checkpointLog.list(id),
      });
      ctx.bus.emit(
        'RUN_STEP',
        { runId: id, agentId, taskId, phase: 'FINISH', outcome: 'failed', error: rec.error },
        'runtime',
      );
    } finally {
      liveRunIds.delete(id);
    }
  })();
}

/**
 * §28.4 — the creation-time manifest for a RESUMED run, assembled
 * exactly as POST /runs assembles a fresh run's (same snapshot
 * fields, same context hash out of the checkpoint capture's own
 * assembly, the completion block null until the terminal write).
 * POST /runs keeps its inline copy (Batch 15); the two must agree
 * field-for-field, and completion goes through the one shared
 * completeRunManifest either way. Returns the manifest plus the
 * never-fails completion closure, mirroring the POST handler's.
 */
export function createResumedRunManifest(
  ctx: RouteContext,
  args: {
    runId: string;
    agent: Agent;
    task: Task;
    grantedTools: readonly string[];
    scriptProvided: boolean;
    adapterName: string;
    routeRequestProvided: boolean;
    createdAt: string;
  },
): { manifest: RunManifest; completeManifest: (facts: RunManifestCompletion) => void } {
  const { runId, agent, task, grantedTools } = args;
  const manifest: RunManifest = {
    runId,
    agentId: agent.id,
    taskId: task.id,
    projectId: task.projectId,
    createdAt: args.createdAt,
    driver: {
      kind: args.scriptProvided ? 'script' : 'default-script',
      adapter: args.adapterName,
      routeRequestProvided: args.routeRequestProvided,
    },
    grantedTools: [...grantedTools],
    budgetLimits: {
      loop: { ...RUN_LOOP_BUDGETS },
      extended: { ...DEFAULT_EXTENDED_BUDGETS },
    },
    contextManifestHash: assembleRunCheckpoint({
      runId,
      stepPosition: 0,
      agent,
      task,
      grantedTools,
      budgetUsage: {},
      activeTools: [],
      pendingApprovals: [],
    }).contextManifestHash,
    status: 'RUNNING',
    outcome: null,
    finishedAt: null,
    error: null,
    steps: null,
    model: null,
    modelSource: null,
    budgetUsage: null,
    intents: null,
    evidence: null,
    checkpoints: null,
  };
  manifestStore.put(manifest);
  const completeManifest = (facts: RunManifestCompletion): void => {
    try {
      manifestStore.put(completeRunManifest(manifest, facts));
    } catch (e) {
      try {
        ctx.audit.record(agent.id, 'RUNTIME_MANIFEST_FAILED', 'runtime_run', runId, {
          runId,
          error: e instanceof Error ? e.message : String(e),
        });
      } catch {
        /* the audit sink is best-effort here by design */
      }
    }
  };
  return { manifest, completeManifest };
}

function slim(r: RuntimeRunRecord) {
  return r;
}

/**
 * Observatory list row (Batch 16) — the run record plus the joins a
 * global runs view needs, computed HERE so clients never fan out
 * N+1 per-run fetches to assemble a list:
 *
 *  - `live` — the run is executing in THIS process right now
 *    (liveRunIds). Together with the record's status this is what
 *    distinguishes a genuinely running loop (RUNNING + live) from an
 *    interrupted leftover (RUNNING + not live: the process that ran
 *    it is gone; the record is served as-is, never reaped).
 *  - `checkpointCount` — the checkpoint log's CURRENT count for the
 *    run. Read live, not from the manifest: a manifest's checkpoints
 *    block is a finalization snapshot and stays null while the run
 *    is still going.
 *  - `projectId` / `projectName` — the run's project: the manifest's
 *    creation-time snapshot first (it is the run's own record of
 *    where it ran); for a pre-manifest legacy run, resolved from the
 *    task's current record. Null when neither resolves (the task is
 *    gone and no manifest exists) — reported as null, never guessed.
 *  - `manifest` — the manifest's KEY COLUMNS only (model + source,
 *    terminal accounting, intent buckets, evidence count, budget
 *    usage), or null for a legacy run: an honest absence, the same
 *    stance as the manifest endpoint's 404. The full manifest (grant,
 *    budget limits, context hash, intent ids) stays on
 *    GET /:id/manifest — the list does not duplicate it.
 *
 * The single-run GET keeps the bare record shape (`slim`): existing
 * consumers pin it field-for-field, and the detail surfaces (run,
 * manifest, checkpoints) already exist per run.
 */
function listRow(ctx: RouteContext, r: RuntimeRunRecord) {
  const m = manifestStore.get(r.id);
  let projectId: string | null = m?.projectId ?? null;
  if (projectId === null) {
    try {
      projectId = ctx.tasks.get(r.taskId).projectId;
    } catch {
      projectId = null;
    }
  }
  let projectName: string | null = null;
  if (projectId !== null) {
    try {
      projectName = ctx.fdb?.getProject(projectId)?.name ?? null;
    } catch {
      projectName = null;
    }
  }
  return {
    ...r,
    live: liveRunIds.has(r.id),
    checkpointCount: checkpointLog.list(r.id).length,
    projectId,
    projectName,
    manifest: m
      ? {
          status: m.status,
          outcome: m.outcome,
          finishedAt: m.finishedAt,
          error: m.error,
          steps: m.steps,
          driverKind: m.driver.kind,
          adapter: m.driver.adapter,
          model: m.model,
          modelSource: m.modelSource,
          budgetUsage: m.budgetUsage,
          intentsTotal: m.intents?.total ?? null,
          intentsByStatus: m.intents?.byStatus ?? null,
          evidenceCount: m.evidence?.count ?? null,
        }
      : null,
  };
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
    return ctx.json(res, 200, { runs: runStore.list().map((r) => listRow(ctx, r)) }), true;
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

  // Batch 15 — the run's manifest: its accountability record
  // (creation snapshot + completion accounting). 404 semantics
  // mirror the run's own: an unknown run is 'run not found'; a run
  // that exists but predates the manifest wiring is 'run manifest
  // not found' — an honest absence, never a fabricated backfill.
  const manifestMatch = path.match(/^\/api\/runtime\/runs\/([^/]+)\/manifest$/);
  if (method === 'GET' && manifestMatch) {
    const id = manifestMatch[1];
    const manifest = manifestStore.get(id);
    if (!manifest) {
      if (!runStore.get(id)) return ctx.json(res, 404, { error: 'run not found' }), true;
      return ctx.json(res, 404, { error: 'run manifest not found' }), true;
    }
    return ctx.json(res, 200, manifest), true;
  }

  // §28.4 — controlled resume: revalidate against the run's latest
  // checkpoint, then start a NEW run carrying the checkpoint's
  // recorded state (budget baseline + step positions). The source
  // run is never revived and nothing is hot-continued: the new
  // run's loop starts at its own first phase, and the response's
  // resumedFrom says exactly what was carried over. Every rejection
  // is zero-side-effect (no run record, no intent, no checkpoint —
  // only the RESUME_* audit trail the spec's accountability asks
  // for) and reports every check, not just the first failure.
  const resumeMatch = path.match(/^\/api\/runtime\/runs\/([^/]+)\/resume$/);
  if (method === 'POST' && resumeMatch) {
    const sourceId = resumeMatch[1];
    const b = await ctx.readBody(req);
    const source = runStore.get(sourceId);
    if (!source) {
      return ctx.json(res, 404, { error: 'run not found' }), true;
    }
    const checkpoint = checkpointLog.latest(sourceId);
    ctx.audit.record('human', 'RESUME_REQUESTED', 'runtime_run', sourceId, {
      runId: sourceId,
      agentId: source.agentId,
      taskId: source.taskId,
      hasCheckpoint: checkpoint !== undefined,
      checkpointStepPosition: checkpoint?.stepPosition ?? null,
    });
    const rejectResume = (
      status: number,
      reason: string,
      error: string,
      checks: ResumeChecks,
    ): boolean => {
      ctx.audit.record('human', 'RESUME_REJECTED', 'runtime_run', sourceId, {
        runId: sourceId,
        agentId: source.agentId,
        taskId: source.taskId,
        reason,
        checks,
      });
      return ctx.json(res, status, { error, reason, runId: sourceId, checks }), true;
    };
    const checks = evaluateResumeChecks(ctx, source, checkpoint);
    if (!checkpoint) {
      return rejectResume(
        404,
        'no_checkpoint',
        'no checkpoint captured for run',
        checks,
      );
    }
    const failedChecks = Object.entries(checks)
      .filter(([, c]) => !c.ok)
      .map(([name]) => name);
    if (failedChecks.length > 0) {
      return rejectResume(
        409,
        'revalidation_failed',
        `resume revalidation failed: ${failedChecks.join(', ')}`,
        checks,
      );
    }

    // §26 — the operator tool allowlist resolves exactly as for a
    // fresh POST /runs, including its fail-closed config error: a
    // resumed run executes under the CURRENT grant, never under a
    // grant the dead run once had (§28.3: no stale capabilities).
    const allowlist = resolveRuntimeToolAllowlist();
    const unknownTools = unknownRuntimeTools(allowlist);
    if (unknownTools.length > 0) {
      ctx.audit.record(
        source.agentId,
        'RUNTIME_TOOLS_CONFIG_ERROR',
        'runtime_config',
        RUNTIME_TOOLS_ENV,
        {
          actor: source.agentId,
          agentId: source.agentId,
          taskId: source.taskId,
          allowlist,
          unknownTools,
          registeredTools: [...RUNTIME_TOOL_NAMES],
        },
      );
      ctx.audit.record('human', 'RESUME_REJECTED', 'runtime_run', sourceId, {
        runId: sourceId,
        agentId: source.agentId,
        taskId: source.taskId,
        reason: 'tools_config_error',
        unknownTools,
        checks,
      });
      ctx.json(res, 500, {
        error:
          `${RUNTIME_TOOLS_ENV} names unregistered tool(s): ${unknownTools.join(', ')} ` +
          `(registered: ${RUNTIME_TOOL_NAMES.join(', ')})`,
      });
      return true;
    }
    const grantedTools = allowlist;

    // The revalidation just proved both still resolve.
    const agent = ctx.agents.get(source.agentId);
    const task = ctx.tasks.get(source.taskId);

    // The driver, resolved once, synchronously — the same rule as
    // POST /runs: the caller's script when the request carried one,
    // else the route's default script. (The source run's record does
    // not retain its script, so "the source run's drive" for a
    // script-driven source is only reproducible by re-supplying it;
    // the manifest + response name which of the two drove this run.)
    const scriptProvided = Array.isArray(b['script']);
    const script: Array<{
      text: string;
      toolCalls: Array<{ tool: string; args: unknown }>;
    }> = scriptProvided
      ? (b['script'] as Array<{
          text: string;
          toolCalls: Array<{ tool: string; args: unknown }>;
        }>)
      : DEFAULT_SCRIPT;
    const adapter = new StubAdapter(script);

    const newId = randomUUID();
    const newRec: RuntimeRunRecord = {
      id: newId,
      agentId: source.agentId,
      taskId: source.taskId,
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
    const persistNewRun = () => runStore.put(newRec);
    persistNewRun();
    const { completeManifest } = createResumedRunManifest(ctx, {
      runId: newId,
      agent,
      task,
      grantedTools,
      scriptProvided,
      adapterName: adapter.name,
      routeRequestProvided: b['routeRequest'] != null,
      createdAt: newRec.createdAt,
    });
    // §91 — agent runs are first-class bus events.
    ctx.bus.emit(
      'RUN_STARTED',
      {
        runId: newId,
        agentId: source.agentId,
        taskId: source.taskId,
        agent: agent.displayName,
        resumeOf: { runId: sourceId, stepPosition: checkpoint.stepPosition },
      },
      'runtime',
    );
    // §26 — the new run's grant is on the audit record, as for any run.
    ctx.audit.record(source.agentId, 'RUNTIME_RUN_STARTED', 'runtime_run', newId, {
      runId: newId,
      actor: source.agentId,
      agentId: source.agentId,
      taskId: source.taskId,
      grantedTools,
      resumeOf: { runId: sourceId, stepPosition: checkpoint.stepPosition },
    });
    const budgetBaseline = { ...checkpoint.budgetUsage };
    ctx.audit.record('human', 'RESUME_STARTED', 'runtime_run', newId, {
      newRunId: newId,
      resumedFromRunId: sourceId,
      agentId: source.agentId,
      taskId: source.taskId,
      checkpoint: {
        runId: sourceId,
        stepPosition: checkpoint.stepPosition,
        capturedAt: checkpoint.capturedAt,
      },
      budgetBaseline,
      checks,
    });
    executeRuntimeRun({
      ctx,
      rec: newRec,
      persistRun: persistNewRun,
      agent,
      task,
      grantedTools,
      adapter,
      routeRequest: b['routeRequest'] != null ? b['routeRequest'] : undefined,
      completeManifest,
      budgetTracker: seedBudgetTracker(checkpoint.budgetUsage),
      initialStepPosition: checkpoint.stepPosition,
      resumeLink: {
        resumeOf: { runId: sourceId, stepPosition: checkpoint.stepPosition },
        budgetBaseline,
      },
    });
    return (
      ctx.json(res, 202, {
        id: newId,
        status: 'RUNNING',
        resumedFrom: {
          runId: sourceId,
          stepPosition: checkpoint.stepPosition,
          capturedAt: checkpoint.capturedAt,
        },
        resumeOf: { runId: sourceId, stepPosition: checkpoint.stepPosition },
        checks,
        budgetBaseline,
        note:
          'a new run re-enters the loop from its first phase; the source ' +
          'checkpoint contributes its recorded state only — budget baseline ' +
          'and step positions carry over, the dead process’s execution does not',
      }),
      true
    );
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

    // Batch 14 — an archived project is closed to new facts: refuse the
    // run BEFORE the record exists, so a refused run leaves no run
    // record, no step intent and no checkpoint behind. The decision is
    // the coordinator-injected guard (ctx.archivedTaskBody, backed by
    // routes/project-guard.ts — see context.ts for why this module
    // does not import it directly).
    const archivedBody = ctx.archivedTaskBody?.(taskId);
    if (archivedBody) {
      ctx.json(res, 409, archivedBody);
      return true;
    }

    // §17.2 (Batch 17) — creation is not execution authorization: only
    // an AUTHORIZED task may start a run. The task is already in hand,
    // so no injected guard is needed. Tasks persisted before the
    // authorization axis existed carry no value and read as AUTHORIZED
    // (core's effectiveAuthorizationStatus rule, inlined here because
    // this module is imported from src by tests) — only tasks
    // explicitly held in DRAFT / WAITING_HUMAN_DISPATCH / REVOKED /
    // EXPIRED refuse, with the observed state in the body.
    const authorizationStatus = task.authorizationStatus ?? 'AUTHORIZED';
    if (authorizationStatus !== 'AUTHORIZED') {
      ctx.json(res, 403, {
        error:
          `task is not authorized for execution (authorization_status: ${authorizationStatus}); ` +
          'a Human Dispatch is required first (§17.2)',
        code: 'TASK_NOT_AUTHORIZED',
        taskId,
        authorizationStatus,
      });
      return true;
    }

    // The driver, resolved once, synchronously: the caller's script
    // when the POST carried one, else the route's default script.
    // The manifest snapshot below names which of the two drove the
    // run, and reads the adapter's name off this very instance.
    const scriptProvided = Array.isArray(b['script']);
    const script: Array<{
      text: string;
      toolCalls: Array<{ tool: string; args: unknown }>;
    }> = scriptProvided
      ? (b['script'] as Array<{
          text: string;
          toolCalls: Array<{ tool: string; args: unknown }>;
        }>)
      : DEFAULT_SCRIPT;
    const adapter = new StubAdapter(script);

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

    // Batch 15 — the run's manifest, creation snapshot: everything
    // knowable before the run starts. The context hash comes out of
    // the checkpoint capture's own assembly (stepPosition is not a
    // hash input), so it equals the contextManifestHash on every
    // checkpoint this run will capture. The completion block stays
    // null until the terminal/error write completes it (see
    // completeManifest below); a process that dies mid-run leaves
    // exactly this snapshot behind, status RUNNING.
    const manifest: RunManifest = {
      runId: id,
      agentId,
      taskId,
      projectId: task.projectId,
      createdAt: rec.createdAt,
      driver: {
        kind: scriptProvided ? 'script' : 'default-script',
        adapter: adapter.name,
        routeRequestProvided: b['routeRequest'] != null,
      },
      grantedTools: [...grantedTools],
      budgetLimits: {
        loop: { ...RUN_LOOP_BUDGETS },
        extended: { ...DEFAULT_EXTENDED_BUDGETS },
      },
      contextManifestHash: assembleRunCheckpoint({
        runId: id,
        stepPosition: 0,
        agent,
        task,
        grantedTools,
        budgetUsage: {},
        activeTools: [],
        pendingApprovals: [],
      }).contextManifestHash,
      status: 'RUNNING',
      outcome: null,
      finishedAt: null,
      error: null,
      steps: null,
      model: null,
      modelSource: null,
      budgetUsage: null,
      intents: null,
      evidence: null,
      checkpoints: null,
    };
    manifestStore.put(manifest);
    /**
     * Complete the manifest from the run's terminal facts. A failed
     * manifest write never fails the run it describes (same stance
     * as checkpoint capture): the error is audited and the run's own
     * outcome stands.
     */
    const completeManifest = (facts: RunManifestCompletion): void => {
      try {
        manifestStore.put(completeRunManifest(manifest, facts));
      } catch (e) {
        try {
          ctx.audit.record(agentId, 'RUNTIME_MANIFEST_FAILED', 'runtime_run', id, {
            runId: id,
            error: e instanceof Error ? e.message : String(e),
          });
        } catch {
          /* the audit sink is best-effort here by design */
        }
      }
    };
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

    // Execution is shared with the resume route (§28.4): one path
    // drives every HTTP run to its terminal write (executeRuntimeRun).
    executeRuntimeRun({
      ctx,
      rec,
      persistRun,
      agent,
      task,
      grantedTools,
      adapter,
      routeRequest: b['routeRequest'] != null ? b['routeRequest'] : undefined,
      completeManifest,
    });

    return ctx.json(res, 202, { id, status: 'RUNNING' }), true;
  }

  return false;
}

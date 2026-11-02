/**
 * Declarative task runner routes (round-5 task R5-S2) — VS Code
 * tasks.json-compatible subset.
 *
 *   GET  /api/tasks/list?root=        list parsed tasks (.ai-factory/tasks.json)
 *   PUT  /api/tasks                  { root?, text } — validate + write
 *                                    (R7-#4: dependency cycles rejected here,
 *                                    fail-closed, before anything is saved)
 *   POST /api/tasks/run              { label, root?, projectId? } — run chain
 *   GET  /api/tasks/graph?label=&root= DAG nodes + edges + last-run status
 *                                    overlay for visualization (R7-#4)
 *   GET  /api/tasks/runs             recent run timelines: live ring
 *                                    merged with persisted run metadata
 *                                    (V3.0 audit round 2, item #10)
 *   GET  /api/tasks/runs/:id         one timeline: full step cards +
 *                                    linked shadow checkpoints; a
 *                                    persisted-only id returns metadata
 *                                    with empty steps (view, not replay)
 *   DELETE /api/tasks/runs/history   clear persisted run history
 *                                    (operator, audited, count only)
 *   POST /api/tasks/runs/:id/rollback { stepLabel } — mark later steps
 *                                    superseded (history never deleted)
 *   POST /api/tasks/runs/:id/rerun  { stepLabel? } — new chain run from a
 *                                    step, linked to the original run
 *
 * V3-#7 Cascade timeline: every chain run records a full per-step
 * timeline (one card per step: label, command, status, exit code,
 * duration, capped output + record digest, diagnostics, error). Steps the
 * chain never reached are recorded as 'skipped', never invented. Rollback
 * marks steps superseded and audits TIMELINE_ROLLBACK; it never rewrites
 * or deletes history, and it never reverts files — file revert stays
 * with the existing shadow-checkpoint restore endpoint, which the
 * timeline detail links to (checkpoints resolved by run root via
 * configsForPath). Rerun executes through the SAME executeChain as a
 * manual run (same policy, same audit) — never a second execution
 * channel; the new run is linked to the original via rerunOf/rerunFrom.
 *
 * NOTE (R5 closeout): GET /api/tasks (bare or ?projectId=) is the LEGACY
 * project-tasks endpoint further down the dispatch chain — the runner's
 * list deliberately lives at /api/tasks/list so the two never collide
 * (the collision crashed the desktop: the runner's {tasks,errors,...}
 * object reached CommandPalette which expects TaskSummary[]).
 *
 * R7-#4 task dependency DAG: the planner already resolved dependsOn
 * trees (R5-S2) with cycle rejection at plan time; this round adds the
 * three missing pieces — (1) cycle detection at SAVE time so a cyclic
 * file can never be written, (2) dependents of a failed task recorded
 * explicitly as 'skipped' with the failed dependency named (previously
 * they were silently absent from chain results; only the V3-#7 timeline
 * backfilled them with a generic note), and (3) GET /api/tasks/graph
 * for visualization (nodes with longest-path levels + edges + last-run
 * status overlay). Execution still goes through the same executeChain:
 * parallel branches run via dependsOrder 'parallel', diamonds run once
 * (in-flight memo), and a linear chain (no dependsOn) behaves exactly
 * as before.
 *
 * Execution safety: task commands go through the SAME policy as /api/exec —
 * deny patterns + binary whitelist + per-binary argv guards
 * (checkCommandPolicy), the control-plane data-dir guard, and the
 * workspace cwd jail. The policy functions are setter-injected from
 * index.ts (dual-mode: this module must not value-import src-relative
 * extensionless modules; type-stripping tests import this route straight
 * from src). The execution device is execFile with a per-task timeout and
 * a 2MB output cap — the same one-shot device /api/exec uses, never a
 * shell: type "shell" means "command string tokenized quote-aware", NOT
 * "run through /bin/sh".
 *
 * Fail-closed: a task that exits non-zero, times out, or is denied stops
 * the whole chain — dependents never run. Cycles / unknown labels /
 * invalid JSON are 400s before anything executes.
 *
 * Output parsing: each task's combined output is fed to the project's
 * problem matchers — either the matcher names the task declares
 * (problemMatcher) or the project's default enabled set — and stored via
 * the injected sink with source 'tasks' (a fresh parse replaces that
 * source's previous snapshot, like the other sources).
 *
 * RBAC: the default prefix rule in auth.ts gives GET → viewer and every
 * other method → operator for this prefix — no auth.ts change needed.
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - Background/watch tasks (isBackground) are not supported: there is no
 *    persistent watcher; the parser warns and ignores the field.
 *  - `type: "shell"` never invokes a shell; `;`, `|`, `$(...)` are NOT
 *    interpreted (VS Code shell semantics intentionally narrowed).
 *  - Env is additive only; PATH, LD_PRELOAD, LD_LIBRARY_PATH, DYLD_*,
 *    and NODE_OPTIONS cannot be overridden and credential-looking env
 *    vars are scrubbed.
 *  - Run records: full timelines stay process-local (restart clears
 *    step cards and outputs); run METADATA persists across restarts in
 *    <dataDir>/run-history.json (V3.0 audit round 2, item #10) so the
 *    runs list can be viewed back. Persisted runs are view-only: they
 *    cannot be rolled back or re-run from their record.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleTaskRunnerRoutes, setTaskRunnerDeps } from './routes/tasks';
 *   setTaskRunnerDeps({
 *     resolveRoot: (root) => resolveInspectionRoot(root),
 *     checkCommandPolicy: (command) => checkCommandPolicy(command),
 *     commandHitsControlDir: (cwd, tokens) => commandHitsControlDir(cwd, tokens),
 *     resolveCwd: (cwd) => resolveExecCwd(cwd),
 *     parseAndStore: (projectId, defs, text) => { ... parseOutput(text, defs, 'tasks') ... },
 *     resolveMatchers: (projectId) => resolveMatchers(projectId),
 *     getMatcher: (projectId, name) => { const cfg = problemMatcherStore().get(projectId); return cfg.customs[name] ?? builtinMatcher(name); },
 *   });
 *   if (await handleTaskRunnerRoutes(req, res, url, routeCtx)) return;
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  DEFAULT_TIMEOUT_MS,
  dagLevels,
  detectCycle,
  flattenPlan,
  parseTasksJson,
  planRun,
  quoteArg,
  shellCommandLine,
  type PlannedTask,
  type TaskChainResult,
  type TaskDef,
  type TaskRunResult,
} from '@ai-factory/tasks';
import {
  applyRollback,
  buildTimeline,
  TimelineError,
  type TimelineRun,
} from '@ai-factory/tasktimeline';
import {
  RUN_HISTORY_FILE,
  RunHistory,
  RunHistoryCorruptError,
  type RunHistoryMeta,
} from '@ai-factory/runhistory';
import { scrubCredentialEnv } from '@ai-factory/runtime';
import type { RouteContext } from './context';
import type { ParseStats, ProblemMatcherDef } from '../problem-matchers';

const PREFIX = '/api/tasks';
const TASKS_FILE = '.ai-factory/tasks.json';
const MAX_FILE_BYTES = 512_000;
const OUTPUT_CAP_BYTES = 2_000_000;
const MAX_RUN_RECORDS = 20;

class TaskRouteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(message: string, code: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'TaskRouteError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** All policy/cross-module seams, injected once by index.ts at boot. */
export interface TaskRunnerDeps {
  /** Jail a requested project root (throws on escape). */
  resolveRoot: (root?: string) => string;
  /** Exec safety policy: deny patterns + whitelist + argv guards. Throws on deny. */
  checkCommandPolicy: (command: string) => string[];
  /** Control-plane data-dir guard. */
  commandHitsControlDir: (cwd: string, tokens: string[]) => boolean;
  /** Confine a cwd to the workspace tree. */
  resolveCwd: (cwd?: string) => string;
  /** Parse text with the given matcher defs, store as source 'tasks'. */
  parseAndStore: (
    projectId: string,
    defs: ProblemMatcherDef[],
    text: string,
  ) => { added: number; total: number; stats: ParseStats };
  /** Project's default enabled matcher set. */
  resolveMatchers: (projectId: string) => ProblemMatcherDef[];
  /** One named matcher (custom or builtin) for a project. */
  getMatcher: (projectId: string, name: string) => ProblemMatcherDef | null;
}

let deps: TaskRunnerDeps | null = null;

/** Installed once by index.ts at boot. */
export function setTaskRunnerDeps(d: TaskRunnerDeps | null): void {
  deps = d;
}

/** One linked shadow checkpoint, as exposed on a timeline run detail. */
export interface TimelineCheckpointLink {
  id: string;
  createdAt: string;
  label: string;
  workspaceId: string;
  workspacePath: string;
}

/**
 * Provider for linked shadow checkpoints. Setter injection (same pattern as
 * setTaskRunnerDeps): this route is imported from src by tests under node
 * type-stripping, so it must not value-import ../shadow-checkpoints (or any
 * src-relative module) — the real provider is installed by index.ts at boot
 * from the compiled server. Unwired callers get an empty list, never a crash:
 * checkpoint linking is best-effort decoration on the timeline detail.
 */
export type TimelineCheckpointProvider = (
  root: string,
  label: string,
) => { checkpoints: TimelineCheckpointLink[]; checkpointError: string | null };

let timelineCheckpointProvider: TimelineCheckpointProvider | null = null;

/** Installed once by index.ts at boot. */
export function setTimelineCheckpointProvider(p: TimelineCheckpointProvider | null): void {
  timelineCheckpointProvider = p;
}

function needDeps(): TaskRunnerDeps {
  if (!deps) throw new TaskRouteError('task runner is not wired', 'not-wired', 500);
  return deps;
}

function resolveRoot(rawRoot?: string): string {
  const d = needDeps();
  try {
    return d.resolveRoot(rawRoot);
  } catch (e) {
    throw new TaskRouteError((e as Error).message, 'bad-root', 403);
  }
}

/** Jail a task's options.cwd under the project root. */
function resolveTaskCwd(d: TaskRunnerDeps, root: string, cwdOpt?: string): string {
  if (!cwdOpt) return root;
  const resolved = normalize(join(root, cwdOpt));
  if (relative(root, resolved).startsWith('..')) {
    throw new TaskRouteError(`options.cwd escapes the project root: ${cwdOpt}`, 'cwd-escape', 403);
  }
  return resolved;
}

function projectIdOf(value: unknown): string {
  if (typeof value === 'string' && /^[A-Za-z0-9_\-.]{1,64}$/.test(value.trim())) {
    return value.trim();
  }
  return 'default';
}

/**
 * V3-#7 timeline record: the full TimelineRun plus server-only fields.
 * `root` (absolute project root, needed for rerun + checkpoint lookup) is
 * NEVER serialized to clients — timelineView() strips it.
 */
interface TimelineRecord extends TimelineRun {
  root: string;
  projectId: string;
}

const runRecords: TimelineRecord[] = [];
let runSeq = 0;

/**
 * V3.0 audit round 2, item #10 — minimal persisted run metadata.
 *
 * The live ring above is still the source of truth for full timelines
 * (step cards, outputs, rollback, rerun). Persisted history is metadata
 * only (see packages/runhistory): it survives restarts so the runs list
 * can be viewed back, but it carries no step data, no root path, and no
 * free-text beyond a redacted chain label — so a persisted run can
 * never be rolled back or re-run from its record. Re-execution always
 * goes through POST /api/tasks/run with the chain label.
 *
 * The store is lazy per data dir (same AI_FACTORY_DATA_DIR convention
 * as the db-browser history) and best-effort: a corrupt or unwritable
 * history file never fails a chain run; the corruption surfaces in the
 * list response (historyCorrupt) and explicit DELETE clears it.
 */
let runHistoryStore: RunHistory | null = null;
let runHistoryDir = '';
let runSeqSeeded = false;

function runHistoryDataDir(): string {
  const env = (process.env['AI_FACTORY_DATA_DIR'] ?? '').trim();
  if (env) return resolve(env);
  return resolve(process.cwd(), 'data');
}

function runHistoryOf(): RunHistory {
  const dir = runHistoryDataDir();
  if (!runHistoryStore || runHistoryDir !== dir) {
    runHistoryStore = new RunHistory({ filePath: join(dir, RUN_HISTORY_FILE) });
    runHistoryDir = dir;
  }
  return runHistoryStore;
}

/** True when the persisted history file is corrupt (fail-closed state). */
function runHistoryCorrupt(): boolean {
  try {
    runHistoryOf().load();
    return runHistoryOf().corrupt;
  } catch {
    return true;
  }
}

/**
 * Seed the live run sequence above every persisted id (taskrun-N) so a
 * restart never reuses an id that persisted history already holds: the
 * merged list view dedupes by id with live runs winning, and a reused
 * id would silently shadow an older persisted run.
 */
function ensureSeqSeeded(): void {
  if (runSeqSeeded) return;
  runSeqSeeded = true;
  try {
    runHistoryOf().load();
    for (const m of runHistoryOf().list()) {
      const n = /^taskrun-(\d+)$/.exec(m.id);
      if (n) runSeq = Math.max(runSeq, Number(n[1]));
    }
  } catch {
    // Corrupt history: no seed available, live ids start fresh; the
    // corrupt file is not loaded, so no persisted id can collide.
  }
}

/** Project a live timeline into persisted metadata (counts only). */
function toRunMeta(timeline: TimelineRun): Omit<RunHistoryMeta, 'label'> & { label: string } {
  const counts = { ok: 0, failed: 0, denied: 0, timeout: 0, skipped: 0, superseded: 0 };
  for (const s of timeline.steps) {
    if (s.status in counts) counts[s.status as keyof typeof counts] += 1;
  }
  return {
    id: timeline.id,
    label: timeline.label,
    ok: timeline.ok,
    startedAt: timeline.startedAt,
    finishedAt: timeline.finishedAt,
    durationMs: Date.parse(timeline.finishedAt) - Date.parse(timeline.startedAt),
    taskCount: timeline.steps.length,
    counts,
    coverage: timeline.coverage,
    ...(timeline.rerunOf !== undefined ? { rerunOf: timeline.rerunOf } : {}),
    ...(timeline.rerunFrom !== undefined ? { rerunFrom: timeline.rerunFrom } : {}),
  };
}

/** Persisted view of one metadata record for the runs list / detail. */
function persistedView(meta: RunHistoryMeta): Record<string, unknown> {
  return {
    ...meta,
    taskCount: meta.taskCount,
    steps: [],
    persisted: true,
    persistedNote:
      'Persisted run metadata only: step commands, outputs, and error text are not stored. ' +
      'This is a view of a past run, not a re-execution channel — to run again, ' +
      'POST /api/tasks/run with the chain label.',
  };
}

/** Merged list view: live runs first (newest first), then persisted runs not already live. */
function mergedRunsView(): Array<(TimelineRun & { taskCount: number }) | Record<string, unknown>> {
  const live = [...runRecords].reverse().map((r) => timelineView(r, false));
  const liveIds = new Set(live.map((r) => r.id));
  let persisted: RunHistoryMeta[] = [];
  try {
    runHistoryOf().load();
    persisted = runHistoryOf().list();
  } catch {
    persisted = [];
  }
  const extra = [...persisted]
    .reverse()
    .filter((m) => !liveIds.has(m.id))
    .map((m) => persistedView(m));
  return [...live, ...extra];
}

function recordRun(
  chain: TaskChainResult,
  planned: TaskDef[],
  root: string,
  projectId: string,
  rerun?: { rerunOf: string; rerunFrom: string },
): TimelineRun {
  // Seed once per boot so restarted servers never reuse a persisted id.
  ensureSeqSeeded();
  runSeq += 1;
  const timeline = buildTimeline(
    `taskrun-${runSeq}`,
    chain,
    planned.map((t) => ({
      label: t.label,
      command: t.type === 'process' ? t.command : `${t.command} ${t.args.join(' ')}`.trim(),
    })),
  );
  const rec: TimelineRecord = {
    ...timeline,
    ...(rerun ? { rerunOf: rerun.rerunOf, rerunFrom: rerun.rerunFrom } : {}),
    root,
    projectId,
  };
  runRecords.push(rec);
  while (runRecords.length > MAX_RUN_RECORDS) runRecords.shift();
  // Best-effort persistence: a corrupt/unwritable history file must
  // never fail the chain run itself; corruption surfaces in the list.
  try {
    runHistoryOf().record(toRunMeta(timeline));
  } catch {
    // Live record already kept; historyCorrupt in the list reports it.
  }
  return timeline;
}

/** Test seam: wipe run records. */
export function resetTaskRunRecords(): void {
  runRecords.length = 0;
  runSeq = 0;
  // Do not re-seed after an explicit reset: the reset caller owns the
  // id space (production never calls this; seeding happens on boot).
  runSeqSeeded = true;
}

/** Serialize a record for clients: strip the server-only root path. */
function timelineView(rec: TimelineRecord, withOutput: boolean): TimelineRun & { taskCount: number } {
  const { root: _root, projectId: _projectId, ...view } = rec;
  const taskCount = view.steps.length;
  if (withOutput) return { ...view, taskCount };
  return {
    ...view,
    taskCount,
    steps: view.steps.map((s) => ({ ...s, output: '' })),
  };
}

/** Resolve linked shadow checkpoints for a run, best-effort (never fails the timeline). */
function linkedCheckpoints(rec: TimelineRecord): {
  checkpoints: TimelineCheckpointLink[];
  checkpointError: string | null;
} {
  if (!timelineCheckpointProvider) return { checkpoints: [], checkpointError: null };
  try {
    return timelineCheckpointProvider(rec.root, rec.label);
  } catch (e) {
    return { checkpoints: [], checkpointError: (e as Error).message };
  }
}

/**
 * Run one tasks.json chain by label, end to end. Exported for reuse by
 * the watch trigger route (round-6 task R6-S3): a watch fire runs exactly
 * the same chain a manual POST /api/tasks/run would run — same policy,
 * same matchers, same audit — never a second execution channel.
 * Thin wrapper over the shared executeChain (also used by POST
 * /api/tasks/run and the R6-S5 scheduler seam): failures are returned as
 * data (not thrown) so a background trigger can record them instead of
 * crashing the watcher.
 */
export type ChainRunOutcome =
  | { ok: true; chain: TaskChainResult }
  | { ok: false; status: number; code: string; error: string; errors?: string[] };

export async function runTaskChainByLabel(
  label: string,
  root: string,
  projectId: string,
  actor: string,
  ctx: RouteContext,
  // R6-A7: slash-command task bindings append operator-supplied args to
  // the REQUESTED task only (dependencies run with their declared args).
  // Undefined = no extra args (watch/scheduler callers unchanged).
  extraArgs?: string[],
): Promise<ChainRunOutcome> {
  try {
    const chain = await executeChain(label, root, projectId, ctx, actor, undefined, extraArgs);
    return { ok: true, chain };
  } catch (e) {
    if (e instanceof TaskRouteError) {
      return {
        ok: false,
        status: e.status,
        code: e.code,
        error: e.message,
        ...(e.details !== undefined ? { errors: e.details as string[] } : {}),
      };
    }
    throw e;
  }
}

/**
 * Build the argv for a task AFTER the policy check. 'shell' joins the
 * command string (quote-aware) and lets the policy tokenize; 'process'
 * forbids embedded arguments and passes args verbatim.
 * R6-A7 extraArgs: appended AFTER the declared args. For 'shell' tasks
 * the whole line (declared + extra) is policy-tokenized, so extra args
 * are still gated; for 'process' tasks the binary is still the declared
 * one, only trailing args are operator-supplied.
 */
function buildArgv(d: TaskRunnerDeps, task: TaskDef, extraArgs?: string[]): string[] {
  const extra = extraArgs ?? [];
  if (task.type === 'process') {
    const tokens = d.checkCommandPolicy(task.command);
    if (tokens.length !== 1) {
      throw new TaskRouteError(
        `task "${task.label}": type "process" command must be a bare binary (use args for arguments)`,
        'process-args-in-command',
      );
    }
    return [tokens[0], ...task.args, ...extra];
  }
  const line = shellCommandLine(task) + (extra.length > 0 ? ` ${extra.map(quoteArg).join(' ')}` : '');
  return d.checkCommandPolicy(line);
}

function runOne(
  argv: string[],
  cwd: string,
  env: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: OUTPUT_CAP_BYTES,
        env: { ...scrubCredentialEnv(process.env), ...(env ?? {}) },
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '');
        const errOut = String(stderr ?? '');
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string };
          const timedOut = e.killed === true && e.signal === 'SIGTERM';
          resolve({
            exitCode: typeof e.code === 'number' ? e.code : null,
            stdout: out.slice(0, OUTPUT_CAP_BYTES),
            stderr: errOut.slice(0, OUTPUT_CAP_BYTES),
            timedOut,
          });
          return;
        }
        resolve({ exitCode: 0, stdout: out.slice(0, OUTPUT_CAP_BYTES), stderr: errOut.slice(0, OUTPUT_CAP_BYTES), timedOut: false });
      },
    );
  });
}

async function executePlan(
  d: TaskRunnerDeps,
  plan: PlannedTask[],
  root: string,
  projectId: string,
  ctx: RouteContext,
  actor: string,
  // R6-A8: explicit .env overlay for a single run. The overlay is
  // in-memory only (never persisted) and a task's own options.env wins
  // over it, so a task's explicit config is never silently overridden.
  envOverlay?: Record<string, string>,
  // R6-A7: slash-command extra args, applied to the requested task only
  // (targetLabel). Dependencies always run with their declared args.
  extraArgs?: string[],
  targetLabel?: string,
): Promise<TaskChainResult> {
  const startedAt = new Date().toISOString();
  const results: TaskRunResult[] = [];
  let stoppedAt: string | null = null;
  let ok = true;
  // In-flight memo: a shared dependency (diamond) runs exactly once, even
  // when two parallel branches reach it concurrently.
  // Outcome carries the root-cause failed labels: a node that itself
  // fails reports [own label]; a node skipped because of dependencies
  // propagates its dependencies' failed labels unchanged, so every
  // skipped record names the task that actually failed, not an
  // intermediate skipped node.
  interface NodeOutcome { ok: boolean; failed: string[]; }
  const inFlight = new Map<string, Promise<NodeOutcome>>();

  const runNode = (node: PlannedTask): Promise<NodeOutcome> => {
    const label = node.task.label;
    const existing = inFlight.get(label);
    if (existing) return existing;
    const p = (async (): Promise<NodeOutcome> => {
      // Dependencies first (fail-closed: any failure skips this node and
      // records it explicitly — R7-#4 — instead of leaving it absent).
      let failedDeps: string[] = [];
      if (node.parallel) {
        const depResults = await Promise.all(node.dependsOn.map((dep) => runNode(dep)));
        failedDeps = depResults.flatMap((r) => r.failed);
      } else {
        for (const dep of node.dependsOn) {
          const r = await runNode(dep);
          if (!r.ok) { failedDeps = r.failed; break; }
        }
      }
      if (failedDeps.length > 0) {
        const skipped: TaskRunResult = {
          label,
          status: 'skipped',
          exitCode: null,
          durationMs: 0,
          output: '',
          truncated: false,
          diagnosticsAdded: 0,
          matchRate: 1,
          error: `skipped: dependency "${failedDeps.join('", "')}" failed`,
        };
        results.push(skipped);
        ctx.audit.record(actor, 'TASK_SKIPPED', 'task', label, { failedDeps });
        return { ok: false, failed: failedDeps };
      }
      const res = await runTask(d, node.task, root, projectId, envOverlay, label === targetLabel ? extraArgs : undefined);
      results.push(res);
      ctx.audit.record(actor, res.status === 'ok' ? 'TASK_RAN' : 'TASK_FAILED', 'task', label, {
        status: res.status,
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        ...(res.error ? { error: res.error } : {}),
      });
      return res.status === 'ok' ? { ok: true, failed: [] } : { ok: false, failed: [label] };
    })();
    inFlight.set(label, p);
    return p;
  };

  for (const node of plan) {
    if (!(await runNode(node)).ok) {
      ok = false;
      stoppedAt = node.task.label;
      break;
    }
  }
  const finishedAt = new Date().toISOString();
  return { requested: plan.map((n) => n.task.label), results, stoppedAt, ok, startedAt, finishedAt };
}

async function runTask(
  d: TaskRunnerDeps,
  task: TaskDef,
  root: string,
  projectId: string,
  envOverlay?: Record<string, string>,
  extraArgs?: string[],
): Promise<TaskRunResult> {
  const t0 = Date.now();
  const fail = (status: TaskRunResult['status'], error: string): TaskRunResult => ({
    label: task.label,
    status,
    exitCode: null,
    durationMs: Date.now() - t0,
    output: '',
    truncated: false,
    diagnosticsAdded: 0,
    matchRate: 1,
    error,
  });

  let cwd: string;
  try {
    cwd = resolveTaskCwd(d, root, task.options.cwd);
  } catch (e) {
    return fail('denied', (e as Error).message);
  }

  let argv: string[];
  try {
    argv = buildArgv(d, task, extraArgs);
  } catch (e) {
    // TaskRouteError (our own shape violations) or the injected exec
    // policy's denial (ExecPolicyDenied) — both are refusals, never runs.
    const msg = e instanceof TaskRouteError ? e.message : (e as Error).message;
    return fail('denied', msg);
  }

  if (d.commandHitsControlDir(cwd, argv)) {
    return fail('denied', 'command refused: the control-plane data directory is off-limits');
  }

  const timeoutMs = task.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let ran: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
  try {
    ran = await runOne(argv, cwd, { ...(envOverlay ?? {}), ...(task.options.env ?? {}) }, timeoutMs);
  } catch (e) {
    return fail('failed', `spawn failed: ${(e as Error).message}`);
  }
  const combined = `${ran.stdout}\n${ran.stderr}`;
  const truncated = combined.length >= OUTPUT_CAP_BYTES;

  // Problem-matcher parse: task-declared matcher names, else the
  // project's default enabled set. Unknown declared names are reported
  // honestly; the parse never fails the task itself.
  const unresolved: string[] = [];
  let defs: ProblemMatcherDef[];
  if (task.problemMatcher.length > 0) {
    defs = [];
    for (const name of task.problemMatcher) {
      const m = d.getMatcher(projectId, name);
      if (m) defs.push(m);
      else unresolved.push(name);
    }
    if (defs.length === 0) defs = d.resolveMatchers(projectId);
  } else {
    defs = d.resolveMatchers(projectId);
  }
  let added = 0;
  let matchRate = 1;
  try {
    if (defs.length > 0) {
      const stored = d.parseAndStore(projectId, defs, combined);
      added = stored.added;
      matchRate = stored.stats.matchRate;
    }
  } catch {
    // Matcher parse never fails the task itself.
  }
  const notes = unresolved.length > 0 ? [`unknown problemMatcher(s) skipped: ${unresolved.join(', ')}`] : undefined;

  const durationMs = Date.now() - t0;
  if (ran.timedOut) {
    return {
      label: task.label, status: 'timeout', exitCode: ran.exitCode, durationMs,
      output: combined.slice(0, OUTPUT_CAP_BYTES), truncated: true,
      diagnosticsAdded: added, matchRate,
      error: `task timed out after ${timeoutMs}ms`,
      ...(notes ? { notes } : {}),
    };
  }
  if (ran.exitCode !== 0) {
    return {
      label: task.label, status: 'failed', exitCode: ran.exitCode, durationMs,
      output: combined.slice(0, OUTPUT_CAP_BYTES), truncated,
      diagnosticsAdded: added, matchRate,
      error: `task exited with code ${ran.exitCode}`,
      ...(notes ? { notes } : {}),
    };
  }
  return {
    label: task.label, status: 'ok', exitCode: 0, durationMs,
    output: combined.slice(0, OUTPUT_CAP_BYTES), truncated,
    diagnosticsAdded: added, matchRate,
    ...(notes ? { notes } : {}),
  };
}

function tasksFilePath(root: string): string {
  return join(root, TASKS_FILE);
}

/**
 * Shared chain execution (used by POST /api/tasks/run and, via
 * runTaskChainForScheduler, by R6-S5 scheduled task-runner jobs).
 * Throws TaskRouteError for plan/file failures; the caller maps it.
 */
async function executeChain(
  label: string,
  root: string,
  projectId: string,
  ctx: RouteContext,
  actor: string,
  envOverlay?: Record<string, string>,
  // R6-A7: slash-command extra args for the requested task only.
  extraArgs?: string[],
  // V3-#7: rerun linkage — recorded on the new timeline, never on the old run.
  rerun?: { rerunOf: string; rerunFrom: string },
): Promise<TaskChainResult> {
  const d = needDeps();
  let text: string;
  try {
    text = readFileSync(tasksFilePath(root), 'utf8');
  } catch {
    throw new TaskRouteError('no tasks file for this project', 'no-tasks-file', 404);
  }
  const parsed = parseTasksJson(text);
  if (parsed.errors.length > 0) {
    throw new TaskRouteError('tasks file has validation errors', 'invalid-tasks', 400, parsed.errors);
  }
  const planned = planRun(parsed.tasks, [label]);
  if (planned.errors.length > 0) {
    throw new TaskRouteError('cannot plan task run', 'plan-failed', 400, planned.errors);
  }
  const flat = flattenPlan(planned.plan);
  ctx.audit.record(actor, 'TASK_CHAIN_STARTED', 'task', label, {
    chain: flat.map((t) => t.label),
    ...(extraArgs && extraArgs.length > 0 ? { extraArgs: extraArgs.slice(0, 20) } : {}),
  });
  const chain = await executePlan(d, planned.plan, root, projectId, ctx, actor, envOverlay, extraArgs, label);
  // V3-#7: the timeline is the chain's per-step record; the flattened plan
  // supplies commands + planned-but-unrun steps, the run supplies results.
  recordRun(chain, flat, root, projectId, rerun);
  return chain;
}

/**
 * R6-A8 seam: run a declarative task chain with an explicit .env
 * overlay (the "load into task environment" action). Same policy,
 * audit and record path as POST /api/tasks/run; the overlay is
 * in-memory only and is never written to tasks.json or any file.
 * The caller (routes/env.ts) audits the key names only, never values.
 */
export async function runTaskChainWithEnv(
  label: string,
  root: string,
  projectId: string,
  actor: string,
  ctx: RouteContext,
  env: Record<string, string>,
): Promise<ChainRunOutcome> {
  try {
    const chain = await executeChain(label, root, projectId, ctx, actor, env);
    return { ok: true, chain };
  } catch (e) {
    if (e instanceof TaskRouteError) {
      return {
        ok: false,
        status: e.status,
        code: e.code,
        error: e.message,
        ...(e.details !== undefined ? { errors: e.details as string[] } : {}),
      };
    }
    throw e;
  }
}

/**
 * R6-S5 scheduler seam: run a declarative task chain through the exact
 * same policy + audit + record path as POST /api/tasks/run. The caller
 * (routes/schedules.ts, setter-injected from index.ts) supplies the
 * route context; root is server-jailed here, never trusted raw.
 */
export async function runTaskChainForScheduler(
  label: string,
  rawRoot: string | undefined,
  projectId: string | undefined,
  ctx: RouteContext,
): Promise<{ ok: boolean; summary: string }> {
  try {
    const root = resolveRoot(rawRoot);
    const chain = await executeChain(label, root, projectIdOf(projectId), ctx, 'scheduler');
    if (chain.ok) {
      return { ok: true, summary: `task chain "${label}" ok (${chain.results.length} tasks)` };
    }
    return {
      ok: false,
      summary: `task chain "${label}" stopped at "${chain.stoppedAt}"`,
    };
  } catch (e) {
    if (e instanceof TaskRouteError) {
      return { ok: false, summary: e.message };
    }
    throw e;
  }
}

export async function handleTaskRunnerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith(PREFIX)) return false;

  try {
    // ---- list ---------------------------------------------------------
    // NOTE (R5 closeout): this is /api/tasks/list, NOT /api/tasks — bare
    // GET /api/tasks belongs to the legacy project-tasks endpoint further
    // down the dispatch chain (see module doc comment).
    if (path === `${PREFIX}/list` && method === 'GET') {
      const root = resolveRoot(url.searchParams.get('root') ?? undefined);
      let text: string | null = null;
      try {
        text = readFileSync(tasksFilePath(root), 'utf8');
      } catch {
        // Missing file is honest, not an error.
      }
      if (text === null) {
        ctx.json(res, 200, { tasks: [], errors: [], warnings: [], missing: true });
        return true;
      }
      if (text.length > MAX_FILE_BYTES) {
        ctx.json(res, 400, { error: `tasks file exceeds ${MAX_FILE_BYTES} bytes`, code: 'file-too-big' });
        return true;
      }
      const parsed = parseTasksJson(text);
      ctx.json(res, 200, {
        tasks: parsed.tasks,
        errors: parsed.errors,
        warnings: parsed.warnings,
        missing: false,
      });
      return true;
    }

    // ---- save ---------------------------------------------------------
    if (path === PREFIX && method === 'PUT') {
      const body = await ctx.readBody(req);
      const text = body['text'];
      if (typeof text !== 'string') {
        ctx.json(res, 400, { error: 'text must be a string', code: 'bad-text' });
        return true;
      }
      if (text.length > MAX_FILE_BYTES) {
        ctx.json(res, 400, { error: `tasks file exceeds ${MAX_FILE_BYTES} bytes`, code: 'file-too-big' });
        return true;
      }
      const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      const parsed = parseTasksJson(text);
      if (parsed.errors.length > 0) {
        ctx.json(res, 400, { errors: parsed.errors, warnings: parsed.warnings, code: 'invalid-tasks' });
        return true;
      }
      // R7-#4: a cyclic file must never be saved — reject with the cycle
      // path in `error` (the desktop req() helper surfaces only `error`,
      // so the path must live there, not only in `errors`).
      const cycle = detectCycle(parsed.tasks);
      if (cycle) {
        ctx.json(res, 400, { error: `dependency cycle detected: ${cycle.join(' -> ')}`, code: 'cycle-detected' });
        return true;
      }
      mkdirSync(dirname(tasksFilePath(root)), { recursive: true });
      writeFileSync(tasksFilePath(root), text, 'utf8');
      const actor = (body['actor'] as string | undefined) ?? 'human';
      ctx.audit.record(actor, 'TASKS_SAVED', 'tasks', TASKS_FILE, { count: parsed.tasks.length });
      ctx.json(res, 200, { ok: true, count: parsed.tasks.length, warnings: parsed.warnings });
      return true;
    }

    // ---- run history --------------------------------------------------
    // V3.0 audit round 2, item #10: the list merges the live ring with
    // persisted run metadata (restart-surviving, metadata only). The
    // merged view dedupes by id with live runs winning; persisted
    // entries carry persisted:true and empty steps.
    if (path === `${PREFIX}/runs` && method === 'GET') {
      ctx.json(res, 200, { runs: mergedRunsView(), historyCorrupt: runHistoryCorrupt() });
      return true;
    }

    // ---- clear persisted run history (operator, audited) --------------
    // Must precede the /runs/:id matcher below, which would otherwise
    // swallow 'history' as a run id. Clears the persisted file only;
    // live in-memory timelines are untouched. Count-only audit: never
    // any run content. Also the repair path for a corrupt file.
    if (path === `${PREFIX}/runs/history` && method === 'DELETE') {
      const cleared = runHistoryOf().clear();
      ctx.audit.record('human', 'TASK_RUN_HISTORY_CLEARED', 'task', 'run-history', {
        cleared,
      });
      ctx.json(res, 200, { ok: true, cleared });
      return true;
    }

    // ---- timeline detail / rollback / rerun (V3-#7) -------------------
    // RBAC: GET -> viewer, POST -> operator via the default prefix rule
    // (see module header) — no auth.ts change needed.
    const runMatch = path.match(/^\/api\/tasks\/runs\/([^/]+)(?:\/(rollback|rerun))?$/);
    if (runMatch) {
      let runId = runMatch[1] ?? '';
      try { runId = decodeURIComponent(runId); } catch { /* keep raw id; lookup will 404 */ }
      const action = runMatch[2] ?? null;
      const idx = runRecords.findIndex((r) => r.id === runId);
      if (idx < 0) {
        // Persisted-only run (restart-surviving metadata): viewable, but
        // immutable — it carries no root path and no step data, so it
        // can never be rolled back or re-run from its record. Re-run
        // means POST /api/tasks/run with the chain label.
        let persisted: RunHistoryMeta | undefined;
        try {
          runHistoryOf().load();
          persisted = runHistoryOf().list().find((m) => m.id === runId);
        } catch {
          persisted = undefined;
        }
        if (persisted) {
          if (method === 'GET' && action === null) {
            ctx.json(res, 200, {
              run: persistedView(persisted),
              persisted: true,
              checkpoints: [],
              checkpointError: null,
            });
            return true;
          }
          if (method === 'POST' && (action === 'rollback' || action === 'rerun')) {
            ctx.json(res, 409, {
              error:
                `persisted run ${runId} is metadata only and cannot be ${action}ed; ` +
                `to run again, POST /api/tasks/run with the chain label '${persisted.label}'`,
              code: 'persisted-run-immutable',
            });
            return true;
          }
          ctx.json(res, 405, { error: 'method not allowed for this timeline path', code: 'bad-method' });
          return true;
        }
        ctx.json(res, 404, { error: `no timeline run ${runId}`, code: 'timeline-not-found' });
        return true;
      }
      const rec = runRecords[idx];
      if (rec === undefined) {
        ctx.json(res, 404, { error: `no timeline run ${runId}`, code: 'timeline-not-found' });
        return true;
      }
      if (method === 'GET' && action === null) {
        const links = linkedCheckpoints(rec);
        ctx.json(res, 200, { run: timelineView(rec, true), ...links });
        return true;
      }
      if (method === 'POST' && action === 'rollback') {
        const body = await ctx.readBody(req);
        const stepLabel = body['stepLabel'];
        if (typeof stepLabel !== 'string' || stepLabel.length === 0) {
          ctx.json(res, 400, { error: 'stepLabel is required', code: 'bad-step' });
          return true;
        }
        const actor = (body['actor'] as string | undefined) ?? 'human';
        try {
          const { run, superseded } = applyRollback(rec, stepLabel, new Date().toISOString());
          runRecords[idx] = { ...rec, ...run };
          // Audit chain stays continuous: the rollback itself is recorded,
          // and the original step results are still in the timeline.
          ctx.audit.record(actor, 'TIMELINE_ROLLBACK', 'task', rec.label, {
            runId: rec.id,
            stepLabel,
            superseded,
            rollbackCount: run.rollbackCount,
          });
          ctx.json(res, 200, { run: timelineView(runRecords[idx] as TimelineRecord, true), superseded });
        } catch (e) {
          if (e instanceof TimelineError) {
            ctx.json(res, 409, { error: e.message, code: e.code });
          } else {
            throw e;
          }
        }
        return true;
      }
      if (method === 'POST' && action === 'rerun') {
        const body = await ctx.readBody(req);
        const actor = (body['actor'] as string | undefined) ?? 'human';
        // Default start: the rollback target if one exists, else the step
        // that stopped the chain, else the first failed step, else the
        // last step. Rerunning a step runs its declared dependencies too
        // (same executeChain semantics as a manual run).
        const requested = body['stepLabel'];
        const stepLabel = typeof requested === 'string' && requested.length > 0
          ? requested
          : rec.supersededFrom
            ?? rec.stoppedAt
            ?? rec.steps.find((s) => s.status === 'failed' || s.status === 'denied' || s.status === 'timeout')?.label
            ?? rec.steps[rec.steps.length - 1]?.label;
        if (!stepLabel) {
          ctx.json(res, 400, { error: 'this timeline has no step to rerun', code: 'bad-step' });
          return true;
        }
        try {
          const chain = await executeChain(stepLabel, rec.root, rec.projectId, ctx, actor, undefined, undefined, {
            rerunOf: rec.id,
            rerunFrom: stepLabel,
          });
          const fresh = runRecords[runRecords.length - 1];
          ctx.audit.record(actor, 'TIMELINE_RERUN', 'task', rec.label, {
            runId: rec.id,
            rerunId: fresh?.id ?? null,
            stepLabel,
            ok: chain.ok,
          });
          ctx.json(res, 200, {
            run: fresh ? timelineView(fresh, true) : null,
            chain,
          });
        } catch (e) {
          if (e instanceof TaskRouteError) {
            ctx.json(res, e.status, { error: e.message, code: e.code });
          } else {
            throw e;
          }
        }
        return true;
      }
      // Wrong method on a timeline sub-path.
      ctx.json(res, 405, { error: 'method not allowed for this timeline path', code: 'bad-method' });
      return true;
    }

    // ---- dag graph (R7-#4) -----------------------------------------
    if (path === `${PREFIX}/graph` && method === 'GET') {
      const label = url.searchParams.get('label');
      if (!label) {
        ctx.json(res, 400, { error: 'label is required', code: 'bad-label' });
        return true;
      }
      const root = resolveRoot(url.searchParams.get('root') ?? undefined);
      let text: string;
      try {
        text = readFileSync(tasksFilePath(root), 'utf8');
      } catch {
        ctx.json(res, 404, { error: 'no tasks file for this project', code: 'no-tasks-file' });
        return true;
      }
      const parsed = parseTasksJson(text);
      if (parsed.errors.length > 0) {
        ctx.json(res, 400, { error: 'tasks file has validation errors', code: 'invalid-tasks', errors: parsed.errors });
        return true;
      }
      const planned = planRun(parsed.tasks, [label]);
      if (planned.errors.length > 0) {
        ctx.json(res, 400, { error: 'cannot plan task run', code: 'plan-failed', errors: planned.errors });
        return true;
      }
      const graph = dagLevels(planned.plan);
      // Last-run status overlay: best-effort, from the process-local
      // timeline ring (a restart clears it; nodes then report null).
      const last = [...runRecords].reverse().find((r) => r.label === label);
      const statusByLabel = new Map<string, string>();
      if (last) for (const s of last.steps) statusByLabel.set(s.label, s.status);
      ctx.json(res, 200, {
        label,
        nodes: graph.nodes.map((n) => ({ ...n, status: statusByLabel.get(n.label) ?? null })),
        edges: graph.edges,
        lastRunId: last?.id ?? null,
      });
      return true;
    }

    // ---- run ----------------------------------------------------------
    if (path === `${PREFIX}/run` && method === 'POST') {
      const body = await ctx.readBody(req);
      const label = body['label'];
      if (typeof label !== 'string' || label.length === 0) {
        ctx.json(res, 400, { error: 'label is required', code: 'bad-label' });
        return true;
      }
      const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      const projectId = projectIdOf(body['projectId']);
      const actor = (body['actor'] as string | undefined) ?? 'human';

      try {
        const chain = await executeChain(label, root, projectId, ctx, actor);
        ctx.json(res, 200, chain);
      } catch (e) {
        if (e instanceof TaskRouteError) {
          ctx.json(res, e.status, {
            error: e.message,
            code: e.code,
            ...(e.details !== undefined ? { errors: e.details } : {}),
          });
        } else {
          throw e;
        }
      }
      return true;
    }
  } catch (e) {
    if (e instanceof TaskRouteError) {
      ctx.json(res, e.status, { error: e.message, code: e.code });
      return true;
    }
    throw e;
  }
  return false;
}

/**
 * Declarative task runner routes (round-5 task R5-S2) — VS Code
 * tasks.json-compatible subset.
 *
 *   GET  /api/tasks/list?root=        list parsed tasks (.ai-factory/tasks.json)
 *   PUT  /api/tasks                  { root?, text } — validate + write
 *   POST /api/tasks/run              { label, root?, projectId? } — run chain
 *   GET  /api/tasks/runs             recent run records (in-memory ring)
 *
 * NOTE (R5 closeout): GET /api/tasks (bare or ?projectId=) is the LEGACY
 * project-tasks endpoint further down the dispatch chain — the runner's
 * list deliberately lives at /api/tasks/list so the two never collide
 * (the collision crashed the desktop: the runner's {tasks,errors,...}
 * object reached CommandPalette which expects TaskSummary[]).
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
 *  - Run records are process-local (restart clears them); output is capped
 *    at 2MB per task with truncation flagged.
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
import { dirname, join, normalize, relative } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  DEFAULT_TIMEOUT_MS,
  flattenPlan,
  parseTasksJson,
  planRun,
  shellCommandLine,
  type PlannedTask,
  type TaskChainResult,
  type TaskDef,
  type TaskRunResult,
} from '@ai-factory/tasks';
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

interface RunRecord {
  id: string;
  label: string;
  ok: boolean;
  stoppedAt: string | null;
  taskCount: number;
  startedAt: string;
  finishedAt: string;
}

const runRecords: RunRecord[] = [];
let runSeq = 0;

function recordRun(chain: TaskChainResult): void {
  runSeq += 1;
  runRecords.push({
    id: `taskrun-${runSeq}`,
    label: chain.requested.join(','),
    ok: chain.ok,
    stoppedAt: chain.stoppedAt,
    taskCount: chain.results.length,
    startedAt: chain.startedAt,
    finishedAt: chain.finishedAt,
  });
  while (runRecords.length > MAX_RUN_RECORDS) runRecords.shift();
}

/** Test seam: wipe run records. */
export function resetTaskRunRecords(): void {
  runRecords.length = 0;
  runSeq = 0;
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
): Promise<ChainRunOutcome> {
  try {
    const chain = await executeChain(label, root, projectId, ctx, actor);
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
 */
function buildArgv(d: TaskRunnerDeps, task: TaskDef): string[] {
  if (task.type === 'process') {
    const tokens = d.checkCommandPolicy(task.command);
    if (tokens.length !== 1) {
      throw new TaskRouteError(
        `task "${task.label}": type "process" command must be a bare binary (use args for arguments)`,
        'process-args-in-command',
      );
    }
    return [tokens[0], ...task.args];
  }
  return d.checkCommandPolicy(shellCommandLine(task));
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
): Promise<TaskChainResult> {
  const startedAt = new Date().toISOString();
  const results: TaskRunResult[] = [];
  let stoppedAt: string | null = null;
  let ok = true;
  // In-flight memo: a shared dependency (diamond) runs exactly once, even
  // when two parallel branches reach it concurrently.
  const inFlight = new Map<string, Promise<boolean>>();

  const runNode = (node: PlannedTask): Promise<boolean> => {
    const label = node.task.label;
    const existing = inFlight.get(label);
    if (existing) return existing;
    const p = (async (): Promise<boolean> => {
      // Dependencies first (fail-closed: any failure stops the chain).
      if (node.parallel) {
        const depResults = await Promise.all(node.dependsOn.map((dep) => runNode(dep)));
        if (depResults.some((r) => !r)) return false;
      } else {
        for (const dep of node.dependsOn) {
          if (!(await runNode(dep))) return false;
        }
      }
      const res = await runTask(d, node.task, root, projectId);
      results.push(res);
      ctx.audit.record(actor, res.status === 'ok' ? 'TASK_RAN' : 'TASK_FAILED', 'task', label, {
        status: res.status,
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        ...(res.error ? { error: res.error } : {}),
      });
      return res.status === 'ok';
    })();
    inFlight.set(label, p);
    return p;
  };

  for (const node of plan) {
    if (!(await runNode(node))) {
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
    argv = buildArgv(d, task);
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
    ran = await runOne(argv, cwd, task.options.env, timeoutMs);
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
  });
  const chain = await executePlan(d, planned.plan, root, projectId, ctx, actor);
  recordRun(chain);
  return chain;
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
      mkdirSync(dirname(tasksFilePath(root)), { recursive: true });
      writeFileSync(tasksFilePath(root), text, 'utf8');
      const actor = (body['actor'] as string | undefined) ?? 'human';
      ctx.audit.record(actor, 'TASKS_SAVED', 'tasks', TASKS_FILE, { count: parsed.tasks.length });
      ctx.json(res, 200, { ok: true, count: parsed.tasks.length, warnings: parsed.warnings });
      return true;
    }

    // ---- run history --------------------------------------------------
    if (path === `${PREFIX}/runs` && method === 'GET') {
      ctx.json(res, 200, { runs: [...runRecords].reverse() });
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

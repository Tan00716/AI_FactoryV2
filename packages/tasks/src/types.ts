/**
 * R5-S2 declarative task runner — shared types.
 *
 * A task is a named, repeatable command declared in `.ai-factory/tasks.json`
 * (VS Code tasks.json-compatible subset). Pure data + deterministic
 * planning live in this package; execution (policy-checked spawn) lives in
 * the server route.
 *
 * HONEST BOUNDARIES (read before extending):
 *  1. Only a documented SUBSET of VS Code tasks.json is supported.
 *     Unknown fields are accepted with a warning, never silently honored.
 *     Background/watch tasks (`isBackground`) are NOT supported in v1 —
 *     there is no persistent watcher; the parser warns and ignores them.
 *  2. `type: "shell"` does NOT run through a real shell. Like the server's
 *     /api/exec path, the command string is tokenized (quote-aware) and
 *     run directly via execFile — no shell interpretation, no `;`, no
 *     `$(...)`. VS Code "shell" semantics are intentionally narrowed for
 *     the execution safety policy.
 *  3. dependsOn forms a DAG. A cycle is a validation error: nothing runs.
 */

export type TaskType = 'shell' | 'process';
export type TaskGroup = 'build' | 'test' | 'none';
export type DependsOrder = 'sequence' | 'parallel';

/** Per-task execution options. */
export interface TaskOptions {
  /** Working dir, relative to the project root (server-jails absolute/escape). */
  cwd?: string;
  /** Additive environment variables (validated: name syntax, denylist, size caps). */
  env?: Record<string, string>;
  /** Per-task timeout in ms. Default 60000, clamped to [1000, 300000]. */
  timeoutMs?: number;
}

/** One declared task (validated form). */
export interface TaskDef {
  label: string;
  type: TaskType;
  command: string;
  args: string[];
  group: TaskGroup;
  detail?: string;
  dependsOn: string[];
  dependsOrder: DependsOrder;
  problemMatcher: string[];
  options: TaskOptions;
}

/** Result of parsing a tasks.json document (fail-closed). */
export interface TasksFileResult {
  version: string | null;
  tasks: TaskDef[];
  /** Fatal: the file is unusable. */
  errors: string[];
  /** Non-fatal: ignored/unsupported fields that were skipped. */
  warnings: string[];
}

/** One node of an executable run plan (dependencies resolved, cycle-free). */
export interface PlannedTask {
  task: TaskDef;
  dependsOn: PlannedTask[];
  /** True when this task's own dependsOrder is 'parallel'. */
  parallel: boolean;
}

/** Result of planning which tasks to run for the requested labels. */
export interface RunPlanResult {
  plan: PlannedTask[];
  errors: string[];
}

/** One node of a task DAG graph (R7-#4): planned shape + layout level. */
export interface DagNode {
  label: string;
  command: string;
  dependsOn: string[];
  /** Longest-path depth: 0 = no dependencies, dependents sit one level higher. */
  level: number;
  /** True when this task's own dependsOrder is 'parallel'. */
  parallel: boolean;
}

/** One DAG edge: `from` (dependency) must finish before `to` (dependent). */
export interface DagEdge {
  from: string;
  to: string;
}

/** A planned DAG graph: nodes + edges, ready for visualization. */
export interface DagGraph {
  nodes: DagNode[];
  edges: DagEdge[];
}

/** Recorded outcome of one executed task. */
export interface TaskRunResult {
  label: string;
  status: 'ok' | 'failed' | 'denied' | 'timeout' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  /** Combined stdout+stderr, capped (see OUTPUT_CAP_BYTES). */
  output: string;
  truncated: boolean;
  /** Problem-matcher diagnostics produced from the output. */
  diagnosticsAdded: number;
  /** Match-rate record from the matcher parse (honest "how much parsed"). */
  matchRate: number;
  error?: string;
  /** Non-fatal observations (e.g. unknown problemMatcher names skipped). */
  notes?: string[];
}

/** Recorded outcome of one POST /api/tasks/run invocation. */
export interface TaskChainResult {
  requested: string[];
  results: TaskRunResult[];
  /** Label of the task that stopped the chain (fail-closed), if any. */
  stoppedAt: string | null;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
}

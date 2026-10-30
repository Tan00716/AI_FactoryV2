/**
 * R5-S2 — dependency planning. Resolves the transitive closure of
 * dependsOn for the requested labels into executable plan trees.
 * Cycles and missing dependencies are validation errors: nothing runs.
 */
import type { DagEdge, DagGraph, DagNode, PlannedTask, RunPlanResult, TaskDef } from './types';

/**
 * Plan execution for the requested task labels. Each requested label
 * yields a PlannedTask tree (dependencies resolved recursively).
 */
export function planRun(tasks: TaskDef[], labels: string[]): RunPlanResult {
  const byLabel = new Map<string, TaskDef>();
  for (const t of tasks) byLabel.set(t.label, t);
  const errors: string[] = [];
  const plan: PlannedTask[] = [];
  const planned = new Map<string, PlannedTask>();

  for (const label of labels) {
    if (!byLabel.has(label)) {
      errors.push(`unknown task "${label}"`);
      continue;
    }
    try {
      plan.push(buildNode(label, byLabel, planned, []));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (errors.length > 0) return { plan: [], errors };
  return { plan, errors };
}

class CycleError extends Error {}

function buildNode(
  label: string,
  byLabel: Map<string, TaskDef>,
  planned: Map<string, PlannedTask>,
  stack: string[],
): PlannedTask {
  // Cycle check BEFORE the memo: a re-entrant visit of an ancestor on the
  // current stack is a cycle even though the node is already memoized
  // (memoization happens before recursion to share diamond nodes).
  const cycleAt = stack.indexOf(label);
  if (cycleAt >= 0) {
    const path = [...stack.slice(cycleAt), label].join(' → ');
    throw new CycleError(`dependency cycle detected: ${path}`);
  }
  const hit = planned.get(label);
  if (hit) return hit;
  const task = byLabel.get(label);
  if (!task) throw new Error(`unknown dependency "${label}"`);
  const node: PlannedTask = { task, dependsOn: [], parallel: task.dependsOrder === 'parallel' };
  // Register before recursing so diamond dependencies share the node and
  // a re-entrant visit hits the memo instead of recursing forever.
  // (Cycle detection uses `stack`; memo hits return the shared node.)
  planned.set(label, node);
  const next = [...stack, label];
  for (const dep of task.dependsOn) {
    node.dependsOn.push(buildNode(dep, byLabel, planned, next));
  }
  return node;
}

/**
 * R7-#4 — save-time cycle detection. Pure DFS over dependsOn edges;
 * unknown dependencies are skipped here (planRun still rejects them at
 * run time) so a dangling reference never masquerades as a cycle.
 * Returns the cycle path with the repeated closing label (e.g.
 * ['a', 'b', 'a']) or null when the graph is acyclic. The first cycle
 * found in declaration order wins, deterministically.
 */
export function detectCycle(tasks: TaskDef[]): string[] | null {
  const byLabel = new Map(tasks.map((t) => [t.label, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const dfs = (label: string, stack: string[]): string[] | null => {
    const s = state.get(label);
    if (s === 'done') return null;
    if (s === 'visiting') {
      const at = stack.indexOf(label);
      return [...stack.slice(at), label];
    }
    state.set(label, 'visiting');
    const task = byLabel.get(label);
    if (task) {
      for (const dep of task.dependsOn) {
        if (!byLabel.has(dep)) continue;
        const hit = dfs(dep, [...stack, label]);
        if (hit) return hit;
      }
    }
    state.set(label, 'done');
    return null;
  };
  for (const t of tasks) {
    const hit = dfs(t.label, []);
    if (hit) return hit;
  }
  return null;
}

/**
 * R7-#4 — build the DAG graph for a planned run: one node per planned
 * task (level = longest dependency chain beneath it) plus one edge per
 * dependency. Callers must have run planRun first and checked errors:
 * a cyclic or unknown-dependency plan has no meaningful levels.
 */
export function dagLevels(plan: PlannedTask[]): DagGraph {
  const flat = flattenPlan(plan);
  const byLabel = new Map(flat.map((t) => [t.label, t]));
  const levelOf = (label: string, visiting: Set<string>): number => {
    const task = byLabel.get(label);
    if (!task || task.dependsOn.length === 0) return 0;
    if (visiting.has(label)) return 0; // defensive: planRun already rejects cycles
    const next = new Set(visiting);
    next.add(label);
    let best = 0;
    for (const dep of task.dependsOn) {
      if (!byLabel.has(dep)) continue;
      best = Math.max(best, levelOf(dep, next) + 1);
    }
    return best;
  };
  const nodes: DagNode[] = flat.map((t) => ({
    label: t.label,
    command: t.type === 'process' ? t.command : `${t.command} ${t.args.join(' ')}`.trim(),
    dependsOn: [...t.dependsOn],
    level: levelOf(t.label, new Set()),
    parallel: t.dependsOrder === 'parallel',
  }));
  const edges: DagEdge[] = [];
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (byLabel.has(dep)) edges.push({ from: dep, to: n.label });
    }
  }
  return { nodes, edges };
}

/**
 * Flatten a plan tree into execution order (dependencies before
 * dependents, each label once, in first-visit order).
 */
export function flattenPlan(plan: PlannedTask[]): TaskDef[] {
  const out: TaskDef[] = [];
  const seen = new Set<string>();
  const visit = (n: PlannedTask): void => {
    for (const d of n.dependsOn) visit(d);
    if (!seen.has(n.task.label)) {
      seen.add(n.task.label);
      out.push(n.task);
    }
  };
  for (const n of plan) visit(n);
  return out;
}

/**
 * Quote one argument for the "shell" type command line. Single-quote
 * with '\'' escaping; safe (printable ASCII) args pass through bare.
 */
export function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Build the command string for type "shell" (then tokenized by the policy). */
export function shellCommandLine(task: TaskDef): string {
  return [task.command, ...task.args.map(quoteArg)].join(' ');
}

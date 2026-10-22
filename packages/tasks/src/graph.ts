/**
 * R5-S2 — dependency planning. Resolves the transitive closure of
 * dependsOn for the requested labels into executable plan trees.
 * Cycles and missing dependencies are validation errors: nothing runs.
 */
import type { PlannedTask, RunPlanResult, TaskDef } from './types';

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

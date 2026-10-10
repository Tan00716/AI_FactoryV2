/**
 * Safe parallel scheduling — spec §61.
 *
 * Takes a task DAG (nodes = tasks, edges = depends_on / blocked_by /
 * parallel_with / child_of) and produces parallel execution batches:
 * topological layering where every task in a batch has no unsatisfied
 * ordering dependency on another task in the same batch.
 *
 * - depends_on / blocked_by / child_of impose ordering (the `to` side of
 *   the edge runs first); a cycle among them is a deadlock → throws.
 * - parallel_with / related_to are hints only and impose no ordering.
 * - Resource concurrency limits are honored by chunking batches so no
 *   batch exceeds maxConcurrency tasks (and optional per-resource caps).
 */

export type ScheduleEdgeKind =
  | 'depends_on'
  | 'blocked_by'
  | 'parallel_with'
  | 'child_of'
  | 'related_to';

export interface ScheduleEdge {
  /** Task that carries the relationship (e.g. the dependent). */
  from: string;
  /** Task the relationship points at (e.g. the dependency). */
  to: string;
  kind: ScheduleEdgeKind;
}

export interface ScheduleInput {
  tasks: string[];
  edges?: ScheduleEdge[];
}

export interface ScheduleOptions {
  /** Max tasks that may run concurrently inside one batch. Default: unbounded. */
  maxConcurrency?: number;
  /** Optional resource affinity for per-resource caps (e.g. task → 'db' | 'gpu'). */
  resourceOf?: (taskId: string) => string | null | undefined;
  /** Per-resource concurrency cap inside a batch, e.g. { db: 1 }. */
  perResourceLimit?: Record<string, number>;
}

export interface ScheduleResult {
  /** Parallel batches in execution order; each inner array runs concurrently. */
  batches: string[][];
  /** Task id → index of the batch it belongs to. */
  level: Record<string, number>;
}

export class ScheduleCycleError extends Error {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(' → ')} → ${cycle[0]}`);
    this.name = 'ScheduleCycleError';
    this.cycle = cycle;
  }
}

export class UnknownTaskError extends Error {
  constructor(id: string) {
    super(`Edge references unknown task: ${id}`);
    this.name = 'UnknownTaskError';
  }
}

/** Edge kinds that impose a hard ordering (the `to` side runs first). */
const ORDERING_KINDS: ReadonlySet<ScheduleEdgeKind> = new Set([
  'depends_on',
  'blocked_by',
  'child_of',
]);

function isOrderingKind(kind: string): boolean {
  return ORDERING_KINDS.has(kind as ScheduleEdgeKind);
}

/** Find one cycle among the remaining nodes (for error reporting). */
function findCycle(
  nodes: Set<string>,
  pred: Map<string, Set<string>>,
): string[] {
  const color = new Map<string, 'white' | 'gray' | 'black'>();
  for (const n of nodes) color.set(n, 'white');
  const path: string[] = [];

  const dfs = (n: string): string[] | null => {
    color.set(n, 'gray');
    path.push(n);
    for (const p of [...(pred.get(n) ?? [])].sort()) {
      if (!nodes.has(p)) continue;
      const c = color.get(p);
      if (c === 'gray') {
        const start = path.indexOf(p);
        return path.slice(start);
      }
      if (c === 'white') {
        const found = dfs(p);
        if (found) return found;
      }
    }
    path.pop();
    color.set(n, 'black');
    return null;
  };

  for (const n of [...nodes].sort()) {
    if (color.get(n) === 'white') {
      const found = dfs(n);
      if (found) return found;
    }
  }
  return [...nodes].sort();
}

export function schedule(input: ScheduleInput, opts: ScheduleOptions = {}): ScheduleResult {
  const { tasks, edges = [] } = input;
  if (!Array.isArray(tasks)) throw new TypeError('input.tasks must be an array');
  const taskSet = new Set(tasks);
  if (taskSet.size !== tasks.length) {
    throw new TypeError('input.tasks contains duplicate ids');
  }

  // pred.get(t) = set of tasks that must run before t.
  const pred = new Map<string, Set<string>>();
  const succ = new Map<string, Set<string>>();
  for (const t of tasks) {
    pred.set(t, new Set());
    succ.set(t, new Set());
  }
  for (const e of edges) {
    if (!taskSet.has(e.from)) throw new UnknownTaskError(e.from);
    if (!taskSet.has(e.to)) throw new UnknownTaskError(e.to);
    if (!isOrderingKind(e.kind)) continue; // parallel_with / related_to: hint only
    if (e.from === e.to) throw new ScheduleCycleError([e.from]);
    pred.get(e.from)!.add(e.to);
    succ.get(e.to)!.add(e.from);
  }

  const maxConcurrency = opts.maxConcurrency ?? Number.POSITIVE_INFINITY;
  if (
    !(
      maxConcurrency === Number.POSITIVE_INFINITY ||
      (Number.isInteger(maxConcurrency) && maxConcurrency >= 1)
    )
  ) {
    throw new TypeError('maxConcurrency must be a positive integer');
  }

  // Kahn layering: each layer = tasks with no remaining ordering deps.
  const remaining = new Set(tasks);
  const indeg = new Map<string, number>([...tasks].map((t) => [t, pred.get(t)!.size]));
  const batches: string[][] = [];
  const level: Record<string, number> = {};
  let batchIndex = 0;

  while (remaining.size > 0) {
    const ready = [...remaining].filter((t) => indeg.get(t) === 0).sort();
    if (ready.length === 0) {
      throw new ScheduleCycleError(findCycle(remaining, pred));
    }
    const chunks = chunkLayer(ready, opts, maxConcurrency);
    for (const chunk of chunks) {
      batches.push(chunk);
      for (const t of chunk) level[t] = batchIndex;
      batchIndex++;
    }
    for (const t of ready) {
      remaining.delete(t);
      for (const s of succ.get(t)!) {
        indeg.set(s, indeg.get(s)! - 1);
      }
    }
  }

  return { batches, level };
}

/**
 * Split one independent layer into sub-batches honoring the global
 * maxConcurrency cap and any per-resource caps (first-fit, deterministic).
 */
function chunkLayer(
  layer: string[],
  opts: ScheduleOptions,
  maxConcurrency: number,
): string[][] {
  const { resourceOf, perResourceLimit } = opts;
  if (!resourceOf && !Number.isFinite(maxConcurrency)) return [layer];
  const chunks: string[][] = [];
  const chunkResourceUse: Array<Map<string, number>> = [];

  for (const taskId of layer) {
    const resource = resourceOf?.(taskId) ?? null;
    const cap = resource && perResourceLimit ? perResourceLimit[resource] : undefined;
    let placed = false;
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].length >= maxConcurrency) continue;
      if (resource && cap !== undefined && (chunkResourceUse[i].get(resource) ?? 0) >= cap) continue;
      chunks[i].push(taskId);
      if (resource) {
        chunkResourceUse[i].set(resource, (chunkResourceUse[i].get(resource) ?? 0) + 1);
      }
      placed = true;
      break;
    }
    if (!placed) {
      chunks.push([taskId]);
      chunkResourceUse.push(
        resource ? new Map([[resource, 1]]) : new Map(),
      );
    }
  }
  return chunks;
}

/** Parallel-with hints declared for a pair, if any (informational). */
export function parallelHints(edges: ScheduleEdge[]): Array<{ a: string; b: string }> {
  return edges
    .filter((e) => e.kind === 'parallel_with')
    .map((e) => ({ a: e.from, b: e.to }));
}

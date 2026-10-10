/**
 * @ai-factory/knowledge — hierarchical query with scope fallback (spec §50).
 *
 * Hierarchy (most specific first):
 *   TASK → EMPLOYEE → PROJECT → ORGANIZATION → GLOBAL
 *
 * A query issued from a task context checks the most specific scope first
 * and falls back level by level until a hit is found at every level.
 * Items only match the scope ids of the caller's own chain — another
 * project's knowledge never leaks in.
 */
import type {
  Clock,
  KnowledgeItem,
  KnowledgeScope,
  LifecycleState,
  QueryContext,
  QueryHit,
} from './types';
import { SCOPE_LEVELS, SCOPE_SPECIFICITY, systemClock } from './types';

export interface QueryOptions {
  /** Lifecycle states to include; default: only ACTIVE. */
  states?: readonly LifecycleState[];
  /** Require all of these tags. */
  tags?: readonly string[];
  limit?: number;
  clock?: Clock;
}

/**
 * Ancestor ids on the item must agree with the caller's context wherever
 * both define them — a task item from project A is invisible to project B.
 */
function chainConsistent(s: KnowledgeScope, ctx: QueryContext): boolean {
  const pairs: Array<[string | undefined, string | undefined]> = [
    [s.organizationId, ctx.organizationId],
    [s.projectId, ctx.projectId],
    [s.employeeId, ctx.employeeId],
  ];
  return pairs.every(([a, b]) => a === undefined || b === undefined || a === b);
}

/**
 * Does `item` belong to the caller's scope chain, and at which level?
 * Returns the matched scope, or null when the item is out of chain.
 */
export function matchScope(item: KnowledgeItem, ctx: QueryContext): KnowledgeScope | null {
  const s = item.scope;
  if (!chainConsistent(s, ctx)) return null;
  switch (s.level) {
    case 'TASK':
      return s.taskId !== undefined && s.taskId === ctx.taskId ? s : null;
    case 'EMPLOYEE':
      return s.employeeId !== undefined && s.employeeId === ctx.employeeId ? s : null;
    case 'PROJECT':
      return s.projectId !== undefined && s.projectId === ctx.projectId ? s : null;
    case 'ORGANIZATION':
      return s.organizationId !== undefined && s.organizationId === ctx.organizationId ? s : null;
    case 'GLOBAL':
      return s;
  }
}

/**
 * Query items from the caller's position in the hierarchy.
 *
 * Results from every level of the chain are returned (fallback), ordered
 * most-specific first, then most-recently-updated. Each hit reports which
 * scope level it came from.
 */
export function queryKnowledge(
  items: readonly KnowledgeItem[],
  ctx: QueryContext,
  opts: QueryOptions = {},
): QueryHit[] {
  const states: readonly LifecycleState[] = opts.states ?? ['ACTIVE'];
  const hits: QueryHit[] = [];

  for (const item of items) {
    if (!states.includes(item.state)) continue;
    if (opts.tags && !opts.tags.every((t) => item.tags.includes(t))) continue;
    const matched = matchScope(item, ctx);
    if (!matched) continue;
    hits.push({
      item,
      matchedScope: matched,
      specificity: SCOPE_SPECIFICITY[matched.level],
    });
  }

  hits.sort(
    (a, b) =>
      b.specificity - a.specificity || b.item.updatedAt - a.item.updatedAt,
  );
  return opts.limit !== undefined ? hits.slice(0, opts.limit) : hits;
}

/** Order of fallback used by queries, most specific first. */
export function fallbackOrder(): readonly (typeof SCOPE_LEVELS)[number][] {
  return [...SCOPE_LEVELS].reverse();
}

/** Current time, honoring an optional injected clock. */
export function nowOf(opts: { clock?: Clock } = {}): number {
  return (opts.clock ?? systemClock).now();
}

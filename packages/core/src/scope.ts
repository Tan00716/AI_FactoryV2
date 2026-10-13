/**
 * Subtask inheritance + Scope Checker — spec §17.4 (G-11, Batch 18).
 *
 * §17.4: "子任务继承 root authorization、需求版本、相关 AC、政策上限
 * 和预算。每个子任务必须说明与父目标的关系；Scope Checker 拒绝无关
 * 工作。"
 *
 * Two halves live here:
 *
 *  1. The pure comparison helpers createSubtask() enforces while
 *     inheriting (authorization breadth, ceiling subset, budget
 *     narrowing) — shared so the manager and the checker can never
 *     disagree about what "wider than root" means.
 *
 *  2. The Scope Checker itself: given a task (or a proposed subtask
 *     under a parent) it judges the proposal against the ROOT task's
 *     recorded authorization scope and returns every violation,
 *     structured — it refuses unrelated work by naming exactly which
 *     dimension leaves the root's scope, instead of a bare no.
 *
 * Inheritance rules (createSubtask; the spec lists the items, the
 * "never wider than root" principle is the reading applied here and
 * is the same subset rule §12.2 enforces for delegations):
 *  - authorization: inherited from the ROOT. Unspecified → the
 *    root's status verbatim (including REVOKED/EXPIRED: work filed
 *    under a dead authorization is recorded dead, not quietly
 *    resurrected). Explicitly requested → must not be broader than
 *    the root's, else ScopeViolationError. A dead root
 *    (REVOKED/EXPIRED) admits no live child at all.
 *  - requirement version: root's requirementRef, unless the caller
 *    pins a different one explicitly (a caller decision; the Scope
 *    Checker flags the divergence, creation does not forbid it).
 *  - 相关 AC: root's acceptanceCriteria, unless the caller supplies
 *    the subtask's own (the relevant subset/refinement).
 *  - 政策上限 (policy ceiling): root's, unless the caller supplies
 *    one — which must be a SUBSET of the root's, else
 *    ScopeViolationError (§12.2's scope-subset rule).
 *  - 预算 (budget envelope): root's, unless the caller supplies one
 *    — which must narrow the root's dimension by dimension (a
 *    dimension the root never budgeted is a cap of 0), else
 *    ScopeViolationError.
 *
 * What is NOT inherited: constraints. §17.4's list does not name
 * them — they are the subtask's own recorded limits, supplied by its
 * creator as before.
 */

import type { Task, TaskAuthorizationStatus } from './types';
import { effectiveAuthorizationStatus } from './tasks';

/** A subtask creation or scope proposal asked for more than the root holds. */
export class ScopeViolationError extends Error {
  readonly violations: ScopeViolation[];
  constructor(taskId: string, violations: ScopeViolation[]) {
    super(
      `Scope violation under root task ${taskId}: ` +
        violations.map((v) => v.detail).join('; '),
    );
    this.name = 'ScopeViolationError';
    this.violations = violations;
  }
}

export type ScopeViolationKind =
  | 'AUTHORIZATION'
  | 'POLICY_CEILING'
  | 'BUDGET'
  | 'ACCEPTANCE_CRITERIA'
  | 'REQUIREMENT'
  | 'RELATION';

export interface ScopeViolation {
  kind: ScopeViolationKind;
  detail: string;
  /** The offending item (token / dimension / AC text), when singular. */
  item?: string;
}

export interface ScopeCheckResult {
  ok: boolean;
  /** The root the judgement was made against. */
  rootTaskId: string;
  violations: ScopeViolation[];
}

/**
 * Authorization breadth on the live axis: DRAFT ⊂ WAITING ⊂
 * AUTHORIZED. REVOKED/EXPIRED are not ranks — they are dead states,
 * handled separately (a dead root admits no live child, and no live
 * rank is broader or narrower than a dead one).
 */
const AUTHORIZATION_RANK: Record<string, number> = {
  DRAFT: 0,
  WAITING_HUMAN_DISPATCH: 1,
  AUTHORIZED: 2,
};

export function isDeadAuthorization(s: TaskAuthorizationStatus): boolean {
  return s === 'REVOKED' || s === 'EXPIRED';
}

/**
 * The authorization a subtask may hold under a root with status
 * `rootStatus`, when the caller asked for `requested` (or nothing).
 * Returns the status to inherit, or a violation describing why the
 * request is wider than the root.
 */
export function resolveInheritedAuthorization(
  rootStatus: TaskAuthorizationStatus,
  requested: TaskAuthorizationStatus | undefined,
): { status: TaskAuthorizationStatus } | { violation: ScopeViolation } {
  if (requested === undefined) return { status: rootStatus };
  if (isDeadAuthorization(rootStatus)) {
    return {
      violation: {
        kind: 'AUTHORIZATION',
        detail:
          `root authorization is ${rootStatus} — no subtask may hold ` +
          `${requested} under a dead root authorization`,
        item: requested,
      },
    };
  }
  if (isDeadAuthorization(requested)) {
    // Asking to file the child directly into a dead state is the
    // caller's recorded decision, never wider than the root.
    return { status: requested };
  }
  if (AUTHORIZATION_RANK[requested]! > AUTHORIZATION_RANK[rootStatus]!) {
    return {
      violation: {
        kind: 'AUTHORIZATION',
        detail:
          `requested authorization ${requested} is broader than the ` +
          `root's ${rootStatus} — a subtask must not be wider than its root`,
        item: requested,
      },
    };
  }
  return { status: requested };
}

/** Ceiling tokens in `child` that the root's ceiling does not contain. */
export function ceilingOverflow(
  child: readonly string[],
  root: readonly string[],
): string[] {
  const allowed = new Set(root);
  return child.filter((t) => !allowed.has(t));
}

export interface BudgetOverflow {
  dimension: string;
  requested: number;
  cap: number;
}

/**
 * Dimensions where a proposed envelope exceeds the root's. A
 * dimension the root never budgeted has a cap of 0 (the root holds
 * no budget for it, so any positive ask is wider than the root).
 */
export function budgetOverflow(
  child: Readonly<Record<string, number>>,
  root: Readonly<Record<string, number>>,
): BudgetOverflow[] {
  const out: BudgetOverflow[] = [];
  for (const [dimension, requested] of Object.entries(child)) {
    const cap = root[dimension] ?? 0;
    if (requested > cap) out.push({ dimension, requested, cap });
  }
  return out;
}

/**
 * The root of a task: follow parentTaskId to the topmost ancestor.
 * Cycle-safe (a visited set — §17.1 forbids parent cycles, but the
 * walk must never loop forever on corrupt data) and tolerant of a
 * dangling parent (the last resolvable task is the root).
 */
export function rootOfTask(
  getTask: (id: string) => Task | undefined,
  task: Task,
): Task {
  const seen = new Set<string>([task.id]);
  let cur = task;
  while (cur.parentTaskId) {
    if (seen.has(cur.parentTaskId)) break;
    const parent = getTask(cur.parentTaskId);
    if (!parent) break;
    seen.add(parent.id);
    cur = parent;
  }
  return cur;
}

/** A proposed subtask, judged before (or without) creating it. */
export interface SubtaskScopeProposal {
  /** §17.4 — how the subtask serves its parent's goal. */
  relation?: string;
  /** Explicitly requested initial authorization (see inheritance rules). */
  authorizationStatus?: TaskAuthorizationStatus;
  /** Scope tokens the subtask's work would touch. */
  scopeTokens?: string[];
  /** Ceiling the subtask would carry (must narrow the root's). */
  policyCeiling?: string[];
  /** Envelope the subtask would carry (must narrow the root's). */
  budgetEnvelope?: Record<string, number>;
  /** ACs the subtask would carry (must be among the root's). */
  acceptanceCriteria?: string[];
  /** Requirement pin the subtask would carry (must match the root's pin). */
  requirementRef?: string;
}

/**
 * Scope Checker for a proposed subtask under `parentId`: judge the
 * proposal against the ROOT of that parent. Every dimension the root
 * recorded is checked; a dimension the root never recorded (no
 * ceiling, no envelope, no pin) constrains nothing and says so by
 * its absence from the violations — the checker refuses what it can
 * prove is out of scope, it does not invent scope the root never had.
 */
export function checkSubtaskScope(
  getTask: (id: string) => Task | undefined,
  parentId: string,
  proposal: SubtaskScopeProposal,
): ScopeCheckResult {
  const parent = getTask(parentId);
  if (!parent) {
    return {
      ok: false,
      rootTaskId: parentId,
      violations: [
        {
          kind: 'AUTHORIZATION',
          detail: `parent task ${parentId} does not exist — no root authorization to inherit`,
        },
      ],
    };
  }
  const root = rootOfTask(getTask, parent);
  const violations: ScopeViolation[] = [];

  // §17.4 — the relation to the parent's goal must be stated.
  if (!proposal.relation?.trim()) {
    violations.push({
      kind: 'RELATION',
      detail:
        'the subtask does not state its relation to the parent goal (§17.4)',
    });
  }

  const rootStatus = effectiveAuthorizationStatus(root);
  const auth = resolveInheritedAuthorization(
    rootStatus,
    proposal.authorizationStatus,
  );
  if ('violation' in auth) violations.push(auth.violation);

  // Policy ceiling: both the tokens the work would touch and a
  // ceiling the child would carry must stay inside the root's.
  if (root.policyCeiling !== undefined) {
    for (const token of ceilingOverflow(
      proposal.scopeTokens ?? [],
      root.policyCeiling,
    )) {
      violations.push({
        kind: 'POLICY_CEILING',
        detail: `scope token '${token}' is outside the root's policy ceiling`,
        item: token,
      });
    }
    if (proposal.policyCeiling !== undefined) {
      for (const token of ceilingOverflow(
        proposal.policyCeiling,
        root.policyCeiling,
      )) {
        violations.push({
          kind: 'POLICY_CEILING',
          detail:
            `proposed policy ceiling token '${token}' is wider than the root's ceiling`,
          item: token,
        });
      }
    }
  }

  if (root.budgetEnvelope !== undefined && proposal.budgetEnvelope !== undefined) {
    for (const o of budgetOverflow(proposal.budgetEnvelope, root.budgetEnvelope)) {
      violations.push({
        kind: 'BUDGET',
        detail:
          `budget dimension '${o.dimension}' asks ${o.requested} but the root's envelope caps it at ${o.cap}`,
        item: o.dimension,
      });
    }
  }

  if (proposal.acceptanceCriteria !== undefined) {
    const rootAcs = new Set(root.acceptanceCriteria);
    for (const ac of proposal.acceptanceCriteria) {
      if (!rootAcs.has(ac)) {
        violations.push({
          kind: 'ACCEPTANCE_CRITERIA',
          detail: `acceptance criterion is not among the root's ACs: ${ac}`,
          item: ac,
        });
      }
    }
  }

  if (
    proposal.requirementRef !== undefined &&
    root.requirementRef !== undefined &&
    proposal.requirementRef !== root.requirementRef
  ) {
    violations.push({
      kind: 'REQUIREMENT',
      detail:
        `proposed requirement pin ${proposal.requirementRef} diverges from the root's pin ${root.requirementRef}`,
      item: proposal.requirementRef,
    });
  }

  return { ok: violations.length === 0, rootTaskId: root.id, violations };
}

/**
 * Scope Checker for work proposed on an EXISTING task: is executing
 * `action` on this task inside its root authorization? The root is
 * the authorization source (§17.4: subtasks inherit root
 * authorization), so both the task's own status and its root's are
 * judged — an AUTHORIZED child under a since-revoked root is out of
 * scope, and so is a not-yet-authorized task under any root.
 */
export function checkTaskScope(
  getTask: (id: string) => Task | undefined,
  taskId: string,
  proposal: { action: string },
): ScopeCheckResult {
  const task = getTask(taskId);
  if (!task) {
    return {
      ok: false,
      rootTaskId: taskId,
      violations: [
        {
          kind: 'AUTHORIZATION',
          detail: `task ${taskId} does not exist — no authorization to check against`,
        },
      ],
    };
  }
  const root = rootOfTask(getTask, task);
  const violations: ScopeViolation[] = [];
  const own = effectiveAuthorizationStatus(task);
  if (own !== 'AUTHORIZED') {
    violations.push({
      kind: 'AUTHORIZATION',
      detail:
        `task authorization_status is ${own} — '${proposal.action}' is outside its authorization (§17.2)`,
      item: proposal.action,
    });
  }
  if (root.id !== task.id) {
    const rootStatus = effectiveAuthorizationStatus(root);
    if (rootStatus !== 'AUTHORIZED') {
      violations.push({
        kind: 'AUTHORIZATION',
        detail:
          `root task ${root.id} authorization_status is ${rootStatus} — work under it is outside the root authorization (§17.4)`,
        item: proposal.action,
      });
    }
    if (!task.parentRelation?.trim()) {
      violations.push({
        kind: 'RELATION',
        detail:
          'the subtask does not state its relation to the parent goal (§17.4)',
      });
    }
  }
  return { ok: violations.length === 0, rootTaskId: root.id, violations };
}

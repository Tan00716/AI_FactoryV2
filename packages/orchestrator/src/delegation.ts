/**
 * Delegation — spec §12.2 (Management Runtime: 委托对象).
 *
 * Every delegation produces a delegation record carrying the 17 fields
 * mandated by §12.2:
 *   delegation_id, parent_delegation_id, delegator, delegatee,
 *   root_authorization_id, task_id, requirement_version, scope, AC_refs,
 *   allowed_outputs, evidence_requirements, capability_ceiling,
 *   budget_reservation, due_at, reporting_targets, review_policy,
 *   status, version.
 *
 * Hard rules enforced by DelegationManager (all pure, injectable clock):
 *  1. Scope subset: a child's effective scope MUST be a subset of its
 *     parent's scope; a superset is rejected with SCOPE_VIOLATION.
 *  2. Budget reservation: a child's budget_reservation is carved OUT of the
 *     parent's remaining reservation — it never copies the total budget.
 *     Reserving more than the parent's remaining budget is rejected with
 *     BUDGET_EXCEEDED.
 *  3. Chain shape: the delegation graph MUST be acyclic and depth-limited;
 *     cycles → CYCLE_VIOLATION, depth overflow → DEPTH_EXCEEDED.
 *  4. Supervision: delegating a task does NOT transfer supervision. The
 *     delegator stays `oversight_by`; `owner` only changes on handoff().
 *     Only the current owner may hand off.
 *
 * Zero external dependencies. Budget is a plain number of budget units
 * (the unit semantics live in @ai-factory/resources); this module only
 * enforces the reservation invariant.
 */
import { randomUUID } from 'node:crypto';
import type { Clock } from './scheduler';

const defaultClock: Clock = { now: () => Date.now() };

/** Scope element token, e.g. "project:crm", "path:/workspace/crm", "tool:shell.exec". */
export type ScopeToken = string;

export type DelegationStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export type ReviewPolicy = 'manager-review' | 'independent-qa' | 'human-approval' | 'none';

export type DelegationErrorCode =
  | 'SCOPE_VIOLATION'
  | 'CAPABILITY_VIOLATION'
  | 'BUDGET_EXCEEDED'
  | 'DEPTH_EXCEEDED'
  | 'CYCLE_VIOLATION'
  | 'DELEGATION_NOT_FOUND'
  | 'PARENT_NOT_ACTIVE'
  | 'ROOT_AUTHORIZATION_MISMATCH'
  | 'INVALID_STATE'
  | 'NOT_OWNER';

export class DelegationError extends Error {
  readonly code: DelegationErrorCode;
  constructor(code: DelegationErrorCode, message: string) {
    super(message);
    this.name = 'DelegationError';
    this.code = code;
  }
}

/** §12.2 委托对象 — the 17 mandated fields. */
export interface Delegation {
  delegation_id: string;
  parent_delegation_id: string | null;
  delegator: string;
  delegatee: string;
  root_authorization_id: string;
  task_id: string;
  requirement_version: string;
  scope: ScopeToken[];
  AC_refs: string[];
  allowed_outputs: string[];
  evidence_requirements: string[];
  capability_ceiling: ScopeToken[];
  budget_reservation: number;
  due_at: string | null;
  reporting_targets: string[];
  review_policy: ReviewPolicy;
  status: DelegationStatus;
  version: number;
  /**
   * Supervision retention (§12.2: 上司交任务给下级后仍承担监督责任).
   * Always the delegator; delegation alone never moves it.
   */
  oversight_by: string;
  /**
   * Execution owner. Starts as the delegator; ONLY handoff() moves it to
   * the delegatee (§12.2: Handoff 才变更执行所有权).
   */
  owner: string;
  handoff_at: string | null;
  created_at: string;
}

export interface CreateDelegationInput {
  delegation_id?: string;
  parent_delegation_id?: string | null;
  delegator: string;
  delegatee: string;
  root_authorization_id: string;
  task_id: string;
  requirement_version: string;
  scope: ScopeToken[];
  AC_refs?: string[];
  allowed_outputs?: string[];
  evidence_requirements?: string[];
  capability_ceiling?: ScopeToken[];
  budget_reservation: number;
  due_at?: string | null;
  reporting_targets?: string[];
  review_policy?: ReviewPolicy;
}

export interface DelegationManagerOptions {
  clock?: Clock;
  /** Max chain depth (root = depth 1). Default 5 per §12.3 limits. */
  maxDepth?: number;
}

/** Default delegation chain depth limit (§12.3: 深度有上限). */
export const DEFAULT_MAX_DELEGATION_DEPTH = 5;

/**
 * Pure subset check over scope/capability token sets.
 * A child's scope must be a subset of the parent's scope.
 */
export function isSubset(child: readonly ScopeToken[], parent: readonly ScopeToken[]): boolean {
  const allowed = new Set(parent);
  return child.every((t) => allowed.has(t));
}

export class DelegationManager {
  private readonly clock: Clock;
  private readonly maxDepth: number;
  private readonly store = new Map<string, Delegation>();

  constructor(options: DelegationManagerOptions = {}) {
    this.clock = options.clock ?? defaultClock;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
  }

  /** Chain from the root down to `delegation` (inclusive), for depth/cycle checks. */
  chainOf(id: string): Delegation[] {
    const chain: Delegation[] = [];
    const seen = new Set<string>();
    let cur: Delegation | undefined = this.store.get(id);
    while (cur) {
      if (seen.has(cur.delegation_id)) {
        throw new DelegationError(
          'CYCLE_VIOLATION',
          `delegation chain contains a cycle at ${cur.delegation_id}`,
        );
      }
      seen.add(cur.delegation_id);
      chain.unshift(cur);
      cur = cur.parent_delegation_id ? this.store.get(cur.parent_delegation_id) : undefined;
    }
    return chain;
  }

  /** Depth of a delegation (root = 1). */
  depthOf(id: string): number {
    return this.chainOf(id).length;
  }

  /** Direct children of a delegation. */
  childrenOf(id: string): Delegation[] {
    return [...this.store.values()].filter((d) => d.parent_delegation_id === id);
  }

  /**
   * Budget still available for further sub-delegation under `id`:
   * own reservation minus what direct children already reserved.
   */
  remainingBudget(id: string): number {
    const d = this.require(id);
    const reservedByChildren = this.childrenOf(id).reduce(
      (sum, c) => sum + c.budget_reservation,
      0,
    );
    return d.budget_reservation - reservedByChildren;
  }

  get(id: string): Delegation {
    return { ...this.require(id) };
  }

  /**
   * Create a root delegation (no parent). The root reserves the task's full
   * budget; children carve portions out of it via create().
   */
  createRoot(input: CreateDelegationInput): Delegation {
    if (input.parent_delegation_id) {
      throw new DelegationError(
        'INVALID_STATE',
        'createRoot() takes no parent; use create() for child delegations',
      );
    }
    return this.insert(null, input);
  }

  /** Create a child delegation under an ACTIVE parent, enforcing §12.2 rules. */
  create(input: CreateDelegationInput): Delegation {
    const parentId = input.parent_delegation_id;
    if (!parentId) {
      throw new DelegationError(
        'DELEGATION_NOT_FOUND',
        'child delegation requires a parent_delegation_id; use createRoot() for roots',
      );
    }
    const parent = this.require(parentId);
    if (parent.status !== 'ACTIVE') {
      throw new DelegationError(
        'PARENT_NOT_ACTIVE',
        `parent delegation ${parentId} is ${parent.status}; only ACTIVE parents accept children`,
      );
    }
    if (input.root_authorization_id !== parent.root_authorization_id) {
      throw new DelegationError(
        'ROOT_AUTHORIZATION_MISMATCH',
        `child root_authorization_id ${input.root_authorization_id} does not match parent ${parent.root_authorization_id}`,
      );
    }
    const scope = input.scope ?? [];
    if (!isSubset(scope, parent.scope)) {
      throw new DelegationError(
        'SCOPE_VIOLATION',
        `child scope must be a subset of parent scope ${JSON.stringify(parent.scope)}; got ${JSON.stringify(scope)}`,
      );
    }
    const ceiling = input.capability_ceiling ?? parent.capability_ceiling;
    if (!isSubset(ceiling, parent.capability_ceiling)) {
      throw new DelegationError(
        'CAPABILITY_VIOLATION',
        `child capability_ceiling must be a subset of the parent's capability_ceiling`,
      );
    }
    const childDepth = this.depthOf(parentId) + 1;
    if (childDepth > this.maxDepth) {
      throw new DelegationError(
        'DEPTH_EXCEEDED',
        `delegation depth ${childDepth} exceeds limit ${this.maxDepth}`,
      );
    }
    if (input.budget_reservation < 0) {
      throw new DelegationError('BUDGET_EXCEEDED', 'budget_reservation cannot be negative');
    }
    const remaining = this.remainingBudget(parentId);
    if (input.budget_reservation > remaining) {
      throw new DelegationError(
        'BUDGET_EXCEEDED',
        `reservation ${input.budget_reservation} exceeds parent ${parentId} remaining budget ${remaining}; ` +
          `budget is reserved from the parent, not copied from the total`,
      );
    }
    return this.insert(parent, { ...input, capability_ceiling: ceiling });
  }

  /**
   * Re-parent an existing delegation. Revalidates scope, capability,
   * budget, depth and acyclicity against the new parent.
   */
  reparent(id: string, newParentId: string): Delegation {
    const d = this.require(id);
    const newParent = this.require(newParentId);
    if (newParentId === id) {
      throw new DelegationError('CYCLE_VIOLATION', 'a delegation cannot be its own parent');
    }
    // Cycle: the new parent must not be a descendant of `id`.
    const descendants = new Set<string>();
    const walk = (pid: string): void => {
      for (const c of this.childrenOf(pid)) {
        descendants.add(c.delegation_id);
        walk(c.delegation_id);
      }
    };
    walk(id);
    if (descendants.has(newParentId)) {
      throw new DelegationError(
        'CYCLE_VIOLATION',
        `reparenting ${id} under ${newParentId} would create a cycle`,
      );
    }
    if (newParent.status !== 'ACTIVE') {
      throw new DelegationError(
        'PARENT_NOT_ACTIVE',
        `new parent ${newParentId} is ${newParent.status}`,
      );
    }
    if (d.root_authorization_id !== newParent.root_authorization_id) {
      throw new DelegationError('ROOT_AUTHORIZATION_MISMATCH', 'root authorization must match');
    }
    if (!isSubset(d.scope, newParent.scope)) {
      throw new DelegationError('SCOPE_VIOLATION', 'scope is not a subset of the new parent scope');
    }
    if (!isSubset(d.capability_ceiling, newParent.capability_ceiling)) {
      throw new DelegationError('CAPABILITY_VIOLATION', 'capability ceiling exceeds the new parent');
    }
    if (this.depthOf(newParentId) + 1 > this.maxDepth) {
      throw new DelegationError('DEPTH_EXCEEDED', 'reparenting would exceed the depth limit');
    }
    if (d.budget_reservation > this.remainingBudget(newParentId)) {
      throw new DelegationError(
        'BUDGET_EXCEEDED',
        'new parent has insufficient remaining budget for this reservation',
      );
    }
    const updated: Delegation = { ...d, parent_delegation_id: newParentId, version: d.version + 1 };
    this.store.set(id, updated);
    return { ...updated };
  }

  /**
   * Handoff: the ONLY operation that moves execution ownership.
   * Only the current owner may hand off; oversight stays with the delegator.
   */
  handoff(id: string, actor: string): Delegation {
    const d = this.require(id);
    if (d.status !== 'ACTIVE') {
      throw new DelegationError(
        'INVALID_STATE',
        `handoff requires ACTIVE delegation; ${id} is ${d.status}`,
      );
    }
    if (actor !== d.owner) {
      throw new DelegationError(
        'NOT_OWNER',
        `only the current owner (${d.owner}) may hand off; ${actor} is not the owner`,
      );
    }
    const now = new Date(this.clock.now()).toISOString();
    const updated: Delegation = {
      ...d,
      owner: d.delegatee,
      oversight_by: d.delegator, // supervision stays with the delegator (§12.2)
      handoff_at: now,
      version: d.version + 1,
    };
    this.store.set(id, updated);
    return { ...updated };
  }

  activate(id: string): Delegation {
    return this.transition(id, 'ACTIVE', ['DRAFT']);
  }

  complete(id: string): Delegation {
    return this.transition(id, 'COMPLETED', ['ACTIVE']);
  }

  cancel(id: string): Delegation {
    return this.transition(id, 'CANCELLED', ['DRAFT', 'ACTIVE']);
  }

  private transition(id: string, to: DelegationStatus, from: DelegationStatus[]): Delegation {
    const d = this.require(id);
    if (!from.includes(d.status)) {
      throw new DelegationError(
        'INVALID_STATE',
        `cannot transition ${id} from ${d.status} to ${to}`,
      );
    }
    const updated: Delegation = { ...d, status: to, version: d.version + 1 };
    this.store.set(id, updated);
    return { ...updated };
  }

  private insert(
    parent: Delegation | null,
    input: CreateDelegationInput & { capability_ceiling?: ScopeToken[] },
  ): Delegation {
    const id = input.delegation_id ?? randomUUID();
    if (this.store.has(id)) {
      throw new DelegationError('INVALID_STATE', `delegation_id ${id} already exists`);
    }
    const now = new Date(this.clock.now()).toISOString();
    const d: Delegation = {
      delegation_id: id,
      parent_delegation_id: parent ? parent.delegation_id : null,
      delegator: input.delegator,
      delegatee: input.delegatee,
      root_authorization_id: input.root_authorization_id,
      task_id: input.task_id,
      requirement_version: input.requirement_version,
      scope: [...input.scope],
      AC_refs: [...(input.AC_refs ?? [])],
      allowed_outputs: [...(input.allowed_outputs ?? [])],
      evidence_requirements: [...(input.evidence_requirements ?? [])],
      capability_ceiling: [...(input.capability_ceiling ?? input.scope)],
      budget_reservation: input.budget_reservation,
      due_at: input.due_at ?? null,
      reporting_targets: [...(input.reporting_targets ?? [])],
      review_policy: input.review_policy ?? 'manager-review',
      status: 'DRAFT',
      version: 1,
      // §12.2: supervision stays with the delegator; owner moves only on handoff.
      oversight_by: input.delegator,
      owner: input.delegator,
      handoff_at: null,
      created_at: now,
    };
    this.store.set(id, d);
    return { ...d };
  }

  private require(id: string): Delegation {
    const d = this.store.get(id);
    if (!d) {
      throw new DelegationError('DELEGATION_NOT_FOUND', `unknown delegation ${id}`);
    }
    return d;
  }
}

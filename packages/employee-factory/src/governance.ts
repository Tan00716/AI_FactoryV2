/**
 * Agent factory governance — spec §19 (absolute ceilings) and §8.2
 * (relative ceiling: a delegation may not exceed the delegator's
 * grantable set, the task scope, and the organization ceiling;
 * effective permission is the intersection of all constraints).
 *
 * Dynamic agent creation requires policy limits. Every creation goes
 * through enforcePolicy() before the registry is touched: on any
 * violation a GovernanceError (with a machine-readable `reason`) is
 * thrown and nothing is created.
 *
 * Policy knobs (from the spec):
 *   max_children, max_depth, max_concurrent_agents, max_total_agents,
 *   max_runtime, max_budget, allowed_roles, allowed_models,
 *   allowed_tools, allowed_permissions
 */

import type { Agent, AgentRegistry, Permission } from '@ai-factory/core';

/** Factory-wide creation policy (spec §19). */
export interface FactoryPolicy {
  /** Max direct children any single agent may create. */
  maxChildren: number;
  /** Max parent-chain depth; top-level agents are depth 0. */
  maxDepth: number;
  /** Max agents with an active (ONLINE/WORKING) status at once. */
  maxConcurrentAgents: number;
  /** Hard cap on total registered agents. */
  maxTotalAgents: number;
  /** Max runtime budget per created agent (ms). */
  maxRuntimeMs: number;
  /** Max monetary budget per created agent (credits). */
  maxBudget: number;
  /** Role-name fragments an agent's job title must contain (case-insensitive). */
  allowedRoles: string[];
  /** Model identifiers agents may run on. */
  allowedModels: string[];
  /** Tool names agents may be granted. */
  allowedTools: string[];
  /** Permission capabilities (§44) agents may be granted. */
  allowedPermissions: Permission[];
}

/** Machine-readable governance denial reasons (§19 + §8.2). */
export type GovernanceReason =
  | 'too-many-children'
  | 'depth-exceeded'
  | 'too-many-concurrent-agents'
  | 'total-agents-exceeded'
  | 'role-not-allowed'
  | 'model-not-allowed'
  | 'tool-not-allowed'
  | 'permission-not-allowed'
  | 'runtime-exceeds-budget'
  | 'budget-exceeds-limit'
  | 'parent-not-found'
  /** §8.2 — the grant exceeds the delegator's own grantable set. */
  | 'grant-exceeds-granter'
  /** §8.2 — the grant exceeds the task scope it is made under. */
  | 'grant-exceeds-task-scope';

export class GovernanceError extends Error {
  readonly reason: GovernanceReason;
  constructor(reason: GovernanceReason, detail: string) {
    super(`Governance denied: ${reason} — ${detail}`);
    this.name = 'GovernanceError';
    this.reason = reason;
  }
}

/** Input describing the agent about to be created, for policy checks. */
export interface CreationRequest {
  parentAgentId?: string | null;
  /**
   * Delegating agent whose grantable set caps this grant (§8.2:
   * "委托不能超过委托者可授予集合").
   *
   * When set and resolvable to a registry agent, the requested tools
   * and permissions must each be a subset of the granter's own tools
   * and permissions. When absent or not resolvable (e.g. a human
   * delegator), the relative check is skipped — there is no recorded
   * grantable set to compare against, and the check refuses to
   * fabricate one. Absolute (§19) checks always apply.
   */
  granterAgentId?: string | null;
  /**
   * §8.2 "任务范围" (task scope): the scope of the task this grant is
   * made under, in the §12.2 scope-token representation
   * ("tool:<name>", "permission:<name>", "project:<id>", "path:<dir>",
   * …). Only the capability-carrying tokens compare against the
   * grant: requested tools must be covered by a "tool:<tool>" token and
   * requested permissions by a "permission:<permission>" token.
   * Domain tokens ("project:", "path:", …) are not capability grants
   * and are ignored by this check — they are recorded for provenance,
   * never invented as permission.
   *
   * When absent, the check is skipped — there is no recorded task scope
   * to compare against, and the check refuses to fabricate one. When
   * PRESENT (even empty), the check is strict: the grant must be a
   * subset of the token-covered tools/permissions, so a task scope with
   * no "tool:" tokens grants zero tools. Together with the granter-set
   * check this implements §8.2's "有效权限取所有限制交集":
   * requested ⊆ granter ∩ taskScope.
   */
  taskScope?: string[] | null;
  jobTitle: string;
  model?: string;
  tools?: string[];
  permissions?: Permission[];
  estimatedRuntimeMs?: number;
  estimatedBudget?: number;
}

/**
 * Audit intent emitted when the §8.2 relative ceiling denies a grant.
 * The intent is delivered to the sink BEFORE the GovernanceError is
 * thrown (same pattern as approvals' EXCEPTION_GRANT_DENIED).
 */
export interface RelativeCeilingDeniedIntent {
  action: 'RELATIVE_CEILING_DENIED';
  /** The granter (delegator) that was exceeded. */
  actor: string;
  details: {
    granterAgentId: string;
    requestedTools: string[];
    requestedPermissions: Permission[];
    /** Requested tools the granter does not hold. */
    exceededTools: string[];
    /** Requested permissions the granter does not hold. */
    exceededPermissions: Permission[];
  };
}

/**
 * Audit intent emitted when the §8.2 task-scope ceiling denies a grant.
 * The intent is delivered to the sink BEFORE the GovernanceError is
 * thrown (same pattern as approvals' EXCEPTION_GRANT_DENIED).
 */
export interface TaskScopeCeilingDeniedIntent {
  action: 'TASK_SCOPE_CEILING_DENIED';
  /** The requester performing the grant (granterAgentId). */
  actor: string;
  details: {
    granterAgentId: string;
    /** The task scope the grant was checked against (verbatim). */
    taskScope: string[];
    requestedTools: string[];
    requestedPermissions: Permission[];
    /** Requested tools not covered by a "tool:<name>" token. */
    exceededTools: string[];
    /** Requested permissions not covered by a "permission:<name>" token. */
    exceededPermissions: string[];
  };
}

/** Injectable audit sink for governance denials. */
export type GovernanceAuditSink = (
  intent: RelativeCeilingDeniedIntent | TaskScopeCeilingDeniedIntent,
) => void;

/** Optional knobs for enforcePolicy. */
export interface EnforcePolicyOptions {
  /**
   * Called with a denial intent before the throw. Invoked for the two
   * §8.2 relative-ceiling denials (RELATIVE_CEILING_DENIED and
   * TASK_SCOPE_CEILING_DENIED); absolute (§19) denials keep their
   * pre-existing (throw-only) behavior.
   */
  audit?: GovernanceAuditSink;
}

/**
 * Split §12.2 scope tokens into the capability-carrying names they
 * grant: "tool:<name>" → tools, "permission:<name>" → permissions.
 * Domain tokens ("project:", "path:", …) carry no capability grant and
 * are excluded — they never shrink or widen the tool/permission set.
 */
export function capabilityTokensFromScope(tokens: string[]): {
  tools: string[];
  permissions: string[];
} {
  const tools: string[] = [];
  const permissions: string[] = [];
  for (const token of tokens) {
    const sep = token.indexOf(':');
    if (sep < 0) continue;
    const kind = token.slice(0, sep);
    const name = token.slice(sep + 1);
    if (!name) continue;
    if (kind === 'tool') tools.push(name);
    else if (kind === 'permission') permissions.push(name);
  }
  return { tools, permissions };
}

/** Depth of an agent in the parent chain = number of ancestors (top-level = 0). */export function agentDepth(registry: AgentRegistry, agentId: string | null): number {
  let depth = 0;
  let current: string | null =
    agentId === null ? null : registry.get(agentId).parentAgentId;
  while (current) {
    const agent = registry.get(current); // throws if the chain is broken
    current = agent.parentAgentId;
    depth += 1;
  }
  return depth;
}

/**
 * Enforce the factory policy BEFORE creation. Throws GovernanceError on
 * the first violation found; check order follows the spec §19 list,
 * then the §8.2 relative-ceiling check (§5: AI 不得提高自身/下属权限上限).
 */
export function enforcePolicy(
  registry: AgentRegistry,
  request: CreationRequest,
  policy: FactoryPolicy,
  opts: EnforcePolicyOptions = {},
): void {
  // 1. Parent linkage: children limit + depth limit.
  const parentId = request.parentAgentId ?? null;
  if (parentId) {
    let parent;
    try {
      parent = registry.get(parentId);
    } catch {
      throw new GovernanceError('parent-not-found', `parent agent ${parentId} does not exist`);
    }
    const children = registry.childrenOf(parentId).length;
    if (children >= policy.maxChildren) {
      throw new GovernanceError(
        'too-many-children',
        `agent ${parentId} already has ${children} children (max ${policy.maxChildren})`,
      );
    }
    const depth = agentDepth(registry, parentId) + 1;
    if (depth > policy.maxDepth) {
      throw new GovernanceError(
        'depth-exceeded',
        `new agent would be at depth ${depth} (max ${policy.maxDepth})`,
      );
    }
    void parent;
  } else if (policy.maxDepth < 0) {
    throw new GovernanceError('depth-exceeded', 'no agents may be created at any depth');
  }

  // 2. Population limits.
  const agents = registry.list();
  if (agents.length >= policy.maxTotalAgents) {
    throw new GovernanceError(
      'total-agents-exceeded',
      `${agents.length} agents registered (max ${policy.maxTotalAgents})`,
    );
  }
  const concurrent = agents.filter(
    (a) => a.status === 'ONLINE' || a.status === 'WORKING',
  ).length;
  if (concurrent >= policy.maxConcurrentAgents) {
    throw new GovernanceError(
      'too-many-concurrent-agents',
      `${concurrent} active agents (max ${policy.maxConcurrentAgents})`,
    );
  }

  // 3. Allow-lists: role, model, tools, permissions.
  const title = request.jobTitle.toLowerCase();
  const roleOk = policy.allowedRoles.some((r) => title.includes(r.toLowerCase()));
  if (!roleOk) {
    throw new GovernanceError(
      'role-not-allowed',
      `job title "${request.jobTitle}" matches none of [${policy.allowedRoles.join(', ')}]`,
    );
  }
  const model = request.model ?? 'default';
  if (!policy.allowedModels.includes(model)) {
    throw new GovernanceError(
      'model-not-allowed',
      `model "${model}" not in [${policy.allowedModels.join(', ')}]`,
    );
  }
  for (const tool of request.tools ?? []) {
    if (!policy.allowedTools.includes(tool)) {
      throw new GovernanceError(
        'tool-not-allowed',
        `tool "${tool}" not in [${policy.allowedTools.join(', ')}]`,
      );
    }
  }
  for (const perm of request.permissions ?? []) {
    if (!policy.allowedPermissions.includes(perm)) {
      throw new GovernanceError(
        'permission-not-allowed',
        `permission "${perm}" not in allowed permissions`,
      );
    }
  }

  // 4. Budgets.
  if ((request.estimatedRuntimeMs ?? 0) > policy.maxRuntimeMs) {
    throw new GovernanceError(
      'runtime-exceeds-budget',
      `estimated runtime ${request.estimatedRuntimeMs}ms exceeds ${policy.maxRuntimeMs}ms`,
    );
  }
  if ((request.estimatedBudget ?? 0) > policy.maxBudget) {
    throw new GovernanceError(
      'budget-exceeds-limit',
      `estimated budget ${request.estimatedBudget} exceeds ${policy.maxBudget}`,
    );
  }

  // 5. §8.2 relative ceiling: the grant may not exceed the granter's
  //    own grantable set ("委托不能超过委托者可授予集合").
  //    Absolute checks above are unchanged; effective permission is the
  //    intersection of all constraints.
  const granterId = request.granterAgentId ?? null;
  if (granterId) {
    let granter: Agent | null = null;
    try {
      granter = registry.get(granterId);
    } catch {
      // Not a registry agent (e.g. a human delegator): there is no
      // recorded grantable set to compare against. Skip the relative
      // check rather than fabricate a ceiling; absolute checks stand.
    }
    if (granter) {
      const granterTools = granter.tools;
      const granterPermissions = granter.permissions;
      const exceededTools = (request.tools ?? []).filter(
        (t) => !granterTools.includes(t),
      );
      const exceededPermissions = (request.permissions ?? []).filter(
        (p) => !granterPermissions.includes(p),
      );
      if (exceededTools.length > 0 || exceededPermissions.length > 0) {
        const parts: string[] = [];
        if (exceededTools.length > 0) {
          parts.push(`tools [${exceededTools.join(', ')}]`);
        }
        if (exceededPermissions.length > 0) {
          parts.push(`permissions [${exceededPermissions.join(', ')}]`);
        }
        opts.audit?.({
          action: 'RELATIVE_CEILING_DENIED',
          actor: granterId,
          details: {
            granterAgentId: granterId,
            requestedTools: [...(request.tools ?? [])],
            requestedPermissions: [...(request.permissions ?? [])],
            exceededTools,
            exceededPermissions,
          },
        });
        throw new GovernanceError(
          'grant-exceeds-granter',
          `grant ${parts.join(' and ')} exceeds granter ${granterId}'s grantable set (§8.2)`,
        );
      }
    }
  }

  // 6. §8.2 task scope: the grant may not exceed the task scope it is
  //    made under ("任务范围"). Combined with step 5, the requested
  //    grant must be within granter ∩ taskScope — §8.2's "有效权限取
  //    所有限制交集". Absolute checks (steps 1–4) keep their
  //    first-position order; the two relative checks follow.
  const taskScope = request.taskScope ?? null;
  if (taskScope !== null) {
    const granted = capabilityTokensFromScope(taskScope);
    const exceededTools = (request.tools ?? []).filter(
      (t) => !granted.tools.includes(t),
    );
    const exceededPermissions = (request.permissions ?? []).filter(
      (p) => !granted.permissions.includes(p),
    );
    if (exceededTools.length > 0 || exceededPermissions.length > 0) {
      const parts: string[] = [];
      if (exceededTools.length > 0) {
        parts.push(`tools [${exceededTools.join(', ')}]`);
      }
      if (exceededPermissions.length > 0) {
        parts.push(`permissions [${exceededPermissions.join(', ')}]`);
      }
      opts.audit?.({
        action: 'TASK_SCOPE_CEILING_DENIED',
        actor: granterId ?? 'unknown',
        details: {
          granterAgentId: granterId ?? 'unknown',
          taskScope: [...taskScope],
          requestedTools: [...(request.tools ?? [])],
          requestedPermissions: [...(request.permissions ?? [])],
          exceededTools,
          exceededPermissions,
        },
      });
      throw new GovernanceError(
        'grant-exceeds-task-scope',
        `grant ${parts.join(' and ')} exceeds the task scope (§8.2 任务范围)`,
      );
    }
  }
}

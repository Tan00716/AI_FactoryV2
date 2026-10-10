/**
 * Agent factory governance — spec §19.
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

import type { AgentRegistry, Permission } from '@ai-factory/core';

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

/** Machine-readable governance denial reasons (§19). */
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
  | 'parent-not-found';

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
  jobTitle: string;
  model?: string;
  tools?: string[];
  permissions?: Permission[];
  estimatedRuntimeMs?: number;
  estimatedBudget?: number;
}

/** Depth of an agent in the parent chain = number of ancestors (top-level = 0). */
export function agentDepth(registry: AgentRegistry, agentId: string | null): number {
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
 * the first violation found; check order follows the spec §19 list.
 */
export function enforcePolicy(
  registry: AgentRegistry,
  request: CreationRequest,
  policy: FactoryPolicy,
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
}

/**
 * Agent selection — spec §94.
 *
 * Weighted scoring of candidate agents against a task. All factors are
 * deterministic code; the score explains *why* an agent was chosen (the
 * returned breakdown), while any deeper reasoning ("is the Postgres
 * specialist actually the right call here?") stays in the AI layer.
 *
 * ## Weights (sum = 100, documented)
 *
 * | factor            | weight | what it measures                              |
 * |-------------------|--------|-------------------------------------------------|
 * | skills            | 30     | fraction of requiredSkills the agent has        |
 * | tools             | 20     | fraction of requiredTools the agent has         |
 * | permissions       | 15     | fraction of requiredPermissions the agent has  |
 * | role              | 10     | jobTitle/skill keyword hit for the task domain |
 * | workload          | 10     | inverse of current active workload (cap 3)     |
 * | pastPerformance   | 10     | supplied successRate 0..1 (0.5 when unknown)   |
 * | complexityFit     | 5      | autonomyLevel adequate for task complexity     |
 */
import type { Agent, Permission } from '@ai-factory/core';

export interface SelectionTask {
  requiredSkills: string[];
  requiredTools: string[];
  requiredPermissions: Permission[];
  /** 1 (trivial) .. 5 (very complex). */
  complexity: 1 | 2 | 3 | 4 | 5;
  /** Free-text domain hint, e.g. "PostgreSQL locking bug" — used for role match. */
  domainHint?: string;
}

export interface PastPerformance {
  agentId: string;
  /** 0..1 historical success rate. */
  successRate: number;
}

export const WEIGHTS = {
  skills: 30,
  tools: 20,
  permissions: 15,
  role: 10,
  workload: 10,
  pastPerformance: 10,
  complexityFit: 5,
} as const;

export interface ScoreBreakdown {
  skills: number;
  tools: number;
  permissions: number;
  role: number;
  workload: number;
  pastPerformance: number;
  complexityFit: number;
}

export interface ScoredAgent {
  agent: Agent;
  score: number;
  breakdown: ScoreBreakdown;
}

function fraction(matched: number, total: number): number {
  return total === 0 ? 1 : matched / total;
}

/** Cheap keyword role match: any domain token appearing in jobTitle/skills. */
function roleMatch(agent: Agent, domainHint?: string): number {
  if (!domainHint) return 0.5;
  const tokens = domainHint.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const haystack = `${agent.jobTitle} ${agent.skills.join(' ')}`.toLowerCase();
  if (tokens.length === 0) return 0.5;
  const hits = tokens.filter((t) => t.length > 2 && haystack.includes(t)).length;
  return Math.min(1, hits / Math.min(tokens.length, 3));
}

export function scoreAgent(
  agent: Agent,
  task: SelectionTask,
  options: {
    /** Current active task count for this agent (0 when unknown). */
    activeCount?: number;
    perf?: PastPerformance;
  } = {},
): ScoredAgent {
  const activeCount = options.activeCount ?? 0;
  const successRate = options.perf?.successRate ?? 0.5;

  const skillHits = task.requiredSkills.filter((s) =>
    agent.skills.some((a) => a.toLowerCase().includes(s.toLowerCase()) || s.toLowerCase().includes(a.toLowerCase())),
  ).length;
  const toolHits = task.requiredTools.filter((t) =>
    agent.tools.some((a) => a.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(a.toLowerCase())),
  ).length;
  const permHits = task.requiredPermissions.filter((p) => agent.permissions.includes(p)).length;

  // Workload: full credit at 0 active, linearly decays, 0 credit at 3+.
  const workloadFactor = Math.max(0, 1 - activeCount / 3);

  // Complexity fit: agent should have autonomy headroom for complex tasks.
  // autonomyLevel 0..5 vs complexity 1..5; fit is 1 when autonomy >= complexity-1.
  const complexityFactor = Math.max(0, Math.min(1, (agent.autonomyLevel - task.complexity + 2) / 2));

  const breakdown: ScoreBreakdown = {
    skills: fraction(skillHits, task.requiredSkills.length) * WEIGHTS.skills,
    tools: fraction(toolHits, task.requiredTools.length) * WEIGHTS.tools,
    permissions: fraction(permHits, task.requiredPermissions.length) * WEIGHTS.permissions,
    role: roleMatch(agent, task.domainHint) * WEIGHTS.role,
    workload: workloadFactor * WEIGHTS.workload,
    pastPerformance: Math.max(0, Math.min(1, successRate)) * WEIGHTS.pastPerformance,
    complexityFit: complexityFactor * WEIGHTS.complexityFit,
  };

  const score =
    breakdown.skills +
    breakdown.tools +
    breakdown.permissions +
    breakdown.role +
    breakdown.workload +
    breakdown.pastPerformance +
    breakdown.complexityFit;

  return { agent, score, breakdown };
}

/**
 * Rank candidates for a task, best first. Ties broken deterministically by
 * agent id. Offline/paused/archived agents are excluded (they cannot run).
 */
export function rankCandidates(
  agents: Agent[],
  task: SelectionTask,
  options: {
    workloads?: Map<string, number> | Record<string, number>;
    performances?: PastPerformance[];
  } = {},
): ScoredAgent[] {
  const workloads =
    options.workloads instanceof Map
      ? options.workloads
      : new Map(Object.entries(options.workloads ?? {}));
  const perfById = new Map((options.performances ?? []).map((p) => [p.agentId, p]));

  return agents
    .filter((a) => a.status === 'ONLINE' || a.status === 'IDLE' || a.status === 'WORKING')
    .map((a) =>
      scoreAgent(a, task, {
        activeCount: workloads.get(a.id) ?? 0,
        perf: perfById.get(a.id),
      }),
    )
    .sort((x, y) => y.score - x.score || x.agent.id.localeCompare(y.agent.id));
}

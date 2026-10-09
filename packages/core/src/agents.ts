/**
 * Agent registry — spec §15 (AI Employee), §16 (configuration),
 * §17 (autonomy levels), §44 (permission capabilities, prototype subset).
 */

import { randomUUID } from 'crypto';
import {
  ALL_PERMISSIONS,
  Agent,
  AutonomyLevel,
  Permission,
  nowIso,
} from './types';

export class AgentValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AgentValidationError';
  }
}

export class AgentNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent ${id} not found`);
    this.name = 'AgentNotFoundError';
  }
}

export interface AgentStore {
  save(a: Agent): void;
  get(id: string): Agent | undefined;
  list(): Agent[];
}

export class InMemoryAgentStore implements AgentStore {
  private map = new Map<string, Agent>();
  save(a: Agent): void {
    this.map.set(a.id, structuredClone(a));
  }
  get(id: string): Agent | undefined {
    const a = this.map.get(id);
    return a ? structuredClone(a) : undefined;
  }
  list(): Agent[] {
    return [...this.map.values()].map((a) => structuredClone(a));
  }
}

export interface CreateAgentInput {
  name: string;
  displayName?: string;
  jobTitle: string;
  department?: string;
  parentAgentId?: string | null;
  mission?: string;
  instructions?: string;
  skills?: string[];
  rules?: string[];
  model?: string;
  reasoningLevel?: Agent['reasoningLevel'];
  tools?: string[];
  permissions?: Permission[];
  autonomyLevel?: AutonomyLevel;
}

/**
 * Least-privilege defaults per role family (§2.5). A Coder never gets
 * production deploy or secret access unless explicitly granted.
 */
const ROLE_DEFAULT_PERMISSIONS: Array<{ match: string[]; perms: Permission[] }> = [
  { match: ['pm'], perms: ['filesystem.read', 'agent.create', 'workflow.modify'] },
  { match: ['lead'], perms: ['filesystem.read', 'filesystem.write', 'git.commit', 'agent.create'] },
  {
    match: ['coder', 'engineer', 'developer'],
    perms: [
      'filesystem.read',
      'filesystem.write',
      'shell.execute',
      'git.commit',
      'github.pull_request',
      'database.read',
    ],
  },
  { match: ['qa'], perms: ['filesystem.read', 'shell.execute', 'database.read', 'deploy.dev'] },
  {
    match: ['devops'],
    perms: ['filesystem.read', 'shell.execute', 'git.merge', 'deploy.dev', 'deploy.uat'],
  },
  { match: ['reviewer'], perms: ['filesystem.read', 'github.pull_request'] },
];

export function defaultPermissionsFor(jobTitle: string): Permission[] {
  const key = jobTitle.toLowerCase();
  for (const { match, perms } of ROLE_DEFAULT_PERMISSIONS) {
    if (match.some((m) => key.includes(m))) return [...perms];
  }
  return ['filesystem.read'];
}

export class AgentRegistry {
  constructor(private store: AgentStore = new InMemoryAgentStore()) {}

  /** §15/§17 — register an employee; validates autonomy level + permissions. */
  register(input: CreateAgentInput): Agent {
    if (!input.name?.trim()) throw new AgentValidationError('Agent name is required');
    if (!input.jobTitle?.trim()) throw new AgentValidationError('Job title is required');

    const autonomy = input.autonomyLevel ?? 2;
    if (!Number.isInteger(autonomy) || autonomy < 0 || autonomy > 5) {
      throw new AgentValidationError(
        `Autonomy level must be an integer 0–5 (§17), got ${input.autonomyLevel}`,
      );
    }

    const permissions = input.permissions ?? defaultPermissionsFor(input.jobTitle);
    const unknown = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
    if (unknown.length) {
      throw new AgentValidationError(
        `Unknown permission capabilities (§44): ${unknown.join(', ')}`,
      );
    }

    if (input.parentAgentId) this.get(input.parentAgentId); // parent must exist

    const a: Agent = {
      id: randomUUID(),
      name: input.name.trim(),
      displayName: input.displayName ?? input.name.trim(),
      jobTitle: input.jobTitle.trim(),
      department: input.department ?? 'Engineering',
      parentAgentId: input.parentAgentId ?? null,
      mission: input.mission ?? '',
      instructions: input.instructions ?? '',
      skills: input.skills ?? [],
      rules: input.rules ?? [],
      model: input.model ?? 'default',
      reasoningLevel: input.reasoningLevel ?? 'MEDIUM',
      tools: input.tools ?? [],
      permissions: [...new Set(permissions)],
      autonomyLevel: autonomy as AutonomyLevel,
      status: 'IDLE',
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.save(a);
    return this.get(a.id);
  }

  /** §44 — capability check used by the (stub) permission engine. */
  can(agentId: string, permission: Permission): boolean {
    return this.get(agentId).permissions.includes(permission);
  }

  setStatus(agentId: string, status: Agent['status']): Agent {
    const a = this.get(agentId);
    a.status = status;
    a.updatedAt = nowIso();
    this.store.save(a);
    return this.get(agentId);
  }

  childrenOf(parentId: string): Agent[] {
    return this.store.list().filter((a) => a.parentAgentId === parentId);
  }

  /** Build the org tree (§84) as nested nodes for the UI. */
  orgTree(): OrgNode[] {
    const all = this.store.list();
    const byParent = new Map<string | null, Agent[]>();
    for (const a of all) {
      const list = byParent.get(a.parentAgentId) ?? [];
      list.push(a);
      byParent.set(a.parentAgentId, list);
    }
    const build = (parentId: string | null): OrgNode[] =>
      (byParent.get(parentId) ?? []).map((a) => ({
        agent: a,
        children: build(a.id),
      }));
    return build(null);
  }

  get(id: string): Agent {
    const a = this.store.get(id);
    if (!a) throw new AgentNotFoundError(id);
    return a;
  }

  list(): Agent[] {
    return this.store.list();
  }
}

export interface OrgNode {
  agent: Agent;
  children: OrgNode[];
}

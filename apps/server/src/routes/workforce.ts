/**
 * Workforce routes — spec §14, §18–§20, §59.
 *
 *  POST /api/workforce/employees   {jobTitle, specialty?, parentId?,
 *                                   requestedBy?} → createEmployee (governed)
 *  POST /api/workforce/proposals   {kind, target, rationale, requestedBy?}
 *                                    (decision written through to fdb.proposals,
 *                                     §59/§48.2 Batch 33)
 *  GET  /api/workforce/proposals   proposal decision history (newest-first)
 *  GET  /api/workforce/proposals/:id  one proposal decision
 *  GET  /api/workforce/squads      active + archived squads
 *  POST /api/workforce/squads      {taskId, candidateIds?} → assemble
 *  POST /api/workforce/squads/:taskId/archive
 *  GET  /api/workforce/org         org graph (nodes)
 *  POST /api/workforce/org/nodes   {title, parentId?, agentId?} → add node
 *
 * Squads and the org graph are in-memory (prototype). Employee creation
 * goes through the persistent AgentRegistry with §19 governance.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleWorkforceRoutes } from './routes/workforce';
 *   if (await handleWorkforceRoutes(req, res, url, ctx)) return;
 */
import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  createEmployee,
  proposeChange,
} from '@ai-factory/employee-factory';
import type { FactoryPolicy } from '@ai-factory/employee-factory';
import { OrganizationDesigner, SquadManager } from '@ai-factory/squads';
import type { RouteContext } from './context';

/** Server-side factory governance (§19). */
const FACTORY_POLICY: FactoryPolicy = {
  maxChildren: 6,
  maxDepth: 3,
  maxConcurrentAgents: 8,
  maxTotalAgents: 64,
  maxRuntimeMs: 30 * 60 * 1000,
  maxBudget: 1000,
  allowedRoles: [
    'engineer', 'developer', 'qa', 'tester', 'specialist', 'designer',
    'analyst', 'reviewer', 'lead', 'architect', 'devops',
  ],
  allowedModels: ['fast-classifier', 'code-coder', 'reasoning-architect', 'vision-capable', 'local-private', 'reasoning'],
  allowedTools: ['read', 'write', 'shell', 'git', 'test', 'Repository', 'Terminal', 'SQL Sandbox', 'Static Analyzer'],
  allowedPermissions: [
    'filesystem.read', 'filesystem.write', 'shell.execute', 'git.commit',
    'git.push', 'git.merge', 'github.pull_request', 'database.read',
    'deploy.dev', 'deploy.uat', 'agent.create', 'workflow.modify',
  ],
};

const squads = new SquadManager();
const org = new OrganizationDesigner();

function slimAgent(a: {
  id: string;
  name: string;
  displayName: string;
  jobTitle: string;
  department: string;
  parentAgentId: string | null;
  mission: string;
  skills: string[];
  autonomyLevel: number;
  status: string;
}) {
  return {
    id: a.id,
    name: a.name,
    displayName: a.displayName,
    jobTitle: a.jobTitle,
    department: a.department,
    parentAgentId: a.parentAgentId,
    mission: a.mission,
    skills: a.skills,
    autonomyLevel: a.autonomyLevel,
    status: a.status,
  };
}

export async function handleWorkforceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith('/api/workforce/')) return false;

  if (method === 'POST' && path === '/api/workforce/employees') {
    const b = await ctx.readBody(req);
    if (typeof b['jobTitle'] !== 'string' || !b['jobTitle'].trim()) {
      ctx.json(res, 400, { error: 'jobTitle is required' });
      return true;
    }
    const requestedBy =
      typeof b['requestedBy'] === 'string' ? b['requestedBy'] : 'human';
    try {
      const agent = createEmployee(
        ctx.agents,
        requestedBy,
        {
          jobTitle: b['jobTitle'] as string,
          specialty:
            typeof b['specialty'] === 'string'
              ? (b['specialty'] as string)
              : undefined,
          parentId:
            typeof b['parentId'] === 'string'
              ? (b['parentId'] as string)
              : undefined,
        },
        FACTORY_POLICY,
        {
          // §8.2 relative ceiling: denials are audited here before the
          // 403 below (the package throws GovernanceError after the
          // sink runs).
          audit: (intent) =>
            ctx.audit.record(
              intent.actor,
              'RELATIVE_CEILING_DENIED',
              'agent',
              intent.details.granterAgentId,
              {
                requestedTools: intent.details.requestedTools,
                requestedPermissions: intent.details.requestedPermissions,
                exceededTools: intent.details.exceededTools,
                exceededPermissions: intent.details.exceededPermissions,
              },
            ),
        },
      );
      ctx.audit.record(requestedBy, 'EMPLOYEE_CREATED', 'agent', agent.id, {
        jobTitle: agent.jobTitle,
      });
      return ctx.json(res, 201, slimAgent(agent)), true;
    } catch (e) {
      const denied =
        e instanceof Error && e.name === 'GovernanceError';
      ctx.json(res, denied ? 403 : 400, {
        error: e instanceof Error ? e.message : 'creation failed',
        governance: denied,
      });
      return true;
    }
  }

  if (method === 'POST' && path === '/api/workforce/proposals') {
    const b = await ctx.readBody(req);
    const { kind, target, rationale } = b;
    if (
      (kind !== 'create' && kind !== 'modify' && kind !== 'retire') ||
      typeof target !== 'string' ||
      typeof rationale !== 'string'
    ) {
      ctx.json(res, 400, {
        error: 'kind (create|modify|retire), target and rationale are required',
      });
      return true;
    }
    const proposal = proposeChange(
      FACTORY_POLICY,
      {
        kind,
        target,
        rationale,
        requestedBy:
          typeof b['requestedBy'] === 'string' ? b['requestedBy'] : 'human',
      },
    );
    ctx.audit.record(
      'system',
      'SELF_MODIFICATION_PROPOSED',
      'proposal',
      proposal.id,
      { kind, target, status: proposal.status },
    );
    // §59/§48.2 (Batch 33): the decision used to live only in this
    // response. Write it through to fdb.proposals; a write failure
    // audits PROPOSAL_PERSIST_FAILED loudly but does not roll back
    // the decision that was just made.
    try {
      ctx.fdb.proposals.save({
        id: proposal.id,
        kind: proposal.kind,
        target: proposal.target,
        rationale: proposal.rationale,
        requestedBy: proposal.requestedBy,
        status: proposal.status,
        decidedBy: proposal.decidedBy,
        reason: proposal.reason,
        decidedAt: proposal.decidedAt,
      });
    } catch (e) {
      ctx.audit.record('system', 'PROPOSAL_PERSIST_FAILED', 'proposal', proposal.id, {
        error: e instanceof Error ? e.message : 'proposal persist failed',
        kind,
        target,
      });
    }
    return ctx.json(res, 201, proposal), true;
  }

  if (method === 'GET' && path === '/api/workforce/proposals') {
    const status = url.searchParams.get('status') ?? undefined;
    const items = ctx.fdb.proposals.list(status);
    return ctx.json(res, 200, { items, total: items.length }), true;
  }

  if (method === 'GET' && path.startsWith('/api/workforce/proposals/')) {
    const id = path.slice('/api/workforce/proposals/'.length);
    if (!id) return ctx.json(res, 400, { error: 'proposal id is required' }), true;
    const record = ctx.fdb.proposals.get(id);
    if (!record) return ctx.json(res, 404, { error: 'proposal not found' }), true;
    return ctx.json(res, 200, { proposal: record }), true;
  }

  if (method === 'GET' && path === '/api/workforce/squads') {
    return ctx.json(res, 200, {
      active: squads.listActive(),
      archived: squads.listArchived(),
    }), true;
  }

  if (method === 'POST' && path === '/api/workforce/squads') {
    const b = await ctx.readBody(req);
    if (typeof b['taskId'] !== 'string') {
      ctx.json(res, 400, { error: 'taskId is required' });
      return true;
    }
    const candidateIds = Array.isArray(b['candidateIds'])
      ? (b['candidateIds'] as string[])
      : ctx.agents
          .list()
          .filter((a) => a.status === 'IDLE' || a.status === 'ONLINE')
          .slice(0, 4)
          .map((a) => a.id);
    try {
      const squad = squads.assemble(b['taskId'] as string, candidateIds);
      ctx.audit.record('system', 'SQUAD_ASSEMBLED', 'squad', squad.id, {
        taskId: b['taskId'],
        members: squad.memberIds,
      });
      return ctx.json(res, 201, squad), true;
    } catch (e) {
      ctx.json(res, 400, { error: e instanceof Error ? e.message : 'assemble failed' });
      return true;
    }
  }

  const archive = path.match(/^\/api\/workforce\/squads\/([^/]+)\/archive$/);
  if (method === 'POST' && archive) {
    try {
      const squad = squads.archive(decodeURIComponent(archive[1]));
      ctx.audit.record('system', 'SQUAD_ARCHIVED', 'squad', squad.id, {});
      return ctx.json(res, 200, squad), true;
    } catch (e) {
      ctx.json(res, 404, { error: e instanceof Error ? e.message : 'not found' });
      return true;
    }
  }

  if (method === 'GET' && path === '/api/workforce/org') {
    const validation = org.validate();
    return ctx.json(res, 200, { graph: org.toGraph(), validation }), true;
  }

  if (method === 'POST' && path === '/api/workforce/org/nodes') {
    const b = await ctx.readBody(req);
    if (typeof b['title'] !== 'string') {
      ctx.json(res, 400, { error: 'title is required' });
      return true;
    }
    const node = org.addNode({
      id: randomUUID(),
      agentId: typeof b['agentId'] === 'string' ? (b['agentId'] as string) : null,
      title: b['title'] as string,
      parentId:
        typeof b['parentId'] === 'string' ? (b['parentId'] as string) : null,
      status: 'IDLE',
    });
    return ctx.json(res, 201, node), true;
  }

  return false;
}

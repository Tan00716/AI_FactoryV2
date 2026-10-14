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
import type {
  FactoryPolicy,
  RelativeCeilingDeniedIntent,
  TaskScopeCeilingDeniedIntent,
} from '@ai-factory/employee-factory';
import { needsHuman } from '@ai-factory/autonomy';
import type { NeedsHumanDbRecord } from '@ai-factory/db';
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
    // §8.2 任务范围: optional task-scope tokens for the creation grant.
    // Non-array → ignored (never fabricated); validated shape only —
    // the token semantics are enforced by enforcePolicy.
    const rawScope = b['taskScope'];
    const taskScope =
      Array.isArray(rawScope) && rawScope.every((t) => typeof t === 'string')
        ? (rawScope as string[])
        : undefined;
    try {
      const agent = createEmployee(
        ctx.agents,
        requestedBy,
        {
          jobTitle: b['jobTitle'] as string,
          taskScope,
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
          // sink runs). Both relative dimensions
          // (RELATIVE_CEILING_DENIED / TASK_SCOPE_CEILING_DENIED) enter
          // the hash-chained audit with their distinguishing action, and
          // repeated denials by the same granter feed the §81
          // 'policy-violation' emission (Batch 41).
          audit: (intent) => {
            recordCeilingDenial(ctx, intent);
          },
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

// ---------------------------------------------------------------------------
// §81 'policy-violation' emission (Batch 41).
//
// Honesty note — read before extending this: a single denial is the policy
// WORKING, not a violation ("拒绝 ≠ 违规"). What is wired here is the
// deterministic pattern "多次被拒绝仍尝试": N §8.2 ceiling denials by the
// same granter, counted over the hash-chained audit (facts, not heuristics).
// The emitted record honestly describes DENIED ATTEMPTS — the policy held
// on every attempt and no elevation occurred — and asks a human to review
// why the granter keeps attempting to exceed its grantable set (§5: AI
// 不得提高自身/下属权限上限). This mirrors the 'repeated-failure'
// precedent (Batch 38): LoopStagnation fires on N same-signature failures;
// here the pattern is N same-granter ceiling denials. Emitting on a single
// denial would be noise (the policy did its job); emitting on the pattern
// is the exception the human needs to see.
//
// Scope: only the two audited §8.2 relative-ceiling denials feed this.
// §19 absolute denials are throw-only (not audited) and structural
// (parent linkage / limits), not authority-elevation attempts.

/** §8.2 ceiling denial actions that feed the policy-violation emission. */
export const POLICY_CEILING_DENIAL_ACTIONS = [
  'RELATIVE_CEILING_DENIED',
  'TASK_SCOPE_CEILING_DENIED',
] as const;

/**
 * Ceiling denials by one granter that trigger a §81 'policy-violation'
 * upgrade. Follows the stagnationLimit=3 precedent (Batch 38): an
 * explicit, documented policy parameter, not a heuristic guess about
 * content.
 */
export const POLICY_DENIAL_ESCALATION_THRESHOLD = 3;

export type CeilingDenialIntent =
  | RelativeCeilingDeniedIntent
  | TaskScopeCeilingDeniedIntent;

/**
 * Record a §8.2 ceiling denial to the hash-chained audit, then evaluate
 * the §81 'policy-violation' emission. Extracted from the createEmployee
 * audit sink so tests can drive it without HTTP.
 */
export function recordCeilingDenial(
  ctx: RouteContext,
  intent: CeilingDenialIntent,
): void {
  ctx.audit.record(
    intent.actor,
    intent.action,
    'agent',
    intent.details.granterAgentId,
    intent.action === 'RELATIVE_CEILING_DENIED'
      ? {
          requestedTools: intent.details.requestedTools,
          requestedPermissions: intent.details.requestedPermissions,
          exceededTools: intent.details.exceededTools,
          exceededPermissions: intent.details.exceededPermissions,
        }
      : {
          taskScope: intent.details.taskScope,
          requestedTools: intent.details.requestedTools,
          requestedPermissions: intent.details.requestedPermissions,
          exceededTools: intent.details.exceededTools,
          exceededPermissions: intent.details.exceededPermissions,
        },
  );
  maybeEmitPolicyViolationUpgrade(ctx, intent);
}

/**
 * Build the §81 'policy-violation' upgrade record for repeated ceiling
 * denials. Pure: the caller (maybeEmitPolicyViolationUpgrade) has already
 * decided the threshold is met and no OPEN upgrade exists for this granter.
 *
 * recipient is null: the server has coarse-grained token RBAC with no
 * named human accounts, so we record the required level instead of
 * inventing a person. 'operator' is the API role that does daily
 * workforce/governance work — the honest minimum level that can inspect
 * the granter's denied requests, fix the grant, or retire the actor.
 * severity 'critical' comes from the @ai-factory/autonomy REASON_SEVERITY
 * mapping for 'policy-violation' (not chosen here).
 */
export function buildPolicyViolationUpgradeRecord(args: {
  granter: string;
  denialCount: number;
  relativeCeilingDenials: number;
  taskScopeDenials: number;
  exceededTools: string[];
  exceededPermissions: string[];
}): NeedsHumanDbRecord {
  // F19 (Batch 44): the honest narrative must survive persistence — it goes
  // into detailJson (brute-force precedent), not only the transient record.
  const narrative =
    `granter ${args.granter} was denied ${args.denialCount} times attempting to grant ` +
    `beyond its §8.2 relative ceiling ` +
    `(RELATIVE_CEILING_DENIED ×${args.relativeCeilingDenials}, ` +
    `TASK_SCOPE_CEILING_DENIED ×${args.taskScopeDenials}). ` +
    `The policy held on every attempt — no elevation occurred. ` +
    `Persistent attempts may indicate a misconfigured grant, a confused agent, ` +
    `or prompt injection; human review is required.`;
  const rec = needsHuman('policy-violation', {
    detail: narrative,
    context: {
      granter: args.granter,
      denialCount: String(args.denialCount),
      relativeCeilingDenials: String(args.relativeCeilingDenials),
      taskScopeDenials: String(args.taskScopeDenials),
      exceededTools: args.exceededTools.join(','),
      exceededPermissions: args.exceededPermissions.join(','),
    },
    impactScope: `agent creation by granter ${args.granter} keeps being denied; no privilege was elevated`,
    stoppedActions: [
      `agent creation denied for granter ${args.granter} (denial #${args.denialCount})`,
    ],
    suggestion:
      "Review the granter's denied requests in the audit chain (actions " +
      'RELATIVE_CEILING_DENIED / TASK_SCOPE_CEILING_DENIED). If the broader grant is ' +
      "legitimate, raise the granter's own grant first — never widen it from below " +
      '(§5/§8.2). If the attempts look malicious or confused, quarantine or retire ' +
      'the granter. Mark this upgrade resolved via POST /api/needs-human/:id/resolve.',
  });
  return {
    id: rec.id,
    reason: rec.reason,
    reasonZh: rec.reasonZh,
    severity: rec.severity,
    source: `policy-denial:${args.granter}`,
    recipient: null,
    requiredDeciderLevel: 'operator',
    detailJson: JSON.stringify({
      narrative,
      granter: args.granter,
      denialCount: args.denialCount,
      relativeCeilingDenials: args.relativeCeilingDenials,
      taskScopeDenials: args.taskScopeDenials,
      exceededTools: args.exceededTools,
      exceededPermissions: args.exceededPermissions,
      suggestion: rec.suggestion,
    }),
    contextJson: JSON.stringify(rec.context ?? {}),
    raisedAt: Date.now(),
    status: 'open',
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  };
}

/**
 * §81 'policy-violation' emission check. Called after every §8.2 ceiling
 * denial is recorded. Emits at most one OPEN upgrade per granter: when the
 * granter's total ceiling-denial count reaches
 * POLICY_DENIAL_ESCALATION_THRESHOLD and no OPEN 'policy-violation'
 * upgrade with source `policy-denial:<granter>` exists, a new upgrade is
 * submitted (insert-only). Further denials while the upgrade is OPEN do
 * not re-emit; after a human resolves it, the next denial at/over
 * threshold opens a new episode.
 *
 * Write-through failures are audited NEEDS_HUMAN_PERSIST_FAILED and never
 * thrown — the denial itself was already recorded and the 403 below must
 * still be returned (same contract as emitRunNeedsHuman; the emission is
 * advisory to the denial path).
 */
export function maybeEmitPolicyViolationUpgrade(
  ctx: RouteContext,
  intent: CeilingDenialIntent,
): void {
  const granter = intent.actor;
  const count = ctx.audit.countByActorAction(
    granter,
    POLICY_CEILING_DENIAL_ACTIONS,
  );
  if (count < POLICY_DENIAL_ESCALATION_THRESHOLD) return;
  const source = `policy-denial:${granter}`;
  const alreadyOpen = ctx.fdb.needsHuman
    .list('open')
    .some((r) => r.reason === 'policy-violation' && r.source === source);
  if (alreadyOpen) return;
  const record = buildPolicyViolationUpgradeRecord({
    granter,
    denialCount: count,
    relativeCeilingDenials: ctx.audit.countByActorAction(granter, [
      'RELATIVE_CEILING_DENIED',
    ]),
    taskScopeDenials: ctx.audit.countByActorAction(granter, [
      'TASK_SCOPE_CEILING_DENIED',
    ]),
    exceededTools: [...intent.details.exceededTools],
    exceededPermissions: [...intent.details.exceededPermissions],
  });
  emitPolicyViolationNeedsHuman(ctx, record);
}

/**
 * Write-through for §81 'policy-violation' upgrades: insert-only into
 * fdb.needsHuman, audited NEEDS_HUMAN_RAISED. Same contract as
 * emitRunNeedsHuman (routes/runtime.ts) — duplicated here rather than
 * imported so this module keeps no value-imports of sibling route files
 * (dual-mode: server tests import this file's src directly; see
 * needs-human-run-emission.test.ts for the precedent).
 */
function emitPolicyViolationNeedsHuman(
  ctx: RouteContext,
  record: NeedsHumanDbRecord,
): void {
  try {
    ctx.fdb.needsHuman.submit(record);
    ctx.audit.record('system', 'NEEDS_HUMAN_RAISED', 'needs-human', record.id, {
      reason: record.reason,
      source: record.source,
      requiredDeciderLevel: record.requiredDeciderLevel,
    });
  } catch (err) {
    ctx.audit.record(
      'system',
      'NEEDS_HUMAN_PERSIST_FAILED',
      'needs-human',
      record.id,
      {
        error: err instanceof Error ? err.message : String(err),
        source: record.source,
      },
    );
  }
}

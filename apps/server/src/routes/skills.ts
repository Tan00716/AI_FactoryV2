/**
 * Skills routes — spec §47 (Skills Registry), §48 (Skill Discovery),
 * §49 (Skill Versioning), §74 (Skill Security).
 *
 *   GET  /api/skills                          list installed skills
 *   GET  /api/skills/:id                      latest version detail
 *   POST /api/skills/install                  {skill, requestedBy?, approvedByHuman?}
 *   POST /api/skills/discover                 {title, goal?, keywords?, taskType?, select?, reason?}
 *   POST /api/skills/:id/instructions         {version?} → only that skill's SKILL.md text
 *   POST /api/skills/:id/use                  {taskId, version?} → record exact version (§49)
 *   POST /api/skills/:id/deprecate            {version}
 *   POST /api/skills/:id/retire               {version}
 *
 * A blocked install returns 202 with the InstallApprovalRequired descriptor
 * (§74: HIGH findings need HUMAN_APPROVAL); re-issue with approvedByHuman
 * after the human approves. Every install/discovery writes an audit record.
 *
 * The coordinator wires this in: handleSkillsRoutes(req, res, url, ctx).
 * PROTOTYPE NOTE: registry is in-memory (lost on restart); the 8 built-in
 * OFFICIAL skills are installed at boot.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SkillRegistry,
  discover,
  installBuiltinSkills,
  loadInstructions,
  select,
  type InstallSkillDef,
  type Skill,
} from '@ai-factory/skills';
import type { RouteContext } from './context';

const PREFIX = '/api/skills';

const registry = new SkillRegistry();
installBuiltinSkills(registry);

function summarize(s: Skill) {
  const latest = s.versions[s.versions.length - 1];
  return {
    id: s.id,
    versions: s.versions.map((v) => v.version),
    latest: latest?.version ?? null,
    description: latest?.description ?? '',
    trustLevel: latest?.trustLevel ?? 'UNREVIEWED',
    status: latest?.status ?? 'ACTIVE',
    evaluationScore: latest?.evaluationScore ?? 0,
  };
}

export async function handleSkillsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/skills
  if (method === 'GET' && path === PREFIX) {
    return ctx.json(res, 200, { skills: registry.list().map(summarize) }), true;
  }

  // POST /api/skills/install — before the :id matcher.
  if (method === 'POST' && path === `${PREFIX}/install`) {
    const body = await ctx.readBody(req);
    const skill = body['skill'] as InstallSkillDef | undefined;
    if (!skill || typeof skill !== 'object') {
      return ctx.json(res, 400, { error: 'skill definition is required' }), true;
    }
    const requestedBy = typeof body['requestedBy'] === 'string' ? body['requestedBy'] : 'human';
    const approvedByHuman = body['approvedByHuman'] === true;
    try {
      const result = registry.install({ skill, requestedBy, approvedByHuman });
      if (!result.ok) {
        ctx.audit.record(requestedBy, 'SKILL_INSTALL_BLOCKED', 'skill', skill.id, {
          version: skill.version,
          reason: result.approval.reason,
        });
        return ctx.json(res, 202, { ok: false, approval: result.approval }), true;
      }
      ctx.audit.record(requestedBy, 'SKILL_INSTALLED', 'skill', skill.id, {
        version: result.version,
      });
      return ctx.json(res, 201, { ok: true, skill: summarize(registry.get(skill.id)! as Skill) }), true;
    } catch (e) {
      return ctx.json(res, 400, { error: (e as Error).message }), true;
    }
  }

  // POST /api/skills/discover — before the :id matcher.
  if (method === 'POST' && path === `${PREFIX}/discover`) {
    const body = await ctx.readBody(req);
    const title = body['title'];
    if (typeof title !== 'string' || !title) {
      return ctx.json(res, 400, { error: 'title is required' }), true;
    }
    const profile = {
      title,
      goal: typeof body['goal'] === 'string' ? body['goal'] : '',
      keywords: Array.isArray(body['keywords']) ? (body['keywords'] as string[]) : [],
      taskType: typeof body['taskType'] === 'string' ? body['taskType'] : 'general',
    };
    const candidates = discover(registry, profile);
    let record: unknown = null;
    const selectedIds = body['select'];
    if (Array.isArray(selectedIds)) {
      try {
        record = select(
          profile,
          candidates,
          selectedIds as string[],
          typeof body['reason'] === 'string' ? body['reason'] : 'human selection',
        );
      } catch (e) {
        return ctx.json(res, 400, { error: (e as Error).message, candidates }), true;
      }
    }
    ctx.audit.record('human', 'SKILL_DISCOVERY', 'skill_discovery', String((record as { id?: string })?.id ?? 'n/a'), {
      title,
      candidateCount: candidates.length,
      selected: selectedIds ?? null,
    });
    return ctx.json(res, 200, { candidates, discovery: record }), true;
  }

  const idMatch = path.match(/^\/api\/skills\/([^/]+)(\/.*)?$/);
  if (!idMatch) return false;
  const id = decodeURIComponent(idMatch[1]);
  const rest = idMatch[2] ?? '';

  // GET /api/skills/:id
  if (method === 'GET' && rest === '') {
    try {
      return ctx.json(res, 200, { skill: registry.get(id) }), true;
    } catch (e) {
      return ctx.json(res, 404, { error: (e as Error).message }), true;
    }
  }

  // POST /api/skills/:id/instructions
  if (method === 'POST' && rest === '/instructions') {
    const body = await ctx.readBody(req);
    const version = typeof body['version'] === 'string' ? body['version'] : undefined;
    try {
      const instructions = loadInstructions(registry, id, version);
      return ctx.json(res, 200, { id, version: version ?? 'latest', instructions }), true;
    } catch (e) {
      return ctx.json(res, 404, { error: (e as Error).message }), true;
    }
  }

  // POST /api/skills/:id/use
  if (method === 'POST' && rest === '/use') {
    const body = await ctx.readBody(req);
    const taskId = body['taskId'];
    if (typeof taskId !== 'string' || !taskId) {
      return ctx.json(res, 400, { error: 'taskId is required' }), true;
    }
    const resolvedVersion =
      typeof body['version'] === 'string'
        ? body['version']
        : (registry.get(id)! as Skill).versions.at(-1)!.version;
    try {
      const usage = registry.recordUsage(taskId, id, resolvedVersion);
      ctx.audit.record('human', 'SKILL_USED', 'skill', id, { ...usage });
      return ctx.json(res, 200, { usage }), true;
    } catch (e) {
      return ctx.json(res, 404, { error: (e as Error).message }), true;
    }
  }

  // POST /api/skills/:id/deprecate | /retire
  if (method === 'POST' && (rest === '/deprecate' || rest === '/retire')) {
    const body = await ctx.readBody(req);
    const version = body['version'];
    if (typeof version !== 'string' || !version) {
      return ctx.json(res, 400, { error: 'version is required' }), true;
    }
    try {
      if (rest === '/deprecate') registry.deprecate(id, version);
      else registry.retire(id, version);
      ctx.audit.record('human', rest === '/deprecate' ? 'SKILL_DEPRECATED' : 'SKILL_RETIRED', 'skill', id, { version });
      return ctx.json(res, 200, { ok: true, skill: summarize(registry.get(id)! as Skill) }), true;
    } catch (e) {
      return ctx.json(res, 404, { error: (e as Error).message }), true;
    }
  }

  return false;
}

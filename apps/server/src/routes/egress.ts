/**
 * Egress firewall — HTTP surface (second-round task ⑦).
 *
 *   GET  /api/egress/config?projectId=&taskId=   all three layers +
 *                                                project path + load
 *                                                errors (viewer)
 *   PUT  /api/egress/config                      { scope: 'global' |
 *                                                'project' | 'task',
 *                                                projectId?, taskId?,
 *                                                enabled?, defaultPolicy?,
 *                                                rules?, taskRules? }
 *                                                validated write + audit
 *                                                (operator)
 *   GET  /api/egress/log?limit=                  recent blocked calls,
 *                                                newest first (viewer)
 *   POST /api/egress/test { url, projectId?, taskId? }
 *                                                dry-run verdict: allow/
 *                                                deny + matched layer and
 *                                                rule (operator; it is a
 *                                                diagnostic, so POST)
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps GET → viewer
 * and other methods → operator for this prefix — no auth.ts change.
 *
 * Path policy: the project working directory comes from the project
 * record's `path` (ctx.fdb.getProject) and must stay inside the
 * operator-configured projects root (FACTORY_PROJECTS_ROOT, default
 * <dir of DB_PATH>/projects) — the same containment the backup module
 * enforces (Batch 47-2, finding F22). A record without a path gets a
 * 409, never a fabricated default.
 *
 * Audit: EGRESS_CONFIG_UPDATED on writes. Blocked calls are audited
 * with EGRESS_BLOCKED by the enforcement core (egress.ts), not here —
 * the routes only write configuration.
 *
 * HONEST BOUNDARY (surfaced in the UI copy too): the firewall gates the
 * server's own tool/proxy egress paths (web search providers, remote
 * MCP, scheduler webhooks) — not the host network, not exec/shell,
 * not the user's browser. Domain rules are string-level suffix matches
 * (a domain rule covers all subdomains); IP literals are distinct hosts
 * that need their own rules.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import type { RouteContext } from './context';
import {
  EGRESS_MAX_RULES,
  egressStore,
  evaluateEgress,
  getEgressBlockLog,
  ruleLabel,
  validateEgressRules,
  type EgressAction,
  type EgressDefaultPolicy,
  type EgressRule,
} from '../egress';

const PREFIX = '/api/egress';

function projectsRoot(): string {
  const raw = process.env['FACTORY_PROJECTS_ROOT'];
  if (raw && raw.trim()) return resolve(raw.trim());
  const dbPath = process.env['DB_PATH'] ?? './data/factory.db';
  return join(dirname(resolve(dbPath)), 'projects');
}

/** Resolve + jail the project working directory from its record. */
export function resolveProjectDir(
  ctx: RouteContext,
  projectId: string,
): { ok: true; dir: string } | { ok: false; status: number; error: string; code: string } {
  const p = ctx.fdb.getProject(projectId);
  if (!p) {
    return { ok: false, status: 404, error: `project not found: ${projectId}`, code: 'PROJECT_NOT_FOUND' };
  }
  const raw = (p.path ?? '').trim();
  if (!raw) {
    return {
      ok: false,
      status: 409,
      error: 'project has no local working directory (path is empty); egress rules live in the project directory',
      code: 'EGRESS_NO_PROJECT_PATH',
    };
  }
  const abs = resolve(raw);
  const root = projectsRoot();
  if (!(abs === root || abs.startsWith(root + sep))) {
    return {
      ok: false,
      status: 403,
      error: `project path escapes the projects root (${root}): ${abs}`,
      code: 'EGRESS_PATH_ESCAPE',
    };
  }
  return { ok: true, dir: abs };
}

function isRec(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function coerceRules(v: unknown): EgressRule[] | null {
  if (!Array.isArray(v)) return null;
  const out: EgressRule[] = [];
  for (const r of v) {
    if (!isRec(r)) return null;
    out.push({
      domain: typeof r['domain'] === 'string' ? r['domain'] : '',
      action: r['action'] as EgressAction,
      ...(typeof r['pathPrefix'] === 'string' ? { pathPrefix: r['pathPrefix'] } : {}),
      ...(typeof r['note'] === 'string' ? { note: r['note'] } : {}),
    });
  }
  return out;
}

export async function handleEgressRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const store = egressStore();

  // GET /api/egress/config?projectId=&taskId= — read all three layers.
  if (method === 'GET' && path === `${PREFIX}/config`) {
    const projectId = url.searchParams.get('projectId');
    const taskId = url.searchParams.get('taskId');
    const global = store.getGlobal();
    let projectPath: string | null = null;
    let project: { rules: EgressRule[]; taskIds: string[]; loadError?: string } | null = null;
    let task: { rules: EgressRule[] } | null = null;
    if (projectId) {
      const rd = resolveProjectDir(ctx, projectId);
      if (!rd.ok) {
        ctx.json(res, rd.status, { error: rd.error, code: rd.code });
        return true;
      }
      projectPath = rd.dir;
      const layer = store.getProjectLayer(rd.dir);
      project = {
        rules: layer.rules,
        taskIds: Object.keys(layer.tasks).sort(),
        ...(layer.loadError ? { loadError: layer.loadError } : {}),
      };
      if (taskId && layer.tasks[taskId]) task = { rules: layer.tasks[taskId]!.rules };
    }
    ctx.json(res, 200, {
      global,
      project,
      task,
      projectPath,
      limits: { maxRulesPerLayer: EGRESS_MAX_RULES },
    });
    return true;
  }

  // PUT /api/egress/config — validated write of one layer.
  if (method === 'PUT' && path === `${PREFIX}/config`) {
    const body = (await ctx.readBody(req).catch(() => ({}))) as Record<string, unknown>;
    const actor = typeof body['actor'] === 'string' && body['actor'].trim()
      ? body['actor'].trim().slice(0, 64)
      : 'human';
    const scope = body['scope'];
    if (scope !== 'global' && scope !== 'project' && scope !== 'task') {
      ctx.json(res, 400, { error: 'scope must be "global", "project" or "task"', code: 'EGRESS_BAD_SCOPE' });
      return true;
    }
    if (scope === 'global') {
      const enabled = body['enabled'] === true;
      const defaultPolicy: EgressDefaultPolicy = body['defaultPolicy'] === 'allow' ? 'allow' : 'deny';
      const rules = coerceRules(body['rules']);
      if (rules === null) {
        ctx.json(res, 400, { error: 'rules must be an array of { domain, action, pathPrefix?, note? }', code: 'EGRESS_BAD_RULES' });
        return true;
      }
      const errs = validateEgressRules(rules, 'global.rules');
      if (errs.length > 0) {
        ctx.json(res, 400, { error: 'invalid global rules', details: errs, code: 'EGRESS_RULE_INVALID' });
        return true;
      }
      const next = store.setGlobal({ enabled, defaultPolicy, rules }, actor);
      ctx.audit.record(actor, 'EGRESS_CONFIG_UPDATED', 'egress', 'global', {
        enabled: next.enabled,
        defaultPolicy: next.defaultPolicy,
        ruleCount: next.rules.length,
      });
      ctx.json(res, 200, { global: next });
      return true;
    }
    // project / task scopes need a project.
    const projectId = body['projectId'];
    if (typeof projectId !== 'string' || !projectId.trim()) {
      ctx.json(res, 400, { error: 'projectId is required for the project/task scope', code: 'EGRESS_NO_PROJECT' });
      return true;
    }
    const rd = resolveProjectDir(ctx, projectId);
    if (!rd.ok) {
      ctx.json(res, rd.status, { error: rd.error, code: rd.code });
      return true;
    }
    if (scope === 'project') {
      const rules = coerceRules(body['rules']);
      if (rules === null) {
        ctx.json(res, 400, { error: 'rules must be an array of { domain, action, pathPrefix?, note? }', code: 'EGRESS_BAD_RULES' });
        return true;
      }
      try {
        const next = store.setProjectLayer(rd.dir, { rules });
        ctx.audit.record(actor, 'EGRESS_CONFIG_UPDATED', 'egress', projectId, {
          scope: 'project',
          ruleCount: next.rules.length,
        });
        ctx.json(res, 200, { rules: next.rules, taskIds: Object.keys(next.tasks).sort() });
      } catch (e) {
        ctx.json(res, 400, { error: (e as Error).message, code: 'EGRESS_RULE_INVALID' });
      }
      return true;
    }
    // scope === 'task'
    const taskId = body['taskId'];
    if (typeof taskId !== 'string' || !taskId.trim()) {
      ctx.json(res, 400, { error: 'taskId is required for the task scope', code: 'EGRESS_NO_TASK' });
      return true;
    }
    const taskRules = coerceRules(body['taskRules'] ?? body['rules']);
    if (taskRules === null) {
      ctx.json(res, 400, { error: 'taskRules must be an array of { domain, action, pathPrefix?, note? }', code: 'EGRESS_BAD_RULES' });
      return true;
    }
    try {
      const next = store.setProjectLayer(rd.dir, { taskId, taskRules });
      ctx.audit.record(actor, 'EGRESS_CONFIG_UPDATED', 'egress', taskId, {
        scope: 'task',
        projectId,
        ruleCount: next.tasks[taskId]?.rules.length ?? 0,
      });
      ctx.json(res, 200, { rules: next.tasks[taskId]?.rules ?? [], taskIds: Object.keys(next.tasks).sort() });
    } catch (e) {
      ctx.json(res, 400, { error: (e as Error).message, code: 'EGRESS_RULE_INVALID' });
    }
    return true;
  }

  // GET /api/egress/log — recent blocked calls, newest first.
  if (method === 'GET' && path === `${PREFIX}/log`) {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50));
    ctx.json(res, 200, { entries: getEgressBlockLog(limit) });
    return true;
  }

  // POST /api/egress/test — dry-run: evaluate a URL against all layers.
  if (method === 'POST' && path === `${PREFIX}/test`) {
    const body = (await ctx.readBody(req).catch(() => ({}))) as Record<string, unknown>;
    const urlArg = body['url'];
    if (typeof urlArg !== 'string' || !urlArg.trim()) {
      ctx.json(res, 400, { error: 'url is required', code: 'EGRESS_NO_URL' });
      return true;
    }
    const projectId = body['projectId'];
    const taskId = body['taskId'];
    let layers = store.layersFor({});
    let projectPath: string | null = null;
    if (typeof projectId === 'string' && projectId.trim()) {
      const rd = resolveProjectDir(ctx, projectId);
      if (!rd.ok) {
        ctx.json(res, rd.status, { error: rd.error, code: rd.code });
        return true;
      }
      projectPath = rd.dir;
      layers = store.layersFor({
        projectDir: rd.dir,
        ...(typeof taskId === 'string' && taskId.trim() ? { taskId } : {}),
      });
    }
    const verdict = evaluateEgress(urlArg.trim(), layers);
    ctx.json(res, 200, {
      url: urlArg.slice(0, 512),
      allowed: verdict.allowed,
      reason: verdict.reason,
      hostname: verdict.hostname,
      matchedLayer: verdict.matchedLayer ?? null,
      matchedRule: verdict.matchedRule ? ruleLabel(verdict.matchedRule) : null,
      enabled: layers.global.enabled,
      defaultPolicy: layers.global.defaultPolicy,
      projectPath,
    });
    return true;
  }

  return false;
}

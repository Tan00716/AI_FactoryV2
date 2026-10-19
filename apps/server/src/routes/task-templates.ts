/**
 * Task template routes — template library.
 *
 *   GET    /api/task-templates            list templates (viewer)
 *   POST   /api/task-templates            create (operator)
 *   GET    /api/task-templates/:id        one template (viewer)
 *   PATCH  /api/task-templates/:id        update (operator)
 *   DELETE /api/task-templates/:id        delete (operator)
 *   POST   /api/task-templates/:id/launch
 *          body { projectId, params?, agentId?, title? }
 *          → creates a task with the rendered prompt and starts a run
 *          (operator). Returns { task, runId }.
 *
 * RBAC: central gate (auth.ts requiredRoleFor) — GET → viewer,
 * everything else → operator. No per-route role logic here.
 *
 * Injection safety: template content is scanned at creation/update
 * (override attempts refused); launch params are user input and pass
 * through the substitution choke point in the store.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  TaskTemplateStore,
  TaskTemplateStoreError,
  renderPrompt,
} from '../task-template-store';
import { ScheduleRunError, startScheduledRun } from './runtime';
import type { RouteContext } from './context';

const PREFIX = '/api/task-templates';

function storeOf(ctx: RouteContext): TaskTemplateStore {
  return ctx.taskTemplateStore;
}

function actorOf(body: Record<string, unknown>): string {
  const a = body['actor'];
  return typeof a === 'string' && a.trim() ? a.trim() : 'human';
}

function storeError(ctx: RouteContext, res: ServerResponse, e: unknown): boolean {
  if (e instanceof TaskTemplateStoreError) {
    ctx.json(res, 400, { error: e.message });
    return true;
  }
  throw e;
}

export async function handleTaskTemplateRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  const store = storeOf(ctx);

  // POST /api/task-templates/:id/launch — before the :id matcher.
  const launchMatch = path.match(new RegExp(`^${PREFIX.replace(/\//g, '\\/')}/([^/]+)/launch$`));
  if (method === 'POST' && launchMatch) {
    const id = decodeURIComponent(launchMatch[1]);
    const template = store.get(id);
    if (!template) return ctx.json(res, 404, { error: 'template not found' }), true;
    const body = (await ctx.readBody(req).catch(() => ({}))) as Record<string, unknown>;
    const projectId = typeof body['projectId'] === 'string' ? body['projectId'].trim() : '';
    if (!projectId) return ctx.json(res, 400, { error: 'projectId is required' }), true;
    const params: Record<string, string> = {};
    const rawParams = body['params'];
    if (rawParams && typeof rawParams === 'object') {
      for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
        params[k] = String(v ?? '');
      }
    }
    const { prompt, missing } = renderPrompt(template, params);
    if (missing.length > 0) {
      return ctx.json(res, 400, {
        error: `missing template variables: ${missing.join(', ')}`,
        missing,
        variables: template.variables,
      }), true;
    }
    const agentId =
      (typeof body['agentId'] === 'string' && body['agentId'].trim()) ||
      template.defaultAgentId ||
      '';
    if (!agentId) {
      return ctx.json(res, 400, {
        error: 'agentId is required (no defaultAgentId on this template)',
      }), true;
    }
    const title =
      typeof body['title'] === 'string' && body['title'].trim()
        ? body['title'].trim()
        : template.name;
    // Create the task first — mirrors POST /api/tasks creation fields.
    let task;
    try {
      task = ctx.tasks.create({
        projectId,
        title,
        goal: prompt,
        description: `Launched from template "${template.name}" (${template.id}).`,
        priority: template.defaultPriority ?? 'P2',
        creator: 'template',
      });
    } catch (e) {
      if (e instanceof Error) return ctx.json(res, 400, { error: e.message }), true;
      throw e;
    }
    // Then start the run through the same path the scheduler uses
    // (agent lookup, archived-project gate, §17.2 AUTHORIZED gate,
    // tool allowlist, run record + manifest).
    let runId: string;
    try {
      runId = startScheduledRun(ctx, { agentId, taskId: task.id }).runId;
    } catch (e) {
      if (e instanceof ScheduleRunError) {
        return ctx.json(res, 400, { error: e.message, taskId: task.id }), true;
      }
      throw e;
    }
    const actor = actorOf(body);
    ctx.audit.record(actor, 'TASK_TEMPLATE_LAUNCHED', 'task-template', template.id, {
      taskId: task.id,
      runId,
      agentId,
      projectId,
    });
    return ctx.json(res, 200, { task, runId }), true;
  }

  // GET /api/task-templates
  if (method === 'GET' && path === PREFIX) {
    return ctx.json(res, 200, { templates: store.list() }), true;
  }

  // POST /api/task-templates
  if (method === 'POST' && path === PREFIX) {
    const body = (await ctx.readBody(req).catch(() => ({}))) as Record<string, unknown>;
    try {
      const t = store.create({
        name: String(body['name'] ?? ''),
        description: typeof body['description'] === 'string' ? body['description'] : '',
        promptTemplate: String(body['promptTemplate'] ?? ''),
        defaultAgentId:
          typeof body['defaultAgentId'] === 'string' && body['defaultAgentId'].trim()
            ? body['defaultAgentId'].trim()
            : undefined,
        defaultPriority:
          typeof body['defaultPriority'] === 'string'
            ? (body['defaultPriority'] as 'P0' | 'P1' | 'P2' | 'P3' | 'P4')
            : undefined,
        toolAllowlist: Array.isArray(body['toolAllowlist'])
          ? (body['toolAllowlist'] as unknown[]).map(String)
          : undefined,
        createdBy: actorOf(body),
      });
      ctx.audit.record(actorOf(body), 'TASK_TEMPLATE_CREATED', 'task-template', t.id, {
        name: t.name,
      });
      return ctx.json(res, 201, { template: t }), true;
    } catch (e) {
      return storeError(ctx, res, e);
    }
  }

  // GET /api/task-templates/:id
  const idMatch = path.match(new RegExp(`^${PREFIX.replace(/\//g, '\\/')}/([^/]+)$`));
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1]);
    if (method === 'GET') {
      const t = store.get(id);
      if (!t) return ctx.json(res, 404, { error: 'template not found' }), true;
      return ctx.json(res, 200, { template: t }), true;
    }
    // PATCH /api/task-templates/:id
    if (method === 'PATCH') {
      const body = (await ctx.readBody(req).catch(() => ({}))) as Record<string, unknown>;
      try {
        const patch: {
          name?: string;
          description?: string;
          promptTemplate?: string;
          defaultAgentId?: string;
          defaultPriority?: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
          toolAllowlist?: string[];
        } = {};
        if (body['name'] !== undefined) patch.name = String(body['name']);
        if (body['description'] !== undefined) patch.description = String(body['description']);
        if (body['promptTemplate'] !== undefined) patch.promptTemplate = String(body['promptTemplate']);
        if (body['defaultAgentId'] !== undefined) {
          patch.defaultAgentId =
            typeof body['defaultAgentId'] === 'string' ? body['defaultAgentId'] : '';
        }
        if (body['defaultPriority'] !== undefined) {
          patch.defaultPriority = body['defaultPriority'] as 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
        }
        if (body['toolAllowlist'] !== undefined) {
          patch.toolAllowlist = Array.isArray(body['toolAllowlist'])
            ? (body['toolAllowlist'] as string[])
            : [];
        }
        const t = store.update(id, patch);
        ctx.audit.record(actorOf(body), 'TASK_TEMPLATE_UPDATED', 'task-template', t.id, {
          patch: Object.keys(patch),
        });
        return ctx.json(res, 200, { template: t }), true;
      } catch (e) {
        return storeError(ctx, res, e);
      }
    }
    // DELETE /api/task-templates/:id
    if (method === 'DELETE') {
      const ok = store.remove(id);
      if (!ok) return ctx.json(res, 404, { error: 'template not found' }), true;
      ctx.audit.record('human', 'TASK_TEMPLATE_DELETED', 'task-template', id, {});
      return ctx.json(res, 200, { deleted: true }), true;
    }
  }

  return false;
}

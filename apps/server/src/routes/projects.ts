/**
 * Projects routes — spec §31–§33.
 *
 *  GET  /api/projects/templates          list available project templates
 *  GET  /api/projects/discover?path=     analyze a directory → ProjectProfile
 *  POST /api/projects/create             {name, template?, dir?} → scaffold
 *  POST /api/projects/exec               {command, cwd, agentId?, timeoutMs?}
 *                                        run a whitelisted command in a
 *                                        sandboxed WorkspaceExecutor
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleProjectsRoutes } from './routes/projects';
 *   if (await handleProjectsRoutes(req, res, url, ctx)) return;
 *
 * PROTOTYPE NOTE: POST /api/projects/exec grants READ + EXECUTE only.
 * `cwd` must be an absolute existing directory and becomes the sandbox
 * root, so the command cannot escape it. Network-capable commands are
 * rejected unless the workspace is granted NETWORK (not exposed here —
 * the coordinator must approve that escalation explicitly).
 */
import { statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  WorkspaceExecutor,
  createProject,
  discoverProject,
  listTemplates,
} from '@ai-factory/projects';
import type { RouteContext } from './context';

export async function handleProjectsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/projects/')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/projects/'.length).split('/').filter(Boolean);

  // GET /api/projects/templates
  if (method === 'GET' && seg.length === 1 && seg[0] === 'templates') {
    ctx.json(res, 200, { templates: listTemplates() });
    return true;
  }

  // GET /api/projects/discover?path=
  if (method === 'GET' && seg.length === 1 && seg[0] === 'discover') {
    const target = url.searchParams.get('path');
    if (!target) {
      ctx.json(res, 400, { error: 'query param "path" is required' });
      return true;
    }
    try {
      ctx.json(res, 200, { profile: discoverProject(target) });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  // POST /api/projects/create  {name, template?, dir?}
  if (method === 'POST' && seg.length === 1 && seg[0] === 'create') {
    const body = await ctx.readBody(req);
    const name = body['name'] as string | undefined;
    const template = body['template'] as string | undefined;
    const dir = body['dir'] as string | undefined;
    const actor = (body['actor'] as string | undefined) ?? 'human';
    if (!name) {
      ctx.json(res, 400, { error: 'name is required' });
      return true;
    }
    try {
      const created = createProject({
        name,
        template: template as never,
        dir,
      });
      ctx.audit.record(actor, 'PROJECT_CREATED', 'project', created.name, {
        dir: created.dir,
        template: created.template,
        gitInitialized: created.gitInitialized,
      });
      ctx.json(res, 201, { project: created });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  // POST /api/projects/exec  {command, cwd, agentId?, timeoutMs?}
  if (method === 'POST' && seg.length === 1 && seg[0] === 'exec') {
    const body = await ctx.readBody(req);
    const command = body['command'] as string | undefined;
    const cwd = body['cwd'] as string | undefined;
    const actor = (body['actor'] as string | undefined) ?? 'human';
    const timeoutMs = body['timeoutMs'] as number | undefined;
    if (!command) {
      ctx.json(res, 400, { error: 'command is required' });
      return true;
    }
    if (!cwd || !isAbsolute(cwd)) {
      ctx.json(res, 400, { error: 'cwd must be an absolute path' });
      return true;
    }
    const root = resolve(cwd);
    try {
      if (!statSync(root).isDirectory()) throw new Error('not a directory');
    } catch {
      ctx.json(res, 400, { error: `sandbox root not found: ${root}` });
      return true;
    }

    const executor = new WorkspaceExecutor({
      root,
      permissions: ['READ', 'EXECUTE'],
      agentId: actor,
      timeoutMs,
      onAudit: (event) => {
        ctx.audit.record(event.agentId, 'PROJECT_EXEC', 'workspace', event.cwd, {
          command: event.command,
          kind: event.kind,
          exitCode: event.exitCode,
          timedOut: event.timedOut,
          durationMs: event.durationMs,
          reason: event.reason,
        });
      },
    });

    try {
      const result = await executor.exec(command);
      ctx.json(res, 200, { result });
    } catch (err) {
      // Policy rejections (whitelist, escape, network) → 403.
      const msg = (err as Error).message;
      const policy = /whitelist|rejected|escapes|NETWORK permission|empty command/.test(msg);
      ctx.json(res, policy ? 403 : 500, { error: msg });
    }
    return true;
  }

  return false;
}

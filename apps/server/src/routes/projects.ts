/**
 * Projects routes — spec §31–§33, §6.1 templates (Batch 33), §6.4
 * project knowledge (Batch 33).
 *
 *  GET  /api/projects/templates          list available project templates
 *  GET  /api/projects/templates/:name    template detail incl. files
 *  POST /api/projects/templates          register a template (operator)
 *                                         {name, description, language,
 *                                          framework, packageManager, files}
 *  DELETE /api/projects/templates/:name  unregister (builtin → 409)
 *  GET  /api/projects/discover?path=     analyze a directory → ProjectProfile
 *  POST /api/projects/create             {name, template?, dir?} → scaffold
 *                                         (template resolved against the
 *                                          server's registry: builtins +
 *                                          registered customs)
 *  POST /api/projects/clone              {url, name?, dir?, branch?} → clone
 *                                         a git repo into a dir and record
 *                                         the project (§6.1 Clone
 *                                         Repository; non-empty dir → 409)
 *  POST /api/projects/exec               {command, cwd, agentId?, timeoutMs?}
 *                                        run a whitelisted command in a
 *                                        sandboxed WorkspaceExecutor
 *  GET  /api/projects/:id/knowledge[?category=]
 *  GET  /api/projects/:id/knowledge/:entryId
 *  PUT  /api/projects/:id/knowledge      upsert (unknown category → 400)
 *  DELETE /api/projects/:id/knowledge/:entryId
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleProjectsRoutes, initProjectsRoutes } from './routes/projects';
 *   initProjectsRoutes(fdb, audit);   // at boot, before serving
 *   if (await handleProjectsRoutes(req, res, url, ctx)) return;
 *
 * Registered templates are persisted in fdb.projectTemplates and reloaded
 * at boot; the five builtins stay pinned in @ai-factory/projects.
 * Project knowledge entries are durable (§6.4 provenance: content is the
 * indexed summary, sourcePath/Version/Hash reference the source file).
 *
 * PROTOTYPE NOTE: POST /api/projects/exec grants READ + EXECUTE only.
 * `cwd` must be an absolute existing directory and becomes the sandbox
 * root, so the command cannot escape it. Network-capable commands are
 * rejected unless the workspace is granted NETWORK (not exposed here —
 * the coordinator must approve that escalation explicitly).
 */
import { mkdirSync, readdirSync, statSync } from 'fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  WorkspaceExecutor,
  createProject,
  discoverProject,
  ProjectTemplateRegistry,
  TemplateRegistrationError,
  validateTemplateRegistration,
} from '@ai-factory/projects';
import {
  PROJECT_KNOWLEDGE_CATEGORIES,
  isProjectKnowledgeCategory,
  newProjectKnowledgeEntryId,
  type ProjectKnowledgeCategory,
} from '@ai-factory/db';
import type { FactoryDatabase } from '@ai-factory/db';
import type { AuditLog } from '@ai-factory/core';
import type { RouteContext } from './context';

/**
 * Server-wide template registry: builtins + templates registered via
 * POST /api/projects/templates. Boot-wired by initProjectsRoutes (the
 * coordinator calls it once at startup; tests call it to reset).
 */
let templateRegistry: ProjectTemplateRegistry | null = null;

/** Boot wiring (called from the coordinator in index.ts). */
export function initProjectsRoutes(fdb: FactoryDatabase, audit: AuditLog): void {
  const registry = new ProjectTemplateRegistry();
  // Reload persisted custom templates (§6.1): a registered definition
  // that no longer validates is skipped loudly, never silently loaded.
  for (const row of fdb.projectTemplates.list()) {
    try {
      const def = JSON.parse(row.definitionJson) as Parameters<
        ProjectTemplateRegistry['register']
      >[0];
      validateTemplateRegistration(def);
      registry.register(def);
    } catch (err) {
      audit.record(
        'system',
        'TEMPLATE_RELOAD_SKIPPED',
        'project-template',
        row.name,
        { reason: (err as Error).message },
      );
    }
  }
  templateRegistry = registry;
}

function requireRegistry(): ProjectTemplateRegistry {
  if (!templateRegistry) throw new Error('projects routes not initialized');
  return templateRegistry;
}

function registrationErrorToStatus(err: TemplateRegistrationError): number {
  switch (err.code) {
    case 'TEMPLATE_EXISTS':
    case 'TEMPLATE_BUILTIN':
      return 409;
    case 'TEMPLATE_NOT_FOUND':
      return 404;
    default:
      return 400;
  }
}

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
    ctx.json(res, 200, { templates: requireRegistry().list() });
    return true;
  }

  // --- Project knowledge (§6.4): /api/projects/:id/knowledge[/:entryId] ---
  // (checked before template detail so a project literally named
  // "templates" keeps its knowledge surface reachable)
  if (seg.length >= 2 && seg[1] === 'knowledge') {
    return handleProjectKnowledgeRoutes(req, res, url, ctx, method, seg);
  }

  // GET /api/projects/templates/:name — detail incl. files
  if (method === 'GET' && seg.length === 2 && seg[0] === 'templates') {
    try {
      ctx.json(res, 200, { template: requireRegistry().get(seg[1]) });
    } catch (err) {
      const e = err as TemplateRegistrationError;
      ctx.json(res, registrationErrorToStatus(e), { error: e.message, code: e.code });
    }
    return true;
  }

  // POST /api/projects/templates — register a custom template (operator)
  if (method === 'POST' && seg.length === 1 && seg[0] === 'templates') {
    const body = await ctx.readBody(req);
    const actor = (body['actor'] as string | undefined) ?? 'human';
    const def = {
      name: body['name'],
      description: body['description'],
      language: body['language'],
      framework: body['framework'],
      packageManager: body['packageManager'],
      files: body['files'],
    };
    try {
      validateTemplateRegistration(
        def as Parameters<ProjectTemplateRegistry['register']>[0],
      );
      requireRegistry().register(
        def as Parameters<ProjectTemplateRegistry['register']>[0],
      );
      ctx.fdb.projectTemplates.save({
        name: def.name as string,
        definitionJson: JSON.stringify(def),
        registeredAt: new Date().toISOString(),
      });
      ctx.audit.record(actor, 'TEMPLATE_REGISTERED', 'project-template', def.name as string, {
        language: def.language,
        framework: def.framework,
        fileCount: Object.keys(def.files as Record<string, string>).length,
      });
      ctx.json(res, 201, { name: def.name });
    } catch (err) {
      const e = err as TemplateRegistrationError;
      ctx.json(res, registrationErrorToStatus(e), { error: e.message, code: e.code });
    }
    return true;
  }

  // DELETE /api/projects/templates/:name — unregister (builtin → 409)
  if (method === 'DELETE' && seg.length === 2 && seg[0] === 'templates') {
    const body = await ctx.readBody(req);
    const actor = (body['actor'] as string | undefined) ?? 'human';
    try {
      requireRegistry().unregister(seg[1]);
      ctx.fdb.projectTemplates.delete(seg[1]);
      ctx.audit.record(actor, 'TEMPLATE_UNREGISTERED', 'project-template', seg[1], {});
      ctx.json(res, 200, { unregistered: seg[1] });
    } catch (err) {
      const e = err as TemplateRegistrationError;
      ctx.json(res, registrationErrorToStatus(e), { error: e.message, code: e.code });
    }
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
        template,
        dir,
        registry: requireRegistry(),
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

  // POST /api/projects/clone  {url, name?, dir?, branch?, actor?} — §6.1
  // "Clone Repository" entry point (Batch 33).
  //
  // Clones a git repository into a working directory and records it as a
  // project with repository_refs = [url] (the asserted source — nothing
  // else about the remote is invented). Reusing a NON-EMPTY directory is
  // refused with 409 (§6.3 "不得覆盖非空目录"); an empty or missing
  // directory is used/created. Allowed sources: https://, http://,
  // file:// and absolute local paths (no ssh URLs — they can hang on
  // auth, and auth flow is Tan's explicit step). No shell is used
  // (execFileSync argv); a source starting with '-' is rejected so git
  // cannot read it as an option. A failed clone writes no project row.
  if (method === 'POST' && seg.length === 1 && seg[0] === 'clone') {
    const body = await ctx.readBody(req);
    const repoUrl = body['url'] as string | undefined;
    const actor = (body['actor'] as string | undefined) ?? 'human';
    const branch = body['branch'] as string | undefined;
    const dir = body['dir'] as string | undefined;
    if (!repoUrl || typeof repoUrl !== 'string') {
      ctx.json(res, 400, { error: 'url is required (https://, http://, file:// or an absolute local path)' });
      return true;
    }
    if (repoUrl.startsWith('-')) {
      ctx.json(res, 400, { error: 'url must not start with "-"' });
      return true;
    }
    const isHttp = /^https?:\/\//i.test(repoUrl);
    const isFileUrl = repoUrl.startsWith('file://');
    const isLocalPath = isAbsolute(repoUrl);
    if (!isHttp && !isFileUrl && !isLocalPath) {
      ctx.json(res, 400, { error: 'url must be https://, http://, file:// or an absolute local path' });
      return true;
    }
    if (branch !== undefined) {
      if (typeof branch !== 'string' || branch.startsWith('-') || !/^[A-Za-z0-9._/ -]+$/.test(branch)) {
        ctx.json(res, 400, { error: 'branch must be a plain git branch name' });
        return true;
      }
    }
    let name = body['name'] as string | undefined;
    if (!name) {
      const base = repoUrl.replace(/\/+$/, '').split('/').pop() ?? '';
      name = (decodeURIComponent(base).replace(/\.git$/, '') || 'project').slice(0, 120);
    }
    let target: string;
    if (dir !== undefined) {
      if (typeof dir !== 'string' || !isAbsolute(dir)) {
        ctx.json(res, 400, { error: 'dir must be an absolute path' });
        return true;
      }
      target = resolve(dir);
    } else {
      target = resolve(process.cwd(), 'data', 'projects', name);
    }
    let entries: string[] | null = null;
    try {
      entries = readdirSync(target);
    } catch {
      // Missing directory — will be created for the clone.
    }
    if (entries !== null && entries.length > 0) {
      ctx.json(res, 409, {
        error: `target directory is not empty: ${target}`,
        code: 'PROJECT_DIR_NOT_EMPTY',
      });
      return true;
    }
    try {
      mkdirSync(target, { recursive: true });
      const args = ['clone'];
      if (branch) args.push('--branch', branch);
      args.push(repoUrl, target);
      execFileSync('git', args, {
        timeout: 5 * 60 * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.audit.record(actor, 'PROJECT_CLONE_FAILED', 'project', name, {
        url: repoUrl,
        dir: target,
        reason: msg.slice(0, 500),
      });
      ctx.json(res, 502, { error: `git clone failed: ${msg.slice(0, 500)}`, code: 'CLONE_FAILED' });
      return true;
    }
    const p = ctx.fdb.createProject({
      id: randomUUID(),
      name,
      description: '',
      path: target,
      repository_refs: [repoUrl],
    });
    ctx.audit.record(actor, 'PROJECT_CLONED', 'project', p.id, {
      name,
      url: repoUrl,
      dir: target,
      branch: branch ?? null,
    });
    ctx.json(res, 201, { project: p });
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

/**
 * Project knowledge routes — spec §6.4 (Batch 33).
 *
 *   GET    /api/projects/:id/knowledge[?category=]
 *   GET    /api/projects/:id/knowledge/:entryId
 *   PUT    /api/projects/:id/knowledge   {title, category, content,
 *                                          sourcePath?, sourceVersion?,
 *                                          sourceHash?} → upsert
 *   DELETE /api/projects/:id/knowledge/:entryId
 *
 * Unknown category → 400 UNKNOWN_KNOWLEDGE_CATEGORY (the categories are
 * the nine spec rows; the server never invents a category). Entries are
 * durable in fdb.projectKnowledge. content is the indexed summary;
 * sourcePath/Version/Hash reference the source file per §6.4.
 */
async function handleProjectKnowledgeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
  method: string,
  seg: string[],
): Promise<boolean> {
  const projectId = seg[0];
  const store = ctx.fdb.projectKnowledge;
  const now = () => new Date().toISOString();

  // GET /api/projects/:id/knowledge[?category=]
  if (method === 'GET' && seg.length === 2) {
    const rawCat = url.searchParams.get('category');
    if (rawCat !== null && !isProjectKnowledgeCategory(rawCat)) {
      ctx.json(res, 400, {
        error: `unknown project knowledge category ${JSON.stringify(rawCat)}; expected one of: ${PROJECT_KNOWLEDGE_CATEGORIES.join(', ')}`,
        code: 'UNKNOWN_KNOWLEDGE_CATEGORY',
      });
      return true;
    }
    ctx.json(res, 200, {
      items: store.list(projectId, rawCat === null ? undefined : rawCat),
    });
    return true;
  }

  // GET /api/projects/:id/knowledge/:entryId
  if (method === 'GET' && seg.length === 3) {
    const entry = store.get(seg[2]);
    if (!entry) {
      ctx.json(res, 404, { error: `knowledge entry '${seg[2]}' not found` });
      return true;
    }
    ctx.json(res, 200, { entry });
    return true;
  }

  // PUT /api/projects/:id/knowledge — upsert
  if (method === 'PUT' && seg.length === 2) {
    const body = await ctx.readBody(req);
    const actor = (body['actor'] as string | undefined) ?? 'human';
    const { title, category, content, sourcePath, sourceVersion, sourceHash } = body as {
      title?: unknown;
      category?: unknown;
      content?: unknown;
      sourcePath?: unknown;
      sourceVersion?: unknown;
      sourceHash?: unknown;
    };
    if (typeof title !== 'string' || title.length === 0 || title.length > 200) {
      ctx.json(res, 400, { error: 'title is required (non-empty, <=200 chars)' });
      return true;
    }
    if (!isProjectKnowledgeCategory(category)) {
      ctx.json(res, 400, {
        error: `unknown project knowledge category ${JSON.stringify(category)}; expected one of: ${PROJECT_KNOWLEDGE_CATEGORIES.join(', ')}`,
        code: 'UNKNOWN_KNOWLEDGE_CATEGORY',
      });
      return true;
    }
    if (typeof content !== 'string' || content.length === 0) {
      ctx.json(res, 400, { error: 'content is required (non-empty string)' });
      return true;
    }
    const optStr = (v: unknown): string | null | 'INVALID' =>
      v === undefined || v === null ? null : typeof v === 'string' ? v : 'INVALID';
    const sPath = optStr(sourcePath);
    const sVer = optStr(sourceVersion);
    const sHash = optStr(sourceHash);
    if (sPath === 'INVALID' || sVer === 'INVALID' || sHash === 'INVALID') {
      ctx.json(res, 400, { error: 'sourcePath/sourceVersion/sourceHash must be strings or null' });
      return true;
    }
    const entry = {
      entryId: newProjectKnowledgeEntryId(),
      projectId,
      category: category as ProjectKnowledgeCategory,
      title,
      content,
      sourcePath: sPath,
      sourceVersion: sVer,
      sourceHash: sHash,
      createdAt: now(),
      updatedAt: now(),
    };
    const effectiveId = store.upsert(entry);
    ctx.audit.record(actor, 'PROJECT_KNOWLEDGE_UPSERTED', 'project-knowledge', effectiveId, {
      projectId,
      category,
      title,
    });
    ctx.json(res, 200, { entry: store.get(effectiveId) });
    return true;
  }

  // DELETE /api/projects/:id/knowledge/:entryId
  if (method === 'DELETE' && seg.length === 3) {
    const body = await ctx.readBody(req);
    const actor = (body['actor'] as string | undefined) ?? 'human';
    const existing = store.get(seg[2]);
    if (!existing || existing.projectId !== projectId) {
      ctx.json(res, 404, { error: `knowledge entry '${seg[2]}' not found` });
      return true;
    }
    store.delete(seg[2]);
    ctx.audit.record(actor, 'PROJECT_KNOWLEDGE_DELETED', 'project-knowledge', seg[2], {
      projectId,
      category: existing.category,
      title: existing.title,
    });
    ctx.json(res, 200, { deleted: seg[2] });
    return true;
  }

  return false;
}

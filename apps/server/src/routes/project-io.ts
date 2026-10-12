/**
 * Project import/export routes — spec §4 module 33 (Import / Export),
 * §98 (project.yaml), §103 (.ai/ directory structure).
 *
 *  GET  /api/projects/:id/export
 *       Export the project's configuration as multi-file JSON
 *       { projectId, exportedAt, format, files: {".ai/...": "..."} }.
 *       The client downloads it as `<name>.ai-export.json`.
 *  POST /api/projects/:id/import   {files: {".ai/...": "..."}}
 *       Run the §52.4 v1→v2 migration first (v1-shaped sections are
 *       migrated and reported, never silently read as v2), then
 *       validate the migrated export (schema + secret-value scan); on
 *       any issue NOTHING is written and the issues are returned (422).
 *       On success the files are written to `<projectDir>/.ai/`. Both
 *       responses carry the structured `migration` report.
 *
 * PROTOTYPE NOTE: agents are the AI employees assigned to the project's
 * tasks (the agents table has no project_id); workflows and memory are
 * read from SQLite by project scope; skills/knowledge/mcp registries are
 * in-memory in their own route modules, so those sections export empty
 * until a persistent registry lands.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleProjectIoRoutes } from './routes/project-io';
 *   if (await handleProjectIoRoutes(req, res, url, ctx)) return;
 * (after handleProjectsRoutes — that handler returns false for these paths)
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { resolve } from 'path';
import {
  buildExportFiles,
  EXPORT_FORMAT,
  importProjectAi,
  type AgentExport,
  type ExportFiles,
  type MemoryExport,
  type ProjectExportData,
  type WorkflowExport,
} from '@ai-factory/project-io';
import type { RouteContext } from './context';
import { projectArchivedBody } from './project-guard';

function collectAgentIds(ctx: RouteContext, projectId: string): string[] {
  const ids = new Set<string>();
  for (const t of ctx.fdb.tasks.listByProject(projectId)) {
    if (t.currentAgentId) ids.add(t.currentAgentId);
    for (const a of t.assignedAgentIds ?? []) ids.add(a);
  }
  return [...ids];
}

function toAgentExport(ctx: RouteContext, id: string): AgentExport | null {
  const a = ctx.fdb.agents.get(id);
  if (!a) return null;
  const perms = Array.isArray(a.permissions)
    ? a.permissions.map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    : undefined;
  return {
    id: a.id,
    name: a.name,
    displayName: a.displayName || undefined,
    jobTitle: a.jobTitle || undefined,
    department: a.department || undefined,
    mission: a.mission || undefined,
    instructions: a.instructions || undefined,
    skills: a.skills?.length ? a.skills : undefined,
    rules: a.rules?.length ? a.rules : undefined,
    model: a.model || undefined,
    tools: a.tools?.length ? a.tools : undefined,
    permissions: perms?.length ? perms : undefined,
    autonomyLevel: typeof a.autonomyLevel === 'number' ? a.autonomyLevel : undefined,
  };
}

function collectWorkflows(ctx: RouteContext, projectId: string): WorkflowExport[] {
  const rows = ctx.fdb.db
    .prepare('SELECT id, name, definition FROM workflows WHERE project_id = ? ORDER BY name')
    .all(projectId) as { id: string; name: string; definition: string }[];
  return rows.map((r) => {
    let definition: unknown;
    try {
      definition = r.definition ? JSON.parse(r.definition) : undefined;
    } catch {
      definition = r.definition;
    }
    return { id: r.id, name: r.name, definition };
  });
}

function collectMemory(ctx: RouteContext, projectId: string): MemoryExport[] {
  return ctx.fdb.memory
    .query({ scope: 'project', scopeId: projectId })
    .map((m) => ({
      id: m.id,
      scope: m.scope,
      type: String(m.type ?? ''),
      title: m.title,
      content: m.content || undefined,
      confidence: typeof m.confidence === 'number' ? m.confidence : undefined,
    }));
}

function buildData(ctx: RouteContext, projectId: string): ProjectExportData | null {
  const p = ctx.fdb.getProject(projectId);
  if (!p) return null;
  const agents: AgentExport[] = [];
  for (const id of collectAgentIds(ctx, projectId)) {
    const a = toAgentExport(ctx, id);
    if (a) agents.push(a);
  }
  return {
    project: { id: p.id, name: p.name, description: p.description ?? '', path: p.path ?? '' },
    agents,
    skills: [],
    workflows: collectWorkflows(ctx, projectId),
    knowledge: [],
    memory: collectMemory(ctx, projectId),
    mcp: [],
  };
}

export async function handleProjectIoRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/projects/')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/projects/'.length).split('/').filter(Boolean);
  if (seg.length !== 2 || (seg[1] !== 'export' && seg[1] !== 'import')) return false;
  const projectId = decodeURIComponent(seg[0]);

  // GET /api/projects/:id/export
  if (method === 'GET' && seg[1] === 'export') {
    const data = buildData(ctx, projectId);
    if (!data) {
      ctx.json(res, 404, { error: `project not found: ${projectId}` });
      return true;
    }
    const files = buildExportFiles(data);
    ctx.json(res, 200, {
      projectId,
      exportedAt: new Date().toISOString(),
      format: EXPORT_FORMAT,
      files,
    });
    return true;
  }

  // POST /api/projects/:id/import
  if (method === 'POST' && seg[1] === 'import') {
    const project = ctx.fdb.getProject(projectId);
    if (!project) {
      ctx.json(res, 404, { error: `project not found: ${projectId}` });
      return true;
    }
    // Import WRITES into the project — archived projects are closed to
    // new facts (Batch 14; export above stays readable). The refusal is
    // audited, matching this route's rejected-import convention.
    if (project.status === 'archived') {
      ctx.audit.record('human', 'PROJECT_IMPORT_REJECTED', 'project', projectId, {
        reason: 'PROJECT_ARCHIVED',
      });
      ctx.json(res, 409, projectArchivedBody(projectId));
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await ctx.readBody(req);
    } catch {
      ctx.json(res, 400, { error: 'invalid JSON body' });
      return true;
    }
    const files = body['files'] as ExportFiles | undefined;
    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      ctx.json(res, 400, { error: 'body.files must be an object of path -> text' });
      return true;
    }
    const targetDir = project.path ? resolve(project.path) : resolve('data', 'projects', projectId);
    let result;
    try {
      result = importProjectAi(files, { targetDir });
    } catch (err) {
      ctx.json(res, 500, { error: (err as Error).message });
      return true;
    }
    if (!result.ok) {
      ctx.audit.record('human', 'PROJECT_IMPORT_REJECTED', 'project', projectId, {
        issues: result.issues.length,
        v1MigrationDetected: result.migration?.detected ?? false,
      });
      ctx.json(res, 422, { ok: false, issues: result.issues, migration: result.migration ?? null });
      return true;
    }
    ctx.audit.record('human', 'PROJECT_IMPORTED', 'project', projectId, {
      written: result.written.length,
      targetDir,
      v1MigrationDetected: result.migration?.detected ?? false,
    });
    ctx.json(res, 200, { ok: true, targetDir, written: result.written, migration: result.migration ?? null });
    return true;
  }

  return false;
}

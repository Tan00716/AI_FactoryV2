/**
 * Tiered rule files — server routes (round-6 task R6-A6).
 *
 *   GET    /api/rules?root=                    full view: global + project
 *                                                 + compat + effective
 *   POST   /api/rules                          add a managed rule
 *   PATCH  /api/rules?id=&scope=&root=         rename / edit / enable / order
 *   DELETE /api/rules?id=&scope=&root=         remove a managed rule
 *   POST   /api/rules/order                    reorder one level (exact
 *                                                 permutation of its ids)
 *
 * Storage: global rules live in <globalDir>/rules.json (default
 * ~/.ai-factory/rules, injected for tests); project rules live in
 * <root>/.ai-factory/rules.json. Both files are written atomically
 * (tmp + rename). Project roots are jailed through the injected
 * inspection-root resolver; a root outside the allowed roots is 403.
 *
 * Compat files (AGENTS.md / .cursorrules / .clinerules at the project
 * root) are READ-ONLY: the GET view surfaces them with their source
 * labelled, but no endpoint edits them — their free-form formatting must
 * not be rewritten by a JSON round-trip.
 *
 * Dual-mode import rule (AGENTS.md): value-imports only node builtins and
 * @ai-factory/rules; the root jail and global dir come via setter
 * injection wired in apps/server/src/index.ts.
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import {
  addRule,
  annotateOverridden,
  mergeEffective,
  patchRule,
  readCompatFiles,
  readStoreFile,
  reorderRules,
  sortRules,
  writeStoreFile,
  type ManagedRule,
} from '@ai-factory/rules';

const PREFIX = '/api/rules';
const GLOBAL_FILE = 'rules.json';
const PROJECT_FILE = join('.ai-factory', 'rules.json');

class RulesRouteError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'RulesRouteError';
    this.status = status;
  }
}

let rootResolver: ((root?: string) => string) | null = null;
export function setRulesInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  rootResolver = fn;
}
let globalDirResolver: (() => string) | null = null;
export function setRulesGlobalDirResolver(fn: (() => string) | null): void {
  globalDirResolver = fn;
}

function resolveRoot(rawRoot?: string): string {
  if (!rootResolver) throw new RulesRouteError('inspection root resolver is not wired', 500);
  try {
    return rootResolver(rawRoot);
  } catch (e) {
    throw new RulesRouteError((e as Error).message, 403);
  }
}

function globalFile(): string {
  // Env override exists so smoke tests (and operators) can point the
  // global level at an isolated directory; default is ~/.ai-factory/rules.
  if (globalDirResolver) return join(globalDirResolver(), GLOBAL_FILE);
  const dir = process.env.AI_FACTORY_GLOBAL_RULES_DIR
    ?? join(homedir(), '.ai-factory', 'rules');
  return join(dir, GLOBAL_FILE);
}

function projectFile(root: string): string {
  return join(root, PROJECT_FILE);
}

function loadLevel(file: string): ManagedRule[] {
  return sortRules(readStoreFile(file).rules);
}

function saveLevel(file: string, rules: ManagedRule[]): void {
  try {
    writeStoreFile(file, { version: 1, rules });
  } catch (e) {
    throw new RulesRouteError(`failed to persist rules: ${(e as Error).message}`, 500);
  }
}

function scopeOf(body: Record<string, unknown>, query: URLSearchParams): 'global' | 'project' {
  const raw = body['scope'] ?? query.get('scope');
  if (raw === 'global' || raw === 'project') return raw;
  throw new RulesRouteError('scope must be "global" or "project"');
}

function readLevel(scope: 'global' | 'project', root?: string): { file: string; rules: ManagedRule[] } {
  if (scope === 'global') {
    const file = globalFile();
    return { file, rules: loadLevel(file) };
  }
  if (!root) throw new RulesRouteError('root is required for project rules');
  const file = projectFile(root);
  return { file, rules: loadLevel(file) };
}

function sendError(res: ServerResponse, ctx: RouteContext, e: unknown): boolean {
  if (e instanceof RulesRouteError) {
    ctx.json(res, e.status, { error: e.message, code: 'rules-error' });
    return true;
  }
  ctx.json(res, 500, { error: 'internal rules error', code: 'rules-internal' });
  return true;
}

async function handleGet(res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  try {
    const root = resolveRoot(url.searchParams.get('root') ?? undefined);
    const globalRules = loadLevel(globalFile());
    const projectRules = loadLevel(projectFile(root));
    const compat = readCompatFiles(root);
    ctx.json(res, 200, {
      root,
      global: annotateOverridden(globalRules, projectRules),
      project: projectRules,
      compat,
      effective: mergeEffective(globalRules, projectRules, compat),
    });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}

async function handleAdd(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const body = (await ctx.readBody(req)) as Record<string, unknown>;
    const scope = scopeOf(body, new URLSearchParams());
    const root = scope === 'project'
      ? resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined)
      : undefined;
    const { file, rules } = readLevel(scope, root);
    const { rule, issues } = addRule(
      rules,
      {
        name: body['name'] as string,
        content: body['content'] as string,
        scope,
        ...(body['order'] !== undefined ? { order: body['order'] as number } : {}),
      },
      () => randomUUID(),
      () => Date.now(),
    );
    if (!rule) {
      ctx.json(res, 400, { error: issues.join('; '), code: 'rules-invalid' });
      return true;
    }
    rules.push(rule);
    saveLevel(file, rules);
    ctx.audit.record('human', 'RULE_ADDED', 'rules', root ?? 'global', { id: rule.id, scope, name: rule.name });
    ctx.json(res, 201, { rule });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}

async function handlePatch(req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  try {
    const body = (await ctx.readBody(req)) as Record<string, unknown>;
    const id = url.searchParams.get('id');
    if (!id) throw new RulesRouteError('id is required');
    const scope = scopeOf(body, url.searchParams);
    const root = scope === 'project' ? resolveRoot(url.searchParams.get('root') ?? undefined) : undefined;
    const { file, rules } = readLevel(scope, root);
    const patch: { name?: string; content?: string; enabled?: boolean; order?: number } = {};
    if (body['name'] !== undefined) patch.name = body['name'] as string;
    if (body['content'] !== undefined) patch.content = body['content'] as string;
    if (body['enabled'] !== undefined) patch.enabled = body['enabled'] as boolean;
    if (body['order'] !== undefined) patch.order = body['order'] as number;
    const { rule, issues } = patchRule(rules, id, patch, () => Date.now());
    if (!rule) {
      const status = issues.includes('rule not found') ? 404 : 400;
      ctx.json(res, status, { error: issues.join('; '), code: 'rules-invalid' });
      return true;
    }
    saveLevel(file, rules.map((r) => (r.id === id ? rule : r)));
    ctx.audit.record('human', 'RULE_UPDATED', 'rules', root ?? 'global', { id, scope });
    ctx.json(res, 200, { rule });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}

async function handleDelete(res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  try {
    const id = url.searchParams.get('id');
    if (!id) throw new RulesRouteError('id is required');
    const scope = scopeOf({}, url.searchParams);
    const root = scope === 'project' ? resolveRoot(url.searchParams.get('root') ?? undefined) : undefined;
    const { file, rules } = readLevel(scope, root);
    if (!rules.some((r) => r.id === id)) {
      ctx.json(res, 404, { error: 'rule not found', code: 'rules-invalid' });
      return true;
    }
    saveLevel(file, rules.filter((r) => r.id !== id));
    ctx.audit.record('human', 'RULE_DELETED', 'rules', root ?? 'global', { id, scope });
    ctx.json(res, 200, { deleted: id });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}

async function handleOrder(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const body = (await ctx.readBody(req)) as Record<string, unknown>;
    const scope = scopeOf(body, new URLSearchParams());
    const root = scope === 'project'
      ? resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined)
      : undefined;
    const { file, rules } = readLevel(scope, root);
    const ids = body['ids'];
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) {
      throw new RulesRouteError('ids must be an array of rule ids');
    }
    const { rules: reordered, issues } = reorderRules(rules, ids as string[], () => Date.now());
    if (!reordered) {
      ctx.json(res, 400, { error: issues.join('; '), code: 'rules-invalid' });
      return true;
    }
    saveLevel(file, reordered);
    ctx.audit.record('human', 'RULES_REORDERED', 'rules', root ?? 'global', { scope });
    ctx.json(res, 200, { rules: reordered });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}

export async function handleRulesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  if (!url.pathname.startsWith(PREFIX)) return false;
  const rest = url.pathname.slice(PREFIX.length);
  try {
    if (req.method === 'GET' && rest === '') return handleGet(res, url, ctx);
    if (req.method === 'POST' && rest === '') return handleAdd(req, res, ctx);
    if (req.method === 'PATCH' && rest === '') return handlePatch(req, res, url, ctx);
    if (req.method === 'DELETE' && rest === '') return handleDelete(res, url, ctx);
    if (req.method === 'POST' && rest === '/order') return handleOrder(req, res, ctx);
    ctx.json(res, 404, { error: 'unknown rules route', code: 'rules-error' });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}

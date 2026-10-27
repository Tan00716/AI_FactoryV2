/**
 * Extension routes (round-6 R6-S1) — VS Code-style extension API, local subset.
 *
 *   GET    /api/extensions?root=                    list installed extensions (+ broken dirs)
 *   GET    /api/extensions/schema                   manifest schema documentation
 *   GET    /api/extensions/panels?root=             contributed panels of enabled extensions
 *   GET    /api/extensions/providers?root=          contributed context providers
 *   POST   /api/extensions/install                 {root, manifest, main} (inline install)
 *   POST   /api/extensions/install-from-dir        {root, sourceDir} (jailed, no symlinks)
 *   POST   /api/extensions/:name/enable            {root}
 *   POST   /api/extensions/:name/disable           {root}
 *   DELETE /api/extensions/:name?root=             uninstall
 *   POST   /api/extensions/:name/commands/:cmd/run {root, args}
 *   POST   /api/extensions/:name/providers/:id/resolve {root, query}
 *
 * Extensions are project-local: <root>/.ai-factory/extensions/<name>/.
 * Commands and providers execute in the node:vm sandbox
 * (@ai-factory/extensions sandbox.ts); panels and checkers are
 * declarative and run no extension code. Checkers plug into inspections
 * via extensionCheckerProvider (wired in index.ts through
 * setExtraCheckerProvider, alongside SSR/Trojan/spell).
 *
 * Dual-mode import rule (AGENTS.md): value-imports only node builtins
 * and @ai-factory/extensions; the root jail comes via setter injection,
 * and the inspections Checker type is imported type-only.
 */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import type { Checker, Finding } from '../inspections';
import {
  checkLine,
  enabledExtensions,
  installExtension,
  installExtensionFromDir,
  listExtensionsVerbose,
  loadExtension,
  readExtension,
  setExtensionEnabled,
  uninstallExtension,
  ExtensionError,
  type ExtensionInfo,
} from '@ai-factory/extensions';

const PREFIX = '/api/extensions';

class ExtensionRouteError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ExtensionRouteError';
    this.status = status;
  }
}

let rootResolver: ((root?: string) => string) | null = null;
export function setExtensionInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  rootResolver = fn;
}

function resolveRoot(rawRoot?: string): string {
  if (!rootResolver) throw new ExtensionRouteError('extension root resolver is not wired', 503);
  try {
    return rootResolver(rawRoot);
  } catch (e) {
    throw new ExtensionRouteError(e instanceof Error ? e.message : String(e), 403);
  }
}

function jailPathInsideRoot(root: string, candidate: string): string {
  const resolved = resolve(candidate);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new ExtensionRouteError('path escapes the inspection root', 403);
  }
  return resolved;
}

function sendError(res: ServerResponse, ctx: RouteContext, e: unknown): boolean {
  if (e instanceof ExtensionRouteError) {
    ctx.json(res, e.status, { error: e.message, code: 'extension-error' });
    return true;
  }
  if (e instanceof ExtensionError) {
    ctx.json(res, 400, { error: e.message, code: 'extension-error' });
    return true;
  }
  ctx.json(res, 500, { error: 'internal extension error', code: 'extension-internal' });
  return true;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function handleList(res: ServerResponse, url: URL, ctx: RouteContext): boolean {
  const root = resolveRoot(url.searchParams.get('root') ?? undefined);
  const { installed, broken } = listExtensionsVerbose(root);
  ctx.json(res, 200, { root, installed, broken });
  return true;
}

function handleSchema(res: ServerResponse, ctx: RouteContext): boolean {
  ctx.json(res, 200, {
    manifest: 'extension.json: { name, version, description, author?, permissions?, contributes? }',
    name: '^[a-z0-9][a-z0-9._-]{1,63}$',
    version: 'semver-like ^\\d+\\.\\d+\\.\\d+(-suffix)?$',
    permissions: ['commands.execute', 'panels.contribute', 'checkers.contribute', 'providers.contribute'],
    contributes: {
      commands: [{ id: 'id', title: 'title', description: 'optional' }],
      panels: [{ id: 'id', title: 'title', sections: [{ heading: 'optional', text: 'text' }] }],
      checkers: [{ id: 'id', title: 'title', pattern: 'regex', flags: 'i only', message: 'msg', severity: 'error|warning|info', filePattern: 'glob, optional' }],
      providers: [{ id: 'id', prefix: '@name', description: 'optional' }],
    },
    main: 'main.js: runs in a node:vm sandbox with only the `api` global (log, registerCommand, registerContextProvider). No require/process/Buffer/eval/Function. Handlers must be synchronous and return JSON values.',
    sandbox: 'code generation disabled, load timeout 2000ms, invoke timeout 5000ms, args/result capped at 64KB.',
    marketplace: 'none in v1: install is local-only (inline manifest+main, or a jailed local directory). No auto-update.',
  });
  return true;
}

function handlePanels(res: ServerResponse, url: URL, ctx: RouteContext): boolean {
  const root = resolveRoot(url.searchParams.get('root') ?? undefined);
  const panels: Array<{ extension: string; id: string; title: string; sections: ExtensionInfo['panels'][number]['sections'] }> = [];
  for (const ext of enabledExtensions(root)) {
    for (const p of ext.manifest.contributes.panels) {
      panels.push({ extension: ext.manifest.name, id: p.id, title: p.title, sections: p.sections });
    }
  }
  ctx.json(res, 200, { root, panels });
  return true;
}

function handleProviders(res: ServerResponse, url: URL, ctx: RouteContext): boolean {
  const root = resolveRoot(url.searchParams.get('root') ?? undefined);
  const providers: Array<{ extension: string; id: string; prefix: string; description?: string }> = [];
  for (const ext of enabledExtensions(root)) {
    for (const p of ext.manifest.contributes.providers) {
      providers.push({ extension: ext.manifest.name, id: p.id, prefix: p.prefix, description: p.description });
    }
  }
  ctx.json(res, 200, { root, providers });
  return true;
}

async function handleInstall(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const body = (await ctx.readBody(req)) as Record<string, unknown>;
  const root = resolveRoot(str(body.root));
  const extension = installExtension(root, body.manifest, body.main);
  ctx.audit.record('human', 'EXT_INSTALLED', 'extensions', root, { name: extension.name });
  ctx.json(res, 201, { extension });
  return true;
}

async function handleInstallFromDir(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const body = (await ctx.readBody(req)) as Record<string, unknown>;
  const root = resolveRoot(str(body.root));
  const sourceDir = str(body.sourceDir);
  if (!sourceDir) throw new ExtensionRouteError('sourceDir is required');
  const jailed = jailPathInsideRoot(root, sourceDir);
  let st;
  try {
    st = lstatSync(jailed);
  } catch {
    throw new ExtensionRouteError('sourceDir does not exist', 404);
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new ExtensionRouteError('sourceDir must be a real directory (no symlinks)', 400);
  }
  const extension = installExtensionFromDir(root, jailed);
  ctx.audit.record('human', 'EXT_INSTALLED', 'extensions', root, { name: extension.name });
  ctx.json(res, 201, { extension });
  return true;
}

async function handleEnable(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  enable: boolean,
  ctx: RouteContext,
): Promise<boolean> {
  const body = (await ctx.readBody(req)) as Record<string, unknown>;
  const root = resolveRoot(str(body.root));
  const extension = setExtensionEnabled(root, name, enable);
  ctx.audit.record('human', enable ? 'EXT_ENABLED' : 'EXT_DISABLED', 'extensions', root, { name });
  ctx.json(res, 200, { extension });
  return true;
}

function handleUninstall(res: ServerResponse, url: URL, name: string, ctx: RouteContext): boolean {
  const root = resolveRoot(url.searchParams.get('root') ?? undefined);
  uninstallExtension(root, name);
  ctx.audit.record('human', 'EXT_UNINSTALLED', 'extensions', root, { name });
  ctx.json(res, 200, { ok: true, removed: name });
  return true;
}

async function handleRunCommand(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  command: string,
  ctx: RouteContext,
): Promise<boolean> {
  const body = (await ctx.readBody(req)) as Record<string, unknown>;
  const root = resolveRoot(str(body.root));
  const { manifest, main, state } = readExtension(root, name);
  if (!state.enabled) throw new ExtensionRouteError(`extension is disabled: ${name}`, 409);
  let out;
  try {
    out = loadExtension(manifest, main).runCommand(command, body.args ?? {});
  } catch (e) {
    if (e instanceof ExtensionError) {
      const msg = e.message;
      const status = /timed out/.test(msg) ? 504 : /unknown command/.test(msg) ? 404 : 400;
      throw new ExtensionRouteError(msg, status);
    }
    throw e;
  }
  ctx.audit.record('human', 'EXT_COMMAND_RUN', 'extensions', root, { name, command });
  ctx.json(res, 200, { extension: name, command, result: out.result, logs: out.logs });
  return true;
}

async function handleResolveProvider(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  provider: string,
  ctx: RouteContext,
): Promise<boolean> {
  const body = (await ctx.readBody(req)) as Record<string, unknown>;
  const root = resolveRoot(str(body.root));
  const { manifest, main, state } = readExtension(root, name);
  if (!state.enabled) throw new ExtensionRouteError(`extension is disabled: ${name}`, 409);
  const query = str(body.query);
  if (query === undefined) throw new ExtensionRouteError('query is required');
  let out;
  try {
    out = loadExtension(manifest, main).resolveProvider(provider, query);
  } catch (e) {
    if (e instanceof ExtensionError) {
      const msg = e.message;
      const status = /timed out/.test(msg) ? 504 : /unknown provider/.test(msg) ? 404 : 400;
      throw new ExtensionRouteError(msg, status);
    }
    throw e;
  }
  ctx.json(res, 200, { extension: name, provider, items: out.items, logs: out.logs });
  return true;
}

/**
 * Inspection checker provider for enabled extensions' declarative checkers.
 * Wired in index.ts via setExtraCheckerProvider (alongside SSR/Trojan/spell).
 * Checker names are `ext:<extension>:<checker-id>` and gate on the
 * 'extensions' profile key (see builtinCheckers). No extension code runs
 * for checks: the host evaluates the manifest regex itself.
 */
export function extensionCheckerProvider(root: string): Checker[] {
  const out: Checker[] = [];
  let enabled: ReturnType<typeof enabledExtensions> = [];
  try {
    enabled = enabledExtensions(root);
  } catch {
    return out;
  }
  for (const ext of enabled) {
    for (const c of ext.manifest.contributes.checkers) {
      const name = `ext:${ext.manifest.name}:${c.id}`;
      const checker = c;
      const severity = checker.severity ?? 'warning';
      out.push({
        name,
        description: `${ext.manifest.name}: ${checker.title}`,
        run({ file, lines }: { file: string; lines: string[] }): Finding[] {
          const findings: Finding[] = [];
          lines.forEach((line, i) => {
            if (!checkLine(checker, file, line)) return;
            const body = { checker: name, file, line: i + 1, message: checker.message };
            findings.push({ ...body, id: findingIdLocal(body), severity });
          });
          return findings;
        },
      });
    }
  }
  return out;
}

function findingIdLocal(f: { checker: string; file: string; line: number; message: string }): string {
  // Same shape as inspections.ts findingId (sha1 of
  // checker|file|line|normalized-message, first 12 hex chars), reproduced
  // here because route modules must not value-import inspections.ts.
  const norm = f.message.trim().replace(/\s+/g, ' ');
  const sig = [f.checker, f.file, f.line, norm].join('\0');
  return createHash('sha1').update(sig, 'utf8').digest('hex').slice(0, 12);
}

export async function handleExtensionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  if (!url.pathname.startsWith(PREFIX)) return false;
  const rest = url.pathname.slice(PREFIX.length);
  try {
    if (req.method === 'GET' && (rest === '' || rest === '/')) return handleList(res, url, ctx);
    if (req.method === 'GET' && rest === '/schema') return handleSchema(res, ctx);
    if (req.method === 'GET' && rest === '/panels') return handlePanels(res, url, ctx);
    if (req.method === 'GET' && rest === '/providers') return handleProviders(res, url, ctx);
    // NOTE: async handlers must be awaited here — a bare `return
    // handleX()` would let a rejection escape this try/catch (the
    // round-5 A7 route-swallow lesson: dispatcher must see the error).
    if (req.method === 'POST' && rest === '/install') return await handleInstall(req, res, ctx);
    if (req.method === 'POST' && rest === '/install-from-dir') return await handleInstallFromDir(req, res, ctx);
    const enableMatch = /^\/([^/]+)\/enable$/.exec(rest);
    if (req.method === 'POST' && enableMatch) {
      return await handleEnable(req, res, decodeURIComponent(enableMatch[1]), true, ctx);
    }
    const disableMatch = /^\/([^/]+)\/disable$/.exec(rest);
    if (req.method === 'POST' && disableMatch) {
      return await handleEnable(req, res, decodeURIComponent(disableMatch[1]), false, ctx);
    }
    const runMatch = /^\/([^/]+)\/commands\/([^/]+)\/run$/.exec(rest);
    if (req.method === 'POST' && runMatch) {
      return await handleRunCommand(req, res, decodeURIComponent(runMatch[1]), decodeURIComponent(runMatch[2]), ctx);
    }
    const resolveMatch = /^\/([^/]+)\/providers\/([^/]+)\/resolve$/.exec(rest);
    if (req.method === 'POST' && resolveMatch) {
      return await handleResolveProvider(req, res, decodeURIComponent(resolveMatch[1]), decodeURIComponent(resolveMatch[2]), ctx);
    }
    const deleteMatch = /^\/([^/]+)$/.exec(rest);
    if (req.method === 'DELETE' && deleteMatch) {
      return handleUninstall(res, url, decodeURIComponent(deleteMatch[1]), ctx);
    }
    ctx.json(res, 404, { error: 'unknown extensions route', code: 'not-found' });
    return true;
  } catch (e) {
    return sendError(res, ctx, e);
  }
}

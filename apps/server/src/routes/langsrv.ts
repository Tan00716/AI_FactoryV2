/**
 * Language-service routes — precise code intelligence (V3-#6).
 *
 *   GET  /api/langsrv/status
 *   POST /api/langsrv/definition      { root, file, line, character }
 *   POST /api/langsrv/references      { root, file, line, character }
 *   POST /api/langsrv/hover           { root, file, line, character }
 *   POST /api/langsrv/outline         { root, file }
 *   POST /api/langsrv/rename-preview  { root, file, line, character, newName }
 *
 * Precedence: configured LSP server → built-in semantic engine
 * (TypeScript compiler API) → codeindex heuristic. Every response
 * carries `source` so callers can badge it; the heuristic tier is
 * reached only when both precise tiers fail (TS_UNAVAILABLE,
 * LSP_UNAVAILABLE, TOO_MANY_FILES) and is always labeled with a
 * warning — never a silent downgrade.
 *
 * Path jail: `root` goes through the codeindex allowlist
 * (FACTORY_CODEINDEX_ROOTS, fail-closed) and `file` must stay inside
 * the resolved root. RBAC: default gate (GET viewer, POST operator);
 * no auth.ts change. Rename-preview never writes — it only returns
 * edits for the caller to apply.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  LangSrvError,
  LangSrvService,
  identifierAtPosition,
} from '@ai-factory/langsrv';
import { getCodeIndexService } from './codeindex';
import { isIgnoredSync } from '../ignore-gate';
import type { RouteContext } from './context';

const PREFIX = '/api/langsrv';

let service: LangSrvService | null = null;

export function getLangSrvService(): LangSrvService {
  if (!service) {
    service = new LangSrvService({
      fileFilter: (root, abs, isDir) => isIgnoredSync(root, abs, true, isDir),
    });
  }
  return service;
}

/** For tests: replace the singleton. */
export function setLangSrvService(svc: LangSrvService | null): void {
  service = svc;
}

const FALLBACK_CODES = new Set(['TS_UNAVAILABLE', 'LSP_UNAVAILABLE', 'TOO_MANY_FILES']);

function isLangSrvError(err: unknown): err is LangSrvError {
  return err instanceof LangSrvError;
}

function errStatus(err: LangSrvError): number {
  switch (err.code) {
    case 'ROOT_NOT_FOUND':
    case 'FILE_OUTSIDE_ROOT':
      return 403;
    case 'UNSUPPORTED_EXT':
    case 'POSITION_OUT_OF_RANGE':
    case 'INVALID_IDENTIFIER':
      return 400;
    case 'TOO_MANY_FILES':
      return 409;
    default:
      return 500;
  }
}

interface PosBody {
  root: string;
  file: string;
  line: number;
  character: number;
}

function readPosBody(body: Record<string, unknown>): PosBody | string {
  const root = body['root'];
  const file = body['file'];
  const line = body['line'];
  const character = body['character'];
  if (typeof root !== 'string' || !root.trim()) return 'root is required';
  if (typeof file !== 'string' || !file.trim()) return 'file is required';
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) return 'line must be a non-negative integer';
  if (typeof character !== 'number' || !Number.isInteger(character) || character < 0) return 'character must be a non-negative integer';
  return { root: root.trim(), file: file.trim(), line, character };
}

/** Heuristic tier: identifier-at-position + codeindex name lookup. */
async function heuristicDefinition(
  realRoot: string,
  rel: string,
  line: number,
  character: number,
): Promise<{ name: string; hits: Array<{ file: string; line: number }> } | null> {
  const abs = path.resolve(realRoot, rel);
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const name = identifierAtPosition(text, line, character);
  if (!name) return null;
  const svc = getCodeIndexService();
  try {
    const hits = await svc.getDefinition(realRoot, name);
    return {
      name,
      hits: hits.map((h) => ({ file: h.file, line: h.line })),
    };
  } catch {
    return { name, hits: [] };
  }
}

export async function handleLangSrvRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const svc = getLangSrvService();

  if (method === 'GET' && path === `${PREFIX}/status`) {
    ctx.json(res, 200, { status: svc.status() });
    return true;
  }

  const knownPosts = ['/definition', '/references', '/hover', '/outline', '/rename-preview'];
  if (method === 'POST' && knownPosts.some((p) => path === `${PREFIX}${p}`)) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const kind = path.slice(PREFIX.length + 1);
    try {
      if (kind === 'outline') {
        const root = body['root'];
        const file = body['file'];
        if (typeof root !== 'string' || !root.trim() || typeof file !== 'string' || !file.trim()) {
          ctx.json(res, 400, { error: 'root and file are required' });
          return true;
        }
        const realRoot = await getCodeIndexService().resolveRoot(root.trim());
        const out = await svc.outline(realRoot, file.trim());
        ctx.json(res, 200, out);
        return true;
      }
      if (kind === 'rename-preview') {
        const pos = readPosBody(body);
        if (typeof pos === 'string') {
          ctx.json(res, 400, { error: pos });
          return true;
        }
        const newName = body['newName'];
        if (typeof newName !== 'string' || !newName.trim()) {
          ctx.json(res, 400, { error: 'newName is required' });
          return true;
        }
        const realRoot = await getCodeIndexService().resolveRoot(pos.root);
        const out = await svc.renamePreview(realRoot, pos.file, pos.line, pos.character, newName.trim());
        ctx.json(res, 200, { source: 'semantic', ...out });
        return true;
      }
      const pos = readPosBody(body);
      if (typeof pos === 'string') {
        ctx.json(res, 400, { error: pos });
        return true;
      }
      const realRoot = await getCodeIndexService().resolveRoot(pos.root);
      if (kind === 'definition') {
        try {
          const out = await svc.definition(realRoot, pos.file, pos.line, pos.character);
          ctx.json(res, 200, out);
        } catch (err) {
          if (isLangSrvError(err) && FALLBACK_CODES.has(err.code)) {
            const fb = await heuristicDefinition(realRoot, pos.file, pos.line, pos.character);
            ctx.json(res, 200, {
              source: 'heuristic',
              locations: (fb?.hits ?? []).map((h) => ({
                file: h.file,
                line: h.line,
                character: 0,
                endLine: h.line,
                endCharacter: 0,
              })),
              warning: `precise tiers unavailable (${err.code}); heuristic name lookup for '${fb?.name ?? '?'}' — verify in source`,
            });
          } else throw err;
        }
        return true;
      }
      if (kind === 'references') {
        const out = await svc.references(realRoot, pos.file, pos.line, pos.character);
        ctx.json(res, 200, out);
        return true;
      }
      if (kind === 'hover') {
        const out = await svc.hover(realRoot, pos.file, pos.line, pos.character);
        ctx.json(res, 200, out);
        return true;
      }
    } catch (err) {
      if (isLangSrvError(err)) {
        ctx.json(res, errStatus(err), { error: err.code, detail: err.message });
        return true;
      }
      if (err instanceof Error && (err.message.includes('outside the allowed') || err.message.includes('does not exist') || err.message.includes('not a directory'))) {
        ctx.json(res, 403, { error: 'ROOT_DENIED', detail: err.message });
        return true;
      }
      ctx.json(res, 500, { error: 'langsrv failed', detail: err instanceof Error ? err.message : String(err) });
      return true;
    }
    return true;
  }

  return false;
}

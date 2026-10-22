/**
 * Snippet library — per-project user store (round-5 task R5-A6).
 *
 * Endpoints:
 *   GET    /api/snippets?root=<project>  — read <root>/.ai-factory/snippets.json
 *   PUT    /api/snippets?root=<project>  — replace it (fail-closed validation)
 *   GET    /api/snippets/schema           — JSON schema for snippets.json
 *
 * User snippets live per project under `.ai-factory/snippets.json`; builtin
 * defaults and plugin-contributed sets are merged on the desktop only and are
 * never written by the server. A missing file is an empty list (fail-open
 * read, fail-closed write). Expansion is editor-side pure text substitution
 * and never executes code.
 *
 * Dual-mode import rule (AGENTS.md): this module is imported straight from
 * src by unit tests under node's type-stripping loader, so it value-imports
 * ONLY node builtins and @ai-factory/snippets. The scan root crosses via
 * the setter injection below (wired by the coordinator in index.ts, same
 * pattern as routes/merge3.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { RouteContext } from './context';
import { validateSnippets } from '@ai-factory/snippets';

const PREFIX = '/api/snippets';
const FILE_NAME = 'snippets.json';
const MAX_FILE_BYTES = 1_048_576;

/** Inspection root resolver: (requestedRoot?) => absolute dir. Injected by index.ts. */
let inspectionRootResolver: ((root?: string) => string) | null = null;
export function setSnippetInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  inspectionRootResolver = fn;
}

class SnippetRouteError extends Error {}

function rootOf(url: URL): string {
  if (!inspectionRootResolver) throw new SnippetRouteError('snippet root resolver is not wired');
  const raw = url.searchParams.get('root') ?? '';
  try {
    return inspectionRootResolver(raw.trim() ? raw : undefined);
  } catch (e) {
    throw new SnippetRouteError((e as Error).message);
  }
}

/** Confine the .ai-factory/snippets.json path to the resolved root. */
function snippetsFile(root: string): string {
  const abs = resolve(root, '.ai-factory', FILE_NAME);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new SnippetRouteError(`snippets path escapes the scan root`);
  }
  return abs;
}

/** Static JSON schema describing .ai-factory/snippets.json (documentation-grade). */
export const SNIPPETS_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'AI Factory snippets.json (per-project user snippets)',
  description:
    'User-defined snippets stored per project at .ai-factory/snippets.json. ' +
    'Each snippet has an id, a trigger word, a description, a scope (language ' +
    'ids, "*" matches everything), and a template body. The body grammar is: ' +
    '$1/$2 tab stops, ${1:default} placeholders, $0 final cursor, ' +
    '${DATE}/${TIME}/${FILENAME} variables, \\$ for a literal dollar. ' +
    'Nested placeholders are not supported. Expanding a snippet is pure text ' +
    'substitution inside the editor; it never executes code. Builtin defaults ' +
    'and plugin-contributed snippets are merged on the desktop and are never ' +
    'written to this file.',
  type: 'object',
  required: ['snippets'],
  additionalProperties: false,
  properties: {
    snippets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'trigger', 'scope', 'body'],
        additionalProperties: true,
        properties: {
          id: {
            type: 'string',
            description: 'Unique id, [a-z0-9][a-z0-9_:.-]{0,63}.',
          },
          trigger: { type: 'string', description: 'Trigger word typed before Tab.' },
          description: { type: 'string', description: 'Shown in the completion list.' },
          scope: {
            type: 'array',
            items: { type: 'string' },
            description: 'Language ids this snippet applies to; "*" matches all.',
          },
          body: { type: 'string', description: 'Template body (see top-level description).' },
        },
      },
    },
  },
} as const;

function readUserSnippets(file: string): unknown[] {
  try {
    const raw = readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) {
      throw new SnippetRouteError('snippets file exceeds 1MB');
    }
    const parsed: unknown = JSON.parse(raw);
    const list = (parsed as { snippets?: unknown })['snippets'];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    if (e instanceof SnippetRouteError) throw e;
    // Missing or corrupt file: empty list (fail-open read).
    return [];
  }
}

async function handleGet(res: ServerResponse, ctx: RouteContext, url: URL, schemaOnly: boolean): Promise<boolean> {
  if (schemaOnly) {
    ctx.json(res, 200, SNIPPETS_SCHEMA);
    return true;
  }
  let root: string;
  try {
    root = rootOf(url);
  } catch (e) {
    ctx.json(res, 403, { error: (e as Error).message, code: 'snippets-root-forbidden' });
    return true;
  }
  let file: string;
  try {
    file = snippetsFile(root);
  } catch (e) {
    ctx.json(res, 403, { error: (e as Error).message, code: 'snippets-escape' });
    return true;
  }
  let snippets: unknown[];
  try {
    snippets = readUserSnippets(file);
  } catch (e) {
    ctx.json(res, 400, { error: (e as Error).message, code: 'snippets-too-large' });
    return true;
  }
  ctx.json(res, 200, { root, snippets });
  return true;
}

async function handlePut(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  let root: string;
  try {
    root = rootOf(url);
  } catch (e) {
    ctx.json(res, 403, { error: (e as Error).message, code: 'snippets-root-forbidden' });
    return true;
  }
  let file: string;
  try {
    file = snippetsFile(root);
  } catch (e) {
    ctx.json(res, 403, { error: (e as Error).message, code: 'snippets-escape' });
    return true;
  }
  const body = await ctx.readBody(req);
  const entries = (body as { snippets?: unknown })['snippets'];
  const { issues, snippets } = validateSnippets(entries);
  if (issues.length > 0) {
    ctx.json(res, 400, { error: 'snippets validation failed', code: 'snippets-invalid', issues });
    return true;
  }
  const payload = JSON.stringify({ snippets }, null, 2);
  if (Buffer.byteLength(payload, 'utf8') > MAX_FILE_BYTES) {
    ctx.json(res, 400, { error: 'snippets payload exceeds 1MB', code: 'snippets-too-large' });
    return true;
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, payload, 'utf8');
  } catch (e) {
    ctx.json(res, 500, { error: `cannot write snippets file: ${(e as Error).message}`, code: 'snippets-unwritable' });
    return true;
  }
  ctx.audit.record('human', 'SNIPPETS_UPDATED', 'snippets', root, { count: snippets.length });
  ctx.json(res, 200, { ok: true, root, snippets });
  return true;
}

export async function handleSnippetRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  if (!url.pathname.startsWith(PREFIX)) return false;
  const rest = url.pathname.slice(PREFIX.length);
  const method = req.method ?? 'GET';
  if (method === 'GET' && rest === '/schema') return handleGet(res, ctx, url, true);
  if (method === 'GET' && (rest === '' || rest === '/')) return handleGet(res, ctx, url, false);
  if (method === 'PUT' && (rest === '' || rest === '/')) return handlePut(req, res, ctx, url);
  ctx.json(res, 404, { error: 'unknown snippets route', code: 'not-found' });
  return true;
}

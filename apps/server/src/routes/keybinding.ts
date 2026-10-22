/**
 * Global keybinding system — user-layer store (round-5 task R5-S1).
 *
 * Endpoints:
 *   GET    /api/keybindings         — the user-layer keybindings.json (array)
 *   PUT    /api/keybindings         — replace it (fail-closed validation)
 *   DELETE /api/keybindings         — reset to defaults (delete the file)
 *   GET    /api/keybindings/schema  — JSON schema for keybindings.json
 *
 * Honest boundary, stated in the schema doc too: the server has NO keyboard
 * context. It only stores and fail-closed-validates the user layer; merging
 * with defaults, conflict detection, dispatch, and the which-key popup all
 * happen in the desktop, which owns the keyboard. Persistence is the user
 * data directory (AI_FACTORY_DATA_DIR/keybindings.json), not per-project.
 *
 * Dual-mode import rule (AGENTS.md): this module is imported straight from
 * src by unit tests under node's type-stripping loader, so it value-imports
 * ONLY node builtins and @ai-factory/keybinding. The data-dir root crosses
 * via the setter injection below (wired by the coordinator in index.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RouteContext } from './context';
import { validateUserKeybindings } from '@ai-factory/keybinding';

const PREFIX = '/api/keybindings';
const FILE_NAME = 'keybindings.json';
const MAX_FILE_BYTES = 256_000;

/** Data-dir root: ( ) => absolute dir. Injected by index.ts. */
let rootResolver: (() => string) | null = null;
export function setKeybindingRootResolver(fn: (() => string) | null): void {
  rootResolver = fn;
}

function dataFile(): string {
  if (!rootResolver) throw new Error('keybinding data-dir resolver is not wired');
  return join(rootResolver(), FILE_NAME);
}

function readUserLayer(): unknown[] {
  try {
    const raw = readFileSync(dataFile(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Missing or corrupt file: treat as empty (fail-open read, fail-closed
    // write — a corrupt file is replaced on the next PUT, never trusted).
    return [];
  }
}

/** Static JSON schema describing keybindings.json (documentation-grade). */
export const KEYBINDINGS_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'AI Factory keybindings.json (user layer)',
  description:
    'User keybindings override the built-in defaults. The server only stores ' +
    'and validates this file; it has no keyboard context. Key strings use the ' +
    "grammar '<chord>( <chord>)*' with chord '<mod>(+<mod>)*+<key>'; 'mod' is " +
    'the platform primary modifier (Cmd on macOS, Ctrl elsewhere). ' +
    'Multi-chord sequences (e.g. "ctrl+k ctrl+c") show a which-key popup in ' +
    'the desktop when the first chord is pressed.',
  type: 'array',
  items: {
    type: 'object',
    required: ['command', 'key'],
    additionalProperties: false,
    properties: {
      command: {
        type: 'string',
        description: 'Command id (e.g. "palette.toggle"). A leading "-" or key:null unbinds the command.',
      },
      key: {
        type: ['string', 'null'],
        description: 'Keybinding string, or null to remove all bindings of the command.',
      },
      when: { type: 'string', description: 'Optional context expression (reserved, currently informational).' },
    },
  },
} as const;

async function handleGet(res: ServerResponse, ctx: RouteContext, schemaOnly: boolean): Promise<boolean> {
  if (schemaOnly) {
    ctx.json(res, 200, KEYBINDINGS_SCHEMA);
    return true;
  }
  ctx.json(res, 200, { keybindings: readUserLayer() });
  return true;
}

async function handlePut(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const body = await ctx.readBody(req);
  const entries = (body as { keybindings?: unknown })['keybindings'];
  const issues = validateUserKeybindings(entries);
  if (issues.length > 0) {
    ctx.json(res, 400, { error: 'keybindings validation failed', code: 'keybindings-invalid', issues });
    return true;
  }
  const payload = JSON.stringify(entries, null, 2);
  if (payload.length > MAX_FILE_BYTES) {
    ctx.json(res, 400, { error: 'keybindings file too large (256KB cap)', code: 'too-large' });
    return true;
  }
  try {
    const file = dataFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, payload, 'utf8');
  } catch (e) {
    ctx.json(res, 500, { error: `cannot write keybindings file: ${(e as Error).message}`, code: 'keybindings-unwritable' });
    return true;
  }
  ctx.audit.record('human', 'KEYBINDINGS_UPDATED', 'keybindings', 'user', {
    entryCount: (entries as unknown[]).length,
  });
  ctx.json(res, 200, { ok: true, keybindings: entries });
  return true;
}

async function handleDelete(res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    unlinkSync(dataFile());
  } catch {
    // Missing file: reset is a no-op, still a success.
  }
  ctx.audit.record('human', 'KEYBINDINGS_RESET', 'keybindings', 'user', {});
  ctx.json(res, 200, { ok: true, keybindings: [] });
  return true;
}

export async function handleKeybindingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  if (!url.pathname.startsWith(PREFIX)) return false;
  const rest = url.pathname.slice(PREFIX.length);
  if (req.method === 'GET' && (rest === '' || rest === '/')) return handleGet(res, ctx, false);
  if (req.method === 'GET' && rest === '/schema') return handleGet(res, ctx, true);
  if (req.method === 'PUT' && (rest === '' || rest === '/')) return handlePut(req, res, ctx);
  if (req.method === 'DELETE' && (rest === '' || rest === '/')) return handleDelete(res, ctx);
  ctx.json(res, 404, { error: 'unknown keybindings route', code: 'not-found' });
  return true;
}

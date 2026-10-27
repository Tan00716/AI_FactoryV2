/**
 * .env visual management routes (round-6 task R6-A8) — key/value table,
 * masked display, missing-key checks, and an explicit "load into task
 * environment" action.
 *
 *   GET  /api/env?root=&file=.env        list (values masked) + warnings
 *   GET  /api/env/reveal?root=&file=&key= one value, plaintext (audited)
 *   POST /api/env/entries                { root?, file?, set: [{key, value}], delete: [key] }
 *   POST /api/env/validate               { root?, file?, required: [key] }
 *   POST /api/env/load                   { root?, file?, label } — run a tasks.json chain with the .env overlaid
 *
 * Safety contract (the brief's red lines, enforced here, not in the UI):
 *  - List responses NEVER carry plaintext values: every value is passed
 *    through maskSecret. Plaintext leaves the server only via /reveal,
 *    which requires the operator role (see auth.ts) and writes an
 *    ENV_VALUE_REVEALED audit record naming the key, never the value.
 *  - Write and load audit records name keys only, never values.
 *  - Secret scanning reuses the canonical SECRET_PATTERNS table from
 *    @ai-factory/security — the same table the R4-S1 pre-send prompt
 *    gate uses — so editor warnings cannot drift from gate verdicts.
 *    A warning is ADVISORY, not a block: a .env file is the legitimate
 *    home of a secret, and blocking the save would make the editor
 *    unusable for its core purpose.
 *  - No vault: values are stored plaintext in the project .env file,
 *    exactly as the file format dictates. The UI footer says so.
 *  - No auto-sync: nothing in this module touches a running process's
 *    environment. /load runs ONE named chain with the .env merged
 *    in-memory (routes/tasks.ts runTaskChainWithEnv); the overlay is
 *    never persisted to tasks.json or any other file, and a task's own
 *    options.env wins over the overlay.
 *  - The file name is allow-listed to `.env` plus one dot-suffix
 *    (`.env.local`, `.env.prod`); anything else — including any path
 *    separator — is a 400, so the jail resolver is never asked to
 *    adjudicate a crafted path.
 *
 * Roundtrip: writes go through @ai-factory/dotenv applyEnvOps, which
 * rewrites only set/deleted lines; comments, blank lines, untouched
 * entries and invalid lines survive byte-for-byte.
 *
 * Dual-mode: this module is imported straight from src by its tests, so
 * it must not value-import src-relative extensionless modules. The jail
 * resolver and the chain runner are setter-injected from index.ts;
 * @ai-factory/dotenv and @ai-factory/security are real package deps.
 *
 * RBAC: default prefix rule gives GET → viewer, writes → operator;
 * /reveal is pinned to operator in auth.ts because it serves plaintext.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyEnvOps,
  isValidEnvKey,
  missingKeys,
  parseDotEnv,
  type DotEnvParseResult,
} from '@ai-factory/dotenv';
import { isPlaceholderValue, maskSecret, SECRET_PATTERNS } from '@ai-factory/security';
import type { RouteContext } from './context';
import type { ChainRunOutcome } from './tasks';

const PREFIX = '/api/env';
const MAX_FILE_BYTES = 512_000;
const FILE_RE = /^\.env(\.[A-Za-z0-9_-]+)?$/;

class EnvRouteError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'EnvRouteError';
    this.code = code;
    this.status = status;
  }
}

export interface EnvDeps {
  /** Jail a requested project root (throws on escape). */
  resolveRoot: (root?: string) => string;
  /** Run a tasks.json chain with an in-memory env overlay. */
  runChain: (
    label: string,
    root: string,
    projectId: string,
    actor: string,
    ctx: RouteContext,
    env: Record<string, string>,
  ) => Promise<ChainRunOutcome>;
}

let deps: EnvDeps | null = null;

/** Installed once by index.ts at boot. */
export function setEnvDeps(d: EnvDeps | null): void {
  deps = d;
}

function needDeps(): EnvDeps {
  if (!deps) throw new EnvRouteError('env service is not wired', 'not-wired', 500);
  return deps;
}

function resolveRoot(rawRoot?: string): string {
  const d = needDeps();
  try {
    return d.resolveRoot(rawRoot);
  } catch (e) {
    throw new EnvRouteError((e as Error).message, 'bad-root', 403);
  }
}

function validateFile(raw: unknown): string {
  const file = typeof raw === 'string' && raw !== '' ? raw : '.env';
  if (!FILE_RE.test(file)) {
    throw new EnvRouteError(`invalid env file name: ${file}`, 'bad-file', 400);
  }
  return file;
}

function projectIdOf(root: string): string {
  const base = root.split(/[\\/]/).filter(Boolean).pop() ?? 'default';
  return /^[A-Za-z0-9_.-]{1,64}$/.test(base) ? base : 'default';
}

function envFilePath(root: string, file: string): string {
  return join(root, file);
}

function loadDoc(root: string, file: string): { exists: boolean; doc: DotEnvParseResult } {
  const path = envFilePath(root, file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { exists: false, doc: parseDotEnv('') };
  }
  if (text.length > MAX_FILE_BYTES) {
    throw new EnvRouteError(`env file exceeds ${MAX_FILE_BYTES} bytes`, 'file-too-big', 400);
  }
  return { exists: true, doc: parseDotEnv(text) };
}

/** Secret-pattern hits for one entry, using the canonical table. */
export function scanEnvValue(key: string, value: string): string[] {
  if (isPlaceholderValue(value)) return [];
  const haystacks = [`${key}=${value}`, value];
  const hits: string[] = [];
  for (const p of SECRET_PATTERNS) {
    // Fresh regex state per test: patterns are module-level literals.
    if (haystacks.some((h) => new RegExp(p.re.source, p.re.flags).test(h))) {
      hits.push(p.name);
    }
  }
  return hits;
}

export interface EnvWarning {
  kind: 'secret-like' | 'duplicate' | 'parse-error';
  key?: string;
  line?: number;
  message: string;
  patterns?: string[];
}

export function buildWarnings(doc: DotEnvParseResult): EnvWarning[] {
  const warnings: EnvWarning[] = [];
  for (const e of doc.entries) {
    const patterns = scanEnvValue(e.key, e.value);
    if (patterns.length > 0) {
      warnings.push({
        kind: 'secret-like',
        key: e.key,
        message: `value looks like a secret (${patterns.join(', ')})`,
        patterns,
      });
    }
    if (e.occurrences > 1) {
      warnings.push({
        kind: 'duplicate',
        key: e.key,
        message: `key defined ${e.occurrences} times; last value wins`,
      });
    }
  }
  for (const err of doc.errors) {
    warnings.push({ kind: 'parse-error', line: err.line, message: err.message });
  }
  return warnings;
}

export interface MaskedEntry {
  key: string;
  masked: string;
  occurrences: number;
  secret: boolean;
  patterns: string[];
}

export function maskedEntries(doc: DotEnvParseResult): MaskedEntry[] {
  return doc.entries.map((e) => {
    const patterns = scanEnvValue(e.key, e.value);
    return {
      key: e.key,
      masked: maskSecret(e.value),
      occurrences: e.occurrences,
      secret: patterns.length > 0,
      patterns,
    };
  });
}

/** Whether the file is covered by the project .gitignore (hint only). */
export function gitignoreHint(root: string, file: string): { ignored: boolean; hasGitignore: boolean } {
  const path = join(root, '.gitignore');
  if (!existsSync(path)) return { ignored: false, hasGitignore: false };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ignored: false, hasGitignore: true };
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line === file || line === '.env*' || (file !== '.env' && line === '.env.*')) {
      return { ignored: true, hasGitignore: true };
    }
  }
  return { ignored: false, hasGitignore: true };
}

function saveDoc(root: string, file: string, text: string): void {
  const path = envFilePath(root, file);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

function listPayload(root: string, file: string): Record<string, unknown> {
  const { exists, doc } = loadDoc(root, file);
  return {
    file,
    exists,
    entries: maskedEntries(doc),
    warnings: buildWarnings(doc),
    gitignore: gitignoreHint(root, file),
  };
}

export async function handleEnvRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith(PREFIX)) return false;
  const rest = path.slice(PREFIX.length);

  try {
    // ---- list --------------------------------------------------------
    if (rest === '' && method === 'GET') {
      const root = resolveRoot(url.searchParams.get('root') ?? undefined);
      const file = validateFile(url.searchParams.get('file') ?? undefined);
      ctx.json(res, 200, listPayload(root, file));
      return true;
    }

    // ---- reveal ------------------------------------------------------
    if (rest === '/reveal' && method === 'GET') {
      const root = resolveRoot(url.searchParams.get('root') ?? undefined);
      const file = validateFile(url.searchParams.get('file') ?? undefined);
      const key = url.searchParams.get('key') ?? '';
      if (!isValidEnvKey(key)) {
        ctx.json(res, 400, { error: `invalid key: ${key}`, code: 'invalid-key' });
        return true;
      }
      const { exists, doc } = loadDoc(root, file);
      const entry = doc.entries.find((e) => e.key === key);
      if (!exists || !entry) {
        ctx.json(res, 404, { error: `key not found: ${key}`, code: 'not-found' });
        return true;
      }
      ctx.audit.record('human', 'ENV_VALUE_REVEALED', 'env-file', file, { key });
      ctx.json(res, 200, { key, value: entry.value });
      return true;
    }

    // ---- entries (set/delete) ----------------------------------------
    if (rest === '/entries' && method === 'POST') {
      const body = await ctx.readBody(req);
      const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      const file = validateFile(body['file']);
      const setRaw = Array.isArray(body['set']) ? body['set'] : [];
      const delRaw = Array.isArray(body['delete']) ? body['delete'] : [];
      const ops: Array<{ type: 'set'; key: string; value: string } | { type: 'delete'; key: string }> = [];
      const touched: string[] = [];
      for (const s of setRaw) {
        const rec = s as Record<string, unknown>;
        if (typeof rec['key'] !== 'string' || !isValidEnvKey(rec['key'])) {
          ctx.json(res, 400, { error: `invalid key: ${String(rec['key'])}`, code: 'invalid-key' });
          return true;
        }
        if (typeof rec['value'] !== 'string') {
          ctx.json(res, 400, { error: `value must be a string for key: ${rec['key']}`, code: 'invalid-value' });
          return true;
        }
        ops.push({ type: 'set', key: rec['key'], value: rec['value'] });
        touched.push(rec['key']);
      }
      for (const k of delRaw) {
        if (typeof k !== 'string' || !isValidEnvKey(k)) {
          ctx.json(res, 400, { error: `invalid key: ${String(k)}`, code: 'invalid-key' });
          return true;
        }
        ops.push({ type: 'delete', key: k });
        touched.push(k);
      }
      const { exists } = loadDoc(root, file);
      const current = exists ? readFileSync(envFilePath(root, file), 'utf8') : '';
      const next = applyEnvOps(current, ops);
      saveDoc(root, file, next);
      ctx.audit.record('human', 'ENV_UPDATED', 'env-file', file, { keys: touched });
      ctx.json(res, 200, listPayload(root, file));
      return true;
    }

    // ---- validate (missing keys) --------------------------------------
    if (rest === '/validate' && method === 'POST') {
      const body = await ctx.readBody(req);
      const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      const file = validateFile(body['file']);
      const required = Array.isArray(body['required'])
        ? (body['required'] as unknown[]).filter((k): k is string => typeof k === 'string')
        : [];
      const bad = required.filter((k) => !isValidEnvKey(k));
      if (bad.length > 0) {
        ctx.json(res, 400, { error: `invalid required key: ${bad[0]}`, code: 'invalid-key' });
        return true;
      }
      const { exists, doc } = loadDoc(root, file);
      ctx.json(res, 200, {
        file,
        exists,
        missing: missingKeys(doc.entries, required),
        warnings: buildWarnings(doc),
      });
      return true;
    }

    // ---- load into task environment -----------------------------------
    if (rest === '/load' && method === 'POST') {
      const body = await ctx.readBody(req);
      const root = resolveRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      const file = validateFile(body['file']);
      const label = typeof body['label'] === 'string' ? body['label'] : '';
      if (label === '') {
        ctx.json(res, 400, { error: 'label is required', code: 'invalid-label' });
        return true;
      }
      const { exists, doc } = loadDoc(root, file);
      if (!exists) {
        ctx.json(res, 404, { error: `env file not found: ${file}`, code: 'not-found' });
        return true;
      }
      const env: Record<string, string> = {};
      for (const e of doc.entries) env[e.key] = e.value;
      const keys = Object.keys(env);
      ctx.audit.record('human', 'ENV_LOADED_TO_TASK', 'env-file', file, { label, keys });
      const outcome = await needDeps().runChain(label, root, projectIdOf(root), 'human', ctx, env);
      if (!outcome.ok) {
        ctx.json(res, outcome.status, { error: outcome.error, code: outcome.code, errors: outcome.errors });
        return true;
      }
      ctx.json(res, 200, { ok: true, chain: outcome.chain });
      return true;
    }
  } catch (e) {
    if (e instanceof EnvRouteError) {
      ctx.json(res, e.status, { error: e.message, code: e.code });
      return true;
    }
    throw e;
  }
  return false;
}

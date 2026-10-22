/**
 * HTTP/REST debug client routes (round-4 task A6) — JetBrains HTTP Client style.
 *
 *   POST /api/http/run            { text, environment?, environments?, variables?,
 *                                   timeoutMs?, projectId? } — parse + send + assert
 *   GET  /api/http/environments?root=        read .ai-factory/http-env.json
 *   PUT  /api/http/environments   { root?, environments } — validate + write
 *
 * Outbound gating: every request URL goes through the injected egress gate
 * BEFORE anything is dialed (setter-injected from index.ts, which wires the
 * real egress firewall: `assertEgressAllowed(url, { source: 'http-client' })`).
 * A refused URL is reported per-request as `{ blocked: true }` — the rest of
 * the file still runs. The gate itself emits the EGRESS_BLOCKED audit +
 * HIGH notification (see apps/server/src/egress.ts); this route additionally
 * audits each sent/blocked request (redacted: method/host/path/status only).
 *
 * Env files live at `<project-root>/.ai-factory/http-env.json` and are jailed
 * by the injected inspection-root resolver (same jail as quality-gate scans).
 *
 * RBAC: the default prefix rule in auth.ts gives GET → viewer and every
 * other method → operator for this prefix — no auth.ts change needed.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleHttpClientRoutes, setHttpClientEgressGate, setHttpClientRootResolver } from './routes/httpclient';
 *   setHttpClientEgressGate((url) => assertEgressAllowed(url, { source: 'http-client' }));
 *   setHttpClientRootResolver((root) => resolveInspectionRoot(root));
 *   if (await handleHttpClientRoutes(req, res, url, routeCtx)) return;
 *
 * Dual-mode note (AGENTS.md): this module must not value-import
 * src-relative extensionless modules (type-stripping tests import this
 * route straight from src). `@ai-factory/httpclient` resolves through the
 * workspace symlink to compiled dist — safe. The EGRESS_BLOCKED code is
 * mirrored as a local literal (must stay in sync with egress.ts).
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - Redirects are NOT followed; a 3xx is reported as-is.
 *  - Response bodies are capped at 5MB (package constant BODY_CAP_BYTES);
 *    `bytes` reports the true received size.
 *  - Assertions are deterministic: status/header/body-contains/json-path
 *    (dot path, no wildcards)/max-time-ms.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  HttpClientError,
  parseHttpFile,
  mergeVariables,
  substituteVars,
  sendHttpRequest,
  validateEnvironments,
  type HttpEnvironment,
  type HttpRequestSpec,
  type HttpRunResult,
} from '@ai-factory/httpclient';
import type { RouteContext } from './context';

const PREFIX = '/api/http';
const ENV_FILE = '.ai-factory/http-env.json';
/** Mirrors EGRESS_BLOCKED_CODE in ../egress.ts (dual-mode: no src-relative value import). */
const EGRESS_BLOCKED_CODE = 'EGRESS_BLOCKED';
const MAX_HTTP_TEXT = 2_000_000;
const MAX_ENV_FILE_BYTES = 256_000;

class HttpRouteError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'HttpRouteError';
    this.code = code;
  }
}

/** Egress gate: (url) => void, throws when the URL must not be dialed. */
let egressGate: ((url: string) => void) | null = null;
export function setHttpClientEgressGate(fn: ((url: string) => void) | null): void {
  egressGate = fn;
}

/** Inspection-root jail for env files. */
let rootResolver: ((root?: string) => string) | null = null;
export function setHttpClientRootResolver(fn: ((root?: string) => string) | null): void {
  rootResolver = fn;
}

function resolveRoot(rawRoot?: string): string {
  if (!rootResolver) throw new HttpRouteError('inspection root resolver is not wired', 'not-wired');
  try {
    return rootResolver(rawRoot);
  } catch (e) {
    throw new HttpRouteError((e as Error).message, 'bad-root');
  }
}

function projectIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return /^[A-Za-z0-9_\-.]{1,64}$/.test(id) ? id : null;
}

function envFilePath(root: string): string {
  // `root` is already jail-resolved by the injected resolver; ENV_FILE is a
  // fixed relative path, so the join cannot escape it.
  return join(root, '.ai-factory', 'http-env.json');
}

function redactUrl(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: (u.pathname + u.search).slice(0, 256) };
  } catch {
    return { host: '<invalid-url>', path: '' };
  }
}

interface RunBody {
  text?: unknown;
  environment?: unknown;
  environments?: unknown;
  variables?: unknown;
  timeoutMs?: unknown;
  projectId?: unknown;
}

function parseRunBody(body: unknown): RunBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpRouteError('request body must be a JSON object', 'bad-json');
  }
  const b = body as RunBody;
  if (typeof b.text !== 'string' || b.text.length === 0) {
    throw new HttpRouteError('`text` (the .http file content) is required', 'missing-text');
  }
  if (b.text.length > MAX_HTTP_TEXT) throw new HttpRouteError('http text too large (2MB cap)', 'too-large');
  if (b.environment !== undefined && typeof b.environment !== 'string') {
    throw new HttpRouteError('`environment` must be a string', 'bad-input');
  }
  if (b.variables !== undefined && (typeof b.variables !== 'object' || b.variables === null || Array.isArray(b.variables))) {
    throw new HttpRouteError('`variables` must be an object', 'bad-input');
  }
  if (b.timeoutMs !== undefined && (typeof b.timeoutMs !== 'number' || b.timeoutMs <= 0 || b.timeoutMs > 120_000)) {
    throw new HttpRouteError('`timeoutMs` must be a positive number ≤ 120000', 'bad-input');
  }
  if (b.projectId !== undefined && projectIdOf(b.projectId) === null) {
    throw new HttpRouteError('bad `projectId`', 'bad-input');
  }
  return b;
}

async function handleRun(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const raw = await ctx.readBody(req);
  let b: RunBody;
  try {
    b = parseRunBody(raw);
  } catch (e) {
    const err = e as HttpRouteError;
    ctx.json(res, 400, { error: err.message, code: err.code });
    return true;
  }
  if (!egressGate) {
    ctx.json(res, 500, { error: 'egress gate is not wired', code: 'not-wired' });
    return true;
  }

  let specs: HttpRequestSpec[];
  try {
    specs = parseHttpFile(b.text as string);
  } catch (e) {
    const err = e as HttpClientError;
    ctx.json(res, 400, { error: err.message, code: err.code });
    return true;
  }

  let environments: Record<string, HttpEnvironment>;
  try {
    environments = validateEnvironments(b.environments);
  } catch (e) {
    const err = e as HttpClientError;
    ctx.json(res, 400, { error: err.message, code: err.code });
    return true;
  }

  const projectId = projectIdOf(b.projectId) ?? 'local';
  const environment = typeof b.environment === 'string' ? b.environment : undefined;
  const variables = (b.variables ?? {}) as Record<string, string>;
  const defaultTimeoutMs = typeof b.timeoutMs === 'number' ? b.timeoutMs : undefined;

  // Merge early so an unknown environment fails the whole batch fail-closed.
  try {
    mergeVariables({ environments, environment, variables });
  } catch (e) {
    const err = e as HttpClientError;
    ctx.json(res, 400, { error: err.message, code: err.code });
    return true;
  }

  const results: HttpRunResult[] = [];
  for (const spec of specs) {
    const vars = mergeVariables({ environments, environment, variables });
    const url = substituteVars(spec.url, vars);
    const redacted = redactUrl(url);
    const auditBase = {
      method: spec.method,
      host: redacted.host,
      path: redacted.path,
      environment: environment ?? null,
    };

    // Egress gate BEFORE anything is dialed.
    try {
      egressGate(url);
    } catch (e) {
      const err = e as Error & { code?: string };
      const blockedReason = err.message;
      ctx.audit.record('human', 'HTTP_CLIENT_RUN', 'http-client', `${projectId}:${spec.id}`, {
        ...auditBase,
        blocked: true,
        blockedCode: err.code ?? 'unknown',
      });
      results.push({
        id: spec.id,
        name: spec.name,
        method: spec.method,
        url,
        blocked: true,
        blockedReason,
        assertions: [],
        ok: false,
      });
      continue;
    }

    const result = await sendHttpRequest(spec, { environments, environment, variables, defaultTimeoutMs });
    ctx.audit.record('human', 'HTTP_CLIENT_RUN', 'http-client', `${projectId}:${spec.id}`, {
      ...auditBase,
      blocked: false,
      status: result.status ?? null,
      durationMs: result.durationMs ?? null,
      assertionsPassed: result.assertions.filter((a) => a.passed).length,
      assertionsTotal: result.assertions.length,
      ok: result.ok,
      error: result.error ?? null,
    });
    results.push(result);
  }

  ctx.json(res, 200, { environment: environment ?? null, results });
  return true;
}

async function handleGetEnvironments(url: URL, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  let root: string;
  try {
    root = resolveRoot(url.searchParams.get('root') ?? undefined);
  } catch (e) {
    const err = e as HttpRouteError;
    ctx.json(res, 403, { error: err.message, code: err.code });
    return true;
  }
  let environments: Record<string, HttpEnvironment> = {};
  try {
    const raw = readFileSync(envFilePath(root), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const obj = (parsed as { environments?: unknown }).environments ?? parsed;
    environments = validateEnvironments(obj);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      ctx.json(res, 400, { error: `env file unreadable: ${(e as Error).message}`, code: 'env-unreadable' });
      return true;
    }
  }
  ctx.json(res, 200, { root, environments });
  return true;
}

async function handlePutEnvironments(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const body = await ctx.readBody(req);
  const b = body as { root?: unknown; environments?: unknown; projectId?: unknown };
  let root: string;
  try {
    root = resolveRoot(typeof b.root === 'string' ? b.root : undefined);
  } catch (e) {
    const err = e as HttpRouteError;
    ctx.json(res, 403, { error: err.message, code: err.code });
    return true;
  }
  let environments: Record<string, HttpEnvironment>;
  try {
    environments = validateEnvironments(b.environments);
  } catch (e) {
    const err = e as HttpClientError;
    ctx.json(res, 400, { error: err.message, code: err.code });
    return true;
  }
  const payload = JSON.stringify({ environments }, null, 2);
  if (payload.length > MAX_ENV_FILE_BYTES) {
    ctx.json(res, 400, { error: 'env file too large (256KB cap)', code: 'too-large' });
    return true;
  }
  try {
    mkdirSync(dirname(envFilePath(root)), { recursive: true });
    writeFileSync(envFilePath(root), payload, 'utf8');
  } catch (e) {
    ctx.json(res, 500, { error: `cannot write env file: ${(e as Error).message}`, code: 'env-unwritable' });
    return true;
  }
  const projectId = projectIdOf(b.projectId) ?? 'local';
  ctx.audit.record('human', 'HTTP_ENV_UPDATED', 'http-client', projectId, {
    root,
    environmentCount: Object.keys(environments).length,
  });
  ctx.json(res, 200, { ok: true, root, environments });
  return true;
}

export async function handleHttpClientRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  if (!url.pathname.startsWith(PREFIX)) return false;
  const rest = url.pathname.slice(PREFIX.length);
  if (req.method === 'POST' && rest === '/run') return handleRun(req, res, ctx);
  if (req.method === 'GET' && rest === '/environments') return handleGetEnvironments(url, res, ctx);
  if (req.method === 'PUT' && rest === '/environments') return handlePutEnvironments(req, res, ctx);
  ctx.json(res, 404, { error: 'unknown http-client route', code: 'not-found' });
  return true;
}

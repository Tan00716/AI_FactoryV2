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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  HttpClientError,
  applyAuth,
  buildGraphqlBody,
  parseHttpFile,
  mergeVariables,
  redactApiEnvironment,
  sendGraphqlRequest,
  sendHttpRequest,
  stripAuthHeaders,
  substituteVars,
  substituteVarsStrict,
  substituteVarsStrictDeep,
  validateApiEnvironment,
  validateAuthProfile,
  validateCollection,
  validateEnvironments,
  wsConnect,
  MAX_AUTH_PROFILES,
  MAX_COLLECTIONS,
  MAX_ENVIRONMENTS,
  MAX_HISTORY,
  type ApiEnvironment,
  type AuthProfile,
  type HistoryEntry,
  type HttpCollection,
  type HttpMethod,
  type HttpEnvironment,
  type HttpRequestSpec,
  type HttpRunResult,
  type WsClient,
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

/* ================================================================== *
 * Round-7 R7-#9 — API client deepening: collections, API environments
 * with secret names, auth profiles, history rerun, GraphQL, WebSocket.
 *
 * Store (user data dir, never a project tree):
 *   <dataDir>/http-api.json          collections + env metadata +
 *                                    auth profile metadata + history
 *   <dataDir>/http-api-secrets.json  env secret values + auth secrets
 * Both files are written 0600 via tmp+rename. The API NEVER returns a
 * secret value: env list/get substitutes `<redacted>`, auth profile
 * list/get reports only hasSecret/secretSource, history stores the
 * pre-substitution URL template and auth-stripped specs.
 *
 * Auth resolution order at send time: stored secret (secrets file) or,
 * when the profile names a `secretEnv`, the process env var of that
 * name (never persisted). OAuth2 profiles are accepted for
 * bookkeeping but applying one fails closed ('oauth2-placeholder'):
 * no token flow is faked.
 *
 * WebSocket: sessions are in-process (cap 20, 200 messages each) and
 * die with the server. The egress decision for a ws(s) URL is made on
 * its http(s) equivalent — the firewall only understands http schemes
 * (see egress.ts non-http-scheme rejection), and the equivalence is
 * stated in the connect response, not hidden.
 * ================================================================== */

interface HttpApiDeps {
  resolveDataDir: () => string;
}

let apiDeps: HttpApiDeps | null = null;

/** Installed once by index.ts at boot. */
export function setHttpApiDeps(d: HttpApiDeps | null): void {
  apiDeps = d;
}

function apiDataDir(): string {
  if (!apiDeps) throw new HttpRouteError('api data dir is not wired', 'not-wired');
  return apiDeps.resolveDataDir();
}

interface ApiStore {
  collections: HttpCollection[];
  environments: ApiEnvironment[];
  authProfiles: AuthProfile[];
  history: HistoryEntry[];
}

interface ApiSecrets {
  envSecrets: Record<string, string>;
  authSecrets: Record<string, string>;
}

function emptyStore(): ApiStore {
  return { collections: [], environments: [], authProfiles: [], history: [] };
}

function emptySecrets(): ApiSecrets {
  return { envSecrets: {}, authSecrets: {} };
}

function loadStore(): ApiStore {
  const path = join(apiDataDir(), 'http-api.json');
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('store shape');
    const p = parsed as Partial<ApiStore>;
    const store = emptyStore();
    if (Array.isArray(p.collections)) store.collections = p.collections.map((c) => validateCollection(c));
    if (Array.isArray(p.environments)) store.environments = p.environments.map((e) => validateApiEnvironment(e));
    if (Array.isArray(p.authProfiles)) {
      store.authProfiles = p.authProfiles.map((a) => {
        const v = validateAuthProfile(a);
        const raw2 = a as { secretSource?: unknown; hasSecret?: unknown };
        const secretSource = raw2.secretSource === 'stored' || raw2.secretSource === 'env' ? raw2.secretSource : null;
        return { ...v, secretSource, hasSecret: raw2.hasSecret === true };
      });
    }
    if (Array.isArray(p.history)) store.history = p.history.slice(0, MAX_HISTORY);
    return store;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw new HttpRouteError(`api store unreadable: ${(e as Error).message}`, 'store-unreadable');
  }
}

function loadSecrets(): ApiSecrets {
  const path = join(apiDataDir(), 'http-api-secrets.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('secrets shape');
    const p = parsed as Partial<ApiSecrets>;
    const out = emptySecrets();
    if (typeof p.envSecrets === 'object' && p.envSecrets !== null) {
      for (const [k, v] of Object.entries(p.envSecrets)) if (typeof v === 'string') out.envSecrets[k] = v;
    }
    if (typeof p.authSecrets === 'object' && p.authSecrets !== null) {
      for (const [k, v] of Object.entries(p.authSecrets)) if (typeof v === 'string') out.authSecrets[k] = v;
    }
    return out;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptySecrets();
    throw new HttpRouteError(`api secrets unreadable: ${(e as Error).message}`, 'secrets-unreadable');
  }
}

function writeMode600(path: string, payload: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, payload, { mode: 0o600 });
  renameSync(tmp, path);
}

function saveStore(store: ApiStore): void {
  writeMode600(join(apiDataDir(), 'http-api.json'), JSON.stringify(store, null, 2));
}

function saveSecrets(secrets: ApiSecrets): void {
  writeMode600(join(apiDataDir(), 'http-api-secrets.json'), JSON.stringify(secrets, null, 2));
}

function apiKeyHeaderNames(store: ApiStore): string[] {
  return store.authProfiles.filter((p) => p.kind === 'apikey').map((p) => p.headerName ?? 'X-Api-Key');
}

/** Resolve an environment's full variable map (secrets included). */
function resolveEnvVars(
  store: ApiStore,
  secrets: ApiSecrets,
  name: string | null | undefined,
  explicit: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {};
  if (name) {
    const env = store.environments.find((e) => e.name === name);
    if (!env) throw new HttpRouteError(`unknown api environment ${JSON.stringify(name)}`, 'unknown-environment');
    for (const [k, v] of Object.entries(env.vars)) {
      if (env.secretNames.includes(k)) {
        const sv = secrets.envSecrets[`${name}:${k}`];
        if (sv === undefined) throw new HttpRouteError(`secret variable ${name}:${k} has no stored value`, 'missing-secret');
        vars[k] = sv;
      } else {
        vars[k] = v;
      }
    }
  }
  for (const [k, v] of Object.entries(explicit)) vars[k] = v;
  return vars;
}

/** Resolve an auth profile's secret (stored file or process env). */
function resolveAuthSecret(store: ApiStore, secrets: ApiSecrets, profile: AuthProfile): string | null {
  if (profile.secretEnv) {
    const v = process.env[profile.secretEnv];
    return v !== undefined && v !== '' ? v : null;
  }
  return secrets.authSecrets[profile.id] ?? null;
}

function findAuthProfile(store: ApiStore, id: string | null | undefined): AuthProfile | null {
  if (!id) return null;
  return store.authProfiles.find((p) => p.id === id) ?? null;
}

interface SendInput {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
  environment?: string | null;
  authProfileId?: string | null;
  variables?: Record<string, string>;
  timeoutMs?: number;
  collectionId?: string | null;
  collectionName?: string | null;
  requestName?: string;
}

interface SendOutcome {
  result: HttpRunResult;
  historyId: string;
}

async function executeSend(ctx: RouteContext, input: SendInput, projectId: string): Promise<SendOutcome> {
  if (!egressGate) throw new HttpRouteError('egress gate is not wired', 'not-wired');
  const store = loadStore();
  const secrets = loadSecrets();
  const vars = resolveEnvVars(store, secrets, input.environment, input.variables ?? {});
  // Strict substitution: a missing variable fails BEFORE anything dials.
  let url: string;
  let headers: Record<string, string>;
  let body: string | undefined;
  try {
    url = substituteVarsStrict(input.url, vars);
    headers = {};
    for (const [k, v] of Object.entries(input.headers)) headers[k] = substituteVarsStrict(v, vars);
    body = input.body !== undefined ? substituteVarsStrict(input.body, vars) : undefined;
  } catch (e) {
    const err = e as HttpClientError;
    throw new HttpRouteError(err.message, err.code);
  }
  const profile = findAuthProfile(store, input.authProfileId);
  if (input.authProfileId && !profile) throw new HttpRouteError(`unknown auth profile ${JSON.stringify(input.authProfileId)}`, 'unknown-auth-profile');
  try {
    if (profile) headers = applyAuth(headers, profile, resolveAuthSecret(store, secrets, profile));
  } catch (e) {
    const err = e as HttpClientError;
    throw new HttpRouteError(err.message, err.code);
  }
  const redacted = redactUrl(url);
  try {
    egressGate(url);
  } catch (e) {
    const err = e as Error & { code?: string };
    const historyId = recordHistory(store, {
      method: input.method,
      urlTemplate: input.url,
      environment: input.environment ?? null,
      authProfileId: input.authProfileId ?? null,
      collectionId: input.collectionId ?? null,
      collectionName: input.collectionName ?? null,
      requestName: input.requestName ?? '',
      blocked: true,
      ok: false,
      spec: { method: input.method, url: input.url, headers: stripAuthHeaders(input.headers, apiKeyHeaderNames(store)), body: input.body },
    });
    ctx.audit.record('human', 'HTTP_API_RUN', 'http-client', `${projectId}:blocked`, {
      method: input.method, host: redacted.host, path: redacted.path, blocked: true, blockedCode: err.code ?? 'unknown',
    });
    return {
      result: { id: 'send', name: input.requestName ?? '', method: input.method, url, blocked: true, blockedReason: err.message, assertions: [], ok: false },
      historyId,
    };
  }
  const result = await sendHttpRequest(
    { id: 'send', name: input.requestName ?? '', method: input.method, url, headers, body, assertions: [] },
    { defaultTimeoutMs: input.timeoutMs },
  );
  const historyId = recordHistory(store, {
    method: input.method,
    urlTemplate: input.url,
    environment: input.environment ?? null,
    authProfileId: input.authProfileId ?? null,
    collectionId: input.collectionId ?? null,
    collectionName: input.collectionName ?? null,
    requestName: input.requestName ?? '',
    status: result.status,
    durationMs: result.durationMs,
    ok: result.ok,
    error: result.error,
    spec: { method: input.method, url: input.url, headers: stripAuthHeaders(input.headers, apiKeyHeaderNames(store)), body: input.body },
  });
  ctx.audit.record('human', 'HTTP_API_RUN', 'http-client', `${projectId}:${historyId}`, {
    method: input.method, host: redacted.host, path: redacted.path, blocked: false,
    status: result.status ?? null, durationMs: result.durationMs ?? null, ok: result.ok, error: result.error ?? null,
  });
  return { result, historyId };
}

function recordHistory(store: ApiStore, partial: Omit<HistoryEntry, 'id' | 'at' | 'spec'> & { spec: HistoryEntry['spec'] }): string {
  const id = randomUUID();
  const entry: HistoryEntry = { id, at: Date.now(), ...partial };
  store.history = [entry, ...store.history].slice(0, MAX_HISTORY);
  saveStore(store);
  return id;
}

function readJsonBody(body: unknown, what: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpRouteError(`${what} body must be a JSON object`, 'bad-json');
  }
  return body as Record<string, unknown>;
}

function optString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function optVariables(v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpRouteError('`variables` must be an object', 'bad-input');
  const out: Record<string, string> = {};
  for (const [k, v2] of Object.entries(v as Record<string, unknown>)) {
    if (typeof v2 !== 'string') throw new HttpRouteError('`variables` values must be strings', 'bad-input');
    out[k] = v2;
  }
  return out;
}

function optTimeout(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || v <= 0 || v > 120_000) throw new HttpRouteError('`timeoutMs` must be a positive number ≤ 120000', 'bad-input');
  return v;
}

function handleApiError(res: ServerResponse, ctx: RouteContext, e: unknown): boolean {
  const err = e as HttpRouteError | HttpClientError;
  const code = (err as { code?: string }).code ?? 'error';
  const status = code === 'not-found' ? 404 : code === 'unknown-environment' || code === 'unknown-auth-profile' || code === 'missing-secret' ? 400
    : code === 'oauth2-placeholder' || code === 'unresolved-variable' ? 400
    : code === 'store-unreadable' || code === 'secrets-unreadable' || code === 'not-wired' ? 500
    : 400;
  ctx.json(res, status, { error: err.message, code });
  return true;
}

/* --- collections --- */

async function handleListCollections(res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    ctx.json(res, 200, { collections: loadStore().collections });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

async function handleCreateCollection(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const b = readJsonBody(await ctx.readBody(req), 'collection');
    const collection = validateCollection(b['collection'] ?? b);
    const store = loadStore();
    if (store.collections.some((c) => c.id === collection.id)) {
      ctx.json(res, 409, { error: `collection ${collection.id} already exists`, code: 'exists' });
      return true;
    }
    if (store.collections.length >= MAX_COLLECTIONS) {
      ctx.json(res, 400, { error: `too many collections (cap ${MAX_COLLECTIONS})`, code: 'too-many' });
      return true;
    }
    store.collections.push(collection);
    saveStore(store);
    ctx.json(res, 201, { collection });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

async function handlePutCollection(req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  const id = url.pathname.split('/').pop() ?? '';
  try {
    const b = readJsonBody(await ctx.readBody(req), 'collection');
    const collection = validateCollection({ ...(b['collection'] ?? b), id });
    const store = loadStore();
    const idx = store.collections.findIndex((c) => c.id === id);
    if (idx < 0) {
      ctx.json(res, 404, { error: `collection ${id} not found`, code: 'not-found' });
      return true;
    }
    store.collections[idx] = collection;
    saveStore(store);
    ctx.json(res, 200, { collection });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

async function handleDeleteCollection(res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  const id = url.pathname.split('/').pop() ?? '';
  try {
    const store = loadStore();
    const before = store.collections.length;
    store.collections = store.collections.filter((c) => c.id !== id);
    if (store.collections.length === before) {
      ctx.json(res, 404, { error: `collection ${id} not found`, code: 'not-found' });
      return true;
    }
    saveStore(store);
    ctx.json(res, 200, { ok: true });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

/* --- auth profiles (metadata only; secrets never leave the server) --- */

function publicProfile(p: AuthProfile): AuthProfile {
  return p;
}

async function handleListAuthProfiles(res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    ctx.json(res, 200, { profiles: loadStore().authProfiles.map(publicProfile) });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

async function handleCreateAuthProfile(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const b = readJsonBody(await ctx.readBody(req), 'auth profile');
    const meta = validateAuthProfile(b['profile'] ?? b);
    const secret = typeof b['secret'] === 'string' ? b['secret'] : null;
    if (secret !== null && (secret.length === 0 || secret.length > 10_000)) {
      ctx.json(res, 400, { error: 'secret must be a non-empty string (max 10000 chars)', code: 'bad-input' });
      return true;
    }
    if (meta.secretEnv && secret !== null) {
      ctx.json(res, 400, { error: 'provide either secret or secretEnv, not both', code: 'bad-input' });
      return true;
    }
    const store = loadStore();
    if (store.authProfiles.some((p) => p.id === meta.id)) {
      ctx.json(res, 409, { error: `auth profile ${meta.id} already exists`, code: 'exists' });
      return true;
    }
    if (store.authProfiles.length >= MAX_AUTH_PROFILES) {
      ctx.json(res, 400, { error: `too many auth profiles (cap ${MAX_AUTH_PROFILES})`, code: 'too-many' });
      return true;
    }
    const profile: AuthProfile = {
      ...meta,
      secretSource: secret !== null ? 'stored' : meta.secretEnv ? 'env' : null,
      hasSecret: secret !== null || !!meta.secretEnv,
    };
    store.authProfiles.push(profile);
    saveStore(store);
    if (secret !== null) {
      const secrets = loadSecrets();
      secrets.authSecrets[profile.id] = secret;
      saveSecrets(secrets);
    }
    ctx.json(res, 201, { profile: publicProfile(profile) });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

async function handleDeleteAuthProfile(res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  const id = url.pathname.split('/').pop() ?? '';
  try {
    const store = loadStore();
    const before = store.authProfiles.length;
    store.authProfiles = store.authProfiles.filter((p) => p.id !== id);
    if (store.authProfiles.length === before) {
      ctx.json(res, 404, { error: `auth profile ${id} not found`, code: 'not-found' });
      return true;
    }
    saveStore(store);
    const secrets = loadSecrets();
    delete secrets.authSecrets[id];
    saveSecrets(secrets);
    ctx.json(res, 200, { ok: true });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

/* --- API environments (secret VALUES live only in the secrets file) --- */

async function handleListApiEnvironments(res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    ctx.json(res, 200, { environments: loadStore().environments.map(redactApiEnvironment) });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

async function handlePutApiEnvironment(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const b = readJsonBody(await ctx.readBody(req), 'environment');
    const env = validateApiEnvironment(b['environment'] ?? b);
    const secretsIn = (b['secrets'] ?? {}) as Record<string, unknown>;
    if (typeof secretsIn !== 'object' || Array.isArray(secretsIn)) throw new HttpRouteError('`secrets` must be an object', 'bad-input');
    for (const [k, v] of Object.entries(secretsIn)) {
      if (!env.secretNames.includes(k)) throw new HttpRouteError(`secret ${k} is not listed in secretNames`, 'bad-input');
      if (typeof v !== 'string' || v.length > 10_000) throw new HttpRouteError(`secret ${k} must be a short string`, 'bad-input');
    }
    const store = loadStore();
    if (!store.environments.some((e) => e.name === env.name) && store.environments.length >= MAX_ENVIRONMENTS) {
      ctx.json(res, 400, { error: `too many environments (cap ${MAX_ENVIRONMENTS})`, code: 'too-many' });
      return true;
    }
    const idx = store.environments.findIndex((e) => e.name === env.name);
    if (idx >= 0) store.environments[idx] = env;
    else store.environments.push(env);
    saveStore(store);
    const secrets = loadSecrets();
    // Drop stored values for names no longer secret; upsert the new ones.
    for (const key of Object.keys(secrets.envSecrets)) {
      if (key.startsWith(`${env.name}:`) && !env.secretNames.includes(key.slice(env.name.length + 1))) delete secrets.envSecrets[key];
    }
    for (const [k, v] of Object.entries(secretsIn)) secrets.envSecrets[`${env.name}:${k}`] = v as string;
    saveSecrets(secrets);
    ctx.json(res, 200, { environment: redactApiEnvironment(env) });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

/* --- send / history / graphql --- */

async function handleSend(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const b = readJsonBody(await ctx.readBody(req), 'send');
    const method = b['method'];
    if (typeof method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
      ctx.json(res, 400, { error: 'bad method', code: 'bad-input' });
      return true;
    }
    const urlStr = b['url'];
    if (typeof urlStr !== 'string' || urlStr.length === 0 || urlStr.length > 4096) {
      ctx.json(res, 400, { error: 'bad url', code: 'bad-input' });
      return true;
    }
    const headers: Record<string, string> = {};
    if (b['headers'] !== undefined) {
      if (typeof b['headers'] !== 'object' || b['headers'] === null || Array.isArray(b['headers'])) {
        ctx.json(res, 400, { error: 'headers must be an object', code: 'bad-input' });
        return true;
      }
      for (const [k, v] of Object.entries(b['headers'] as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          ctx.json(res, 400, { error: 'header values must be strings', code: 'bad-input' });
          return true;
        }
        headers[k] = v;
      }
    }
    if (typeof headers['Authorization'] === 'string') {
      ctx.json(res, 400, { error: 'inline Authorization header is not allowed (use an auth profile)', code: 'bad-input' });
      return true;
    }
    const store = loadStore();
    const collection = typeof b['collectionId'] === 'string' ? store.collections.find((c) => c.id === b['collectionId']) : undefined;
    const { result, historyId } = await executeSend(ctx, {
      method: method as HttpMethod,
      url: urlStr,
      headers,
      body: typeof b['body'] === 'string' ? b['body'] : undefined,
      environment: optString(b['environment']),
      authProfileId: optString(b['authProfileId']),
      variables: optVariables(b['variables']),
      timeoutMs: optTimeout(b['timeoutMs']),
      collectionId: typeof b['collectionId'] === 'string' ? b['collectionId'] : null,
      collectionName: collection?.name ?? null,
      requestName: typeof b['requestName'] === 'string' ? b['requestName'] : '',
    }, optString(b['projectId']) ?? 'local');
    ctx.json(res, 200, { historyId, result });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

async function handleListHistory(res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    // History entries are redacted by construction (template URLs,
    // auth-stripped specs); still strip any stray credential header.
    const store = loadStore();
    const names = apiKeyHeaderNames(store);
    const history = store.history.map((h) => ({
      ...h,
      spec: { ...h.spec, headers: stripAuthHeaders(h.spec.headers, names) },
    }));
    ctx.json(res, 200, { history });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

async function handleRerunHistory(req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  const parts = url.pathname.split('/');
  const id = parts[parts.length - 2] ?? '';
  try {
    const b = readJsonBody(await ctx.readBody(req), 'rerun');
    const store = loadStore();
    const entry = store.history.find((h) => h.id === id);
    if (!entry) {
      ctx.json(res, 404, { error: `history ${id} not found`, code: 'not-found' });
      return true;
    }
    const { result, historyId } = await executeSend(ctx, {
      method: entry.spec.method,
      url: entry.spec.url,
      headers: entry.spec.headers,
      body: entry.spec.body,
      environment: entry.environment,
      authProfileId: entry.authProfileId,
      variables: optVariables(b['variables']),
      timeoutMs: optTimeout(b['timeoutMs']),
      collectionId: entry.collectionId,
      collectionName: entry.collectionName,
      requestName: entry.requestName,
    }, optString(b['projectId']) ?? 'local');
    // Link the new entry back to its source.
    const store2 = loadStore();
    const fresh = store2.history.find((h) => h.id === historyId);
    if (fresh) {
      fresh.rerunOf = id;
      saveStore(store2);
    }
    ctx.json(res, 200, { historyId, rerunOf: id, result });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const b = readJsonBody(await ctx.readBody(req), 'graphql');
    const endpoint = b['endpoint'];
    const query = b['query'];
    if (typeof endpoint !== 'string' || typeof query !== 'string') {
      ctx.json(res, 400, { error: 'endpoint and query are required strings', code: 'bad-input' });
      return true;
    }
    if (!egressGate) throw new HttpRouteError('egress gate is not wired', 'not-wired');
    const store = loadStore();
    const secrets = loadSecrets();
    const vars = resolveEnvVars(store, secrets, optString(b['environment']), optVariables(b['variables']));
    let endpointSub: string;
    let querySub: string;
    let variablesSub: Record<string, unknown>;
    try {
      endpointSub = substituteVarsStrict(endpoint, vars);
      querySub = substituteVarsStrict(query, vars);
      const rawVars = (b['graphqlVariables'] ?? {}) as unknown;
      if (typeof rawVars !== 'object' || rawVars === null || Array.isArray(rawVars)) {
        ctx.json(res, 400, { error: 'graphqlVariables must be an object', code: 'bad-input' });
        return true;
      }
      variablesSub = substituteVarsStrictDeep(rawVars, vars) as Record<string, unknown>;
    } catch (e) {
      const err = e as HttpClientError;
      throw new HttpRouteError(err.message, err.code);
    }
    let headers: Record<string, string> = {};
    const profile = findAuthProfile(store, optString(b['authProfileId']));
    if (b['authProfileId'] && !profile) throw new HttpRouteError(`unknown auth profile ${JSON.stringify(b['authProfileId'])}`, 'unknown-auth-profile');
    try {
      if (profile) headers = applyAuth(headers, profile, resolveAuthSecret(store, secrets, profile));
    } catch (e) {
      const err = e as HttpClientError;
      throw new HttpRouteError(err.message, err.code);
    }
    const redacted = redactUrl(endpointSub);
    try {
      egressGate(endpointSub);
    } catch (e) {
      const err = e as Error & { code?: string };
      ctx.json(res, 200, {
        result: { id: 'graphql', name: '', method: 'POST', url: endpointSub, blocked: true, blockedReason: err.message, assertions: [], ok: false },
      });
      return true;
    }
    const result = await sendGraphqlRequest(
      { endpoint: endpointSub, query: querySub, variables: variablesSub, operationName: typeof b['operationName'] === 'string' ? b['operationName'] : undefined },
      headers,
      optTimeout(b['timeoutMs']),
    );
    ctx.audit.record('human', 'HTTP_API_GRAPHQL', 'http-client', optString(b['projectId']) ?? 'local', {
      host: redacted.host, path: redacted.path, status: result.status ?? null, ok: result.ok, graphqlErrors: result.graphqlErrors?.length ?? 0,
    });
    ctx.json(res, 200, { result });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

/* --- WebSocket sessions (in-process) --- */

interface WsSession {
  id: string;
  url: string;
  status: 'open' | 'closed';
  closeCode?: number;
  closeReason?: string;
  connectedAt: number;
  messages: Array<{ direction: 'in' | 'out'; text: string; at: number }>;
  client: WsClient;
}

const wsSessions = new Map<string, WsSession>();
const MAX_WS_SESSIONS = 20;
const MAX_WS_MESSAGES = 200;

function wsPublic(s: WsSession): Record<string, unknown> {
  return {
    id: s.id, url: s.url, status: s.status,
    closeCode: s.closeCode ?? null, closeReason: s.closeReason ?? null, connectedAt: s.connectedAt,
    messageCount: s.messages.length,
  };
}

async function handleWsConnect(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const b = readJsonBody(await ctx.readBody(req), 'ws connect');
    const urlText = b['url'];
    if (typeof urlText !== 'string' || urlText.length === 0 || urlText.length > 4096) {
      ctx.json(res, 400, { error: 'bad ws url', code: 'bad-input' });
      return true;
    }
    if (!egressGate) throw new HttpRouteError('egress gate is not wired', 'not-wired');
    let u: URL;
    try {
      u = new URL(urlText);
    } catch {
      ctx.json(res, 400, { error: 'invalid ws url', code: 'bad-input' });
      return true;
    }
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      ctx.json(res, 400, { error: 'only ws:// and wss:// are supported', code: 'bad-input' });
      return true;
    }
    const openCount = [...wsSessions.values()].filter((s) => s.status === 'open').length;
    if (openCount >= MAX_WS_SESSIONS) {
      ctx.json(res, 400, { error: `too many open ws sessions (cap ${MAX_WS_SESSIONS})`, code: 'too-many' });
      return true;
    }
    // Firewall decision on the http(s) equivalent (documented above).
    const httpEquiv = new URL(urlText);
    httpEquiv.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    try {
      egressGate(httpEquiv.toString());
    } catch (e) {
      const err = e as Error;
      ctx.json(res, 403, { error: `egress refused: ${err.message}`, code: 'egress-blocked' });
      return true;
    }
    const timeoutMs = optTimeout(b['timeoutMs']) ?? 10_000;
    let client: WsClient;
    try {
      client = await wsConnect(urlText, timeoutMs);
    } catch (e) {
      ctx.json(res, 502, { error: `ws connect failed: ${(e as Error).message}`, code: 'ws-connect-failed' });
      return true;
    }
    const id = randomUUID();
    const session: WsSession = {
      id, url: urlText, status: 'open', connectedAt: Date.now(), messages: [], client,
    };
    client.onMessage((text) => {
      session.messages.push({ direction: 'in', text: text.slice(0, 64_000), at: Date.now() });
      if (session.messages.length > MAX_WS_MESSAGES) session.messages.splice(0, session.messages.length - MAX_WS_MESSAGES);
    });
    client.onClose((code, reason) => {
      session.status = 'closed';
      session.closeCode = code;
      session.closeReason = reason;
    });
    wsSessions.set(id, session);
    ctx.audit.record('human', 'HTTP_API_WS_CONNECT', 'http-client', id, { host: u.host, path: u.pathname });
    ctx.json(res, 201, { session: wsPublic(session), egressCheckedAs: httpEquiv.toString() });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

function wsSessionOr404(res: ServerResponse, ctx: RouteContext, id: string): WsSession | null {
  const s = wsSessions.get(id);
  if (!s) {
    ctx.json(res, 404, { error: `ws session ${id} not found`, code: 'not-found' });
    return null;
  }
  return s;
}

async function handleWsSend(req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  const id = url.pathname.split('/')[4] ?? '';
  try {
    const b = readJsonBody(await ctx.readBody(req), 'ws send');
    const text = b['text'];
    if (typeof text !== 'string' || text.length > 64_000) {
      ctx.json(res, 400, { error: 'text is required (max 64000 chars)', code: 'bad-input' });
      return true;
    }
    const s = wsSessionOr404(res, ctx, id);
    if (!s) return true;
    if (s.status !== 'open' || s.client.closed) {
      ctx.json(res, 409, { error: `ws session is closed (code ${s.closeCode ?? '?'})`, code: 'ws-closed' });
      return true;
    }
    try {
      s.client.sendText(text);
    } catch (e) {
      ctx.json(res, 409, { error: (e as Error).message, code: 'ws-closed' });
      return true;
    }
    s.messages.push({ direction: 'out', text, at: Date.now() });
    if (s.messages.length > MAX_WS_MESSAGES) s.messages.splice(0, s.messages.length - MAX_WS_MESSAGES);
    ctx.json(res, 200, { ok: true });
  } catch (e) {
    return handleApiError(res, ctx, e);
  }
  return true;
}

async function handleWsMessages(res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  const id = url.pathname.split('/')[4] ?? '';
  const s = wsSessionOr404(res, ctx, id);
  if (!s) return true;
  ctx.json(res, 200, { session: wsPublic(s), messages: s.messages });
  return true;
}

async function handleWsClose(res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  const id = url.pathname.split('/')[4] ?? '';
  const s = wsSessionOr404(res, ctx, id);
  if (!s) return true;
  try {
    s.client.close(1000, 'client close');
  } catch {
    /* already gone */
  }
  s.status = 'closed';
  ctx.json(res, 200, { session: wsPublic(s) });
  return true;
}

async function handleWsSessions(res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  ctx.json(res, 200, { sessions: [...wsSessions.values()].map(wsPublic) });
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
  // Round-7 R7-#9 deepening endpoints (same prefix, same RBAC rule).
  if (req.method === 'GET' && rest === '/collections') return handleListCollections(res, ctx);
  if (req.method === 'POST' && rest === '/collections') return handleCreateCollection(req, res, ctx);
  if (req.method === 'PUT' && rest.startsWith('/collections/')) return handlePutCollection(req, res, url, ctx);
  if (req.method === 'DELETE' && rest.startsWith('/collections/')) return handleDeleteCollection(res, url, ctx);
  if (req.method === 'GET' && rest === '/auth-profiles') return handleListAuthProfiles(res, ctx);
  if (req.method === 'POST' && rest === '/auth-profiles') return handleCreateAuthProfile(req, res, ctx);
  if (req.method === 'DELETE' && rest.startsWith('/auth-profiles/')) return handleDeleteAuthProfile(res, url, ctx);
  if (req.method === 'GET' && rest === '/api-environments') return handleListApiEnvironments(res, ctx);
  if (req.method === 'PUT' && rest === '/api-environments') return handlePutApiEnvironment(req, res, ctx);
  if (req.method === 'POST' && rest === '/send') return handleSend(req, res, ctx);
  if (req.method === 'GET' && rest === '/history') return handleListHistory(res, ctx);
  if (req.method === 'POST' && rest.endsWith('/rerun') && rest.startsWith('/history/')) return handleRerunHistory(req, res, url, ctx);
  if (req.method === 'DELETE' && rest.startsWith('/history/')) {
    const id = rest.split('/')[2] ?? '';
    try {
      const store = loadStore();
      const before = store.history.length;
      store.history = store.history.filter((h) => h.id !== id);
      if (store.history.length === before) {
        ctx.json(res, 404, { error: `history ${id} not found`, code: 'not-found' });
        return true;
      }
      saveStore(store);
      ctx.json(res, 200, { ok: true });
    } catch (e) {
      return handleApiError(res, ctx, e);
    }
    return true;
  }
  if (req.method === 'POST' && rest === '/graphql') return handleGraphql(req, res, ctx);
  if (req.method === 'POST' && rest === '/ws/connect') return handleWsConnect(req, res, ctx);
  if (req.method === 'GET' && rest === '/ws/sessions') return handleWsSessions(res, ctx);
  if (req.method === 'GET' && rest.startsWith('/ws/') && rest.endsWith('/messages')) return handleWsMessages(res, url, ctx);
  if (req.method === 'POST' && rest.startsWith('/ws/') && rest.endsWith('/send')) return handleWsSend(req, res, url, ctx);
  if (req.method === 'POST' && rest.startsWith('/ws/') && rest.endsWith('/close')) return handleWsClose(res, url, ctx);
  ctx.json(res, 404, { error: 'unknown http-client route', code: 'not-found' });
  return true;
}

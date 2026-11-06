/**
 * DAP debugger routes (round-4 task R4-S2).
 *
 *   GET  /api/debug/configs?projectId=&targetDir=
 *     → 200 {configurations: NormalizedLaunchConfig[], note?}
 *         400 {error, code} on invalid launch.json
 *   GET  /api/debug/adapters → 200 {adapters: AdapterInfo[]} (static registry, no spawn)
 *   POST /api/debug/adapters/:kind/probe → 200 {kind, available, version?, detail}
 *         400 unknown adapter kind
 *   POST /api/debug/sessions   {projectId, targetDir?, configName? | config?,
 *                               breakpoints?: [{file,line,column?,condition?,logMessage?}]}
 *     → 201 {sessionId, name, request, state, breakpoints}
 *         400 bad params / bad breakpoint (incl. invalid condition syntax) /
 *         404 unknown configName / 409 too many sessions /
 *         501 python/go adapter registered but not driven /
 *         502 adapter spawn/handshake failure
 *   GET  /api/debug/sessions → 200 {sessions: [...]}
 *   GET  /api/debug/sessions/:id → 200 {session} | 404
 *   GET  /api/debug/sessions/:id/output?since= → 200 {lines: [{seq, category, output}]}
 *   POST /api/debug/sessions/:id/breakpoints  {breakpoints:[{file,line,column?,condition?,logMessage?}]}
 *     → 200 {breakpoints:[{id,verified,line,file}]} | 404 | 410 session dead
 *   POST /api/debug/sessions/:id/continue|next|step-in|step-out|pause
 *     → 200 {ok:true} | 404 | 409 NOT_PAUSED | 410 session dead | 504 DAP_TIMEOUT
 *   GET  /api/debug/sessions/:id/stack?threadId= → 200 {stackFrames,totalFrames}
 *   GET  /api/debug/sessions/:id/scopes?frameId= → 200 {scopes}
 *   GET  /api/debug/sessions/:id/variables?ref= → 200 {variables}
 *   POST /api/debug/sessions/:id/evaluate {expression, frameId?, context?}
 *     → 200 {result, type, variablesReference}
 *   DELETE /api/debug/sessions/:id → 200 {ok:true} | 404
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleDebugRoutes, setDebugInspectionRootResolver, setDebugAdapterSpawnFn } from './routes/debug';
 *   if (await handleDebugRoutes(req, res, url, routeCtx)) return;
 *   setDebugInspectionRootResolver((root) => resolveInspectionRoot(root));
 *
 * Sessions live in-memory (like refactor proposals): the DebugClient owns the
 * adapter child process; the route buffers the last 200 output lines per
 * session and caches the last stop state for UI polling.
 *
 * RBAC: the default prefix rule in auth.ts (requiredRoleFor) gives GET →
 * viewer and every other method → operator for this prefix — no auth.ts
 * change needed.
 *
 * Audit: DEBUG_SESSION_STARTED / DEBUG_SESSION_STOPPED / DEBUG_BREAKPOINTS_SET.
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - Only the Node.js adapter is driven. launch.json types python/debugpy
 *    and go/delve normalize (round-7 R7-#7) but session launch refuses
 *    them with 501 ADAPTER_NOT_IMPLEMENTED; other debug types are
 *    rejected, never reinterpreted.
 *  - launch runs the program under `node --inspect=127.0.0.1:0` on loopback;
 *    attach connects to an existing inspector on 127.0.0.1 (address field is
 *    accepted but loopback-only is enforced).
 *  - max 8 concurrent sessions (429 beyond); sessions are server-local and
 *    die with the server.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep, basename } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RouteContext } from './context';
import type { ExecSandboxDecision } from '../exec-sandbox';
import { redactText } from '@ai-factory/diagpack';
import { redactAmbientCredentialValues } from '@ai-factory/runtime';
import { canonicalPathIsInside, canonicalizePathSync } from '@ai-factory/security';
import {
  DebugClient,
  DebugError,
  LaunchConfigError,
  classifyBreakpoint,
  getAdapterInfo,
  listAdapters,
  normalizeConfig,
  parseLaunchJson,
  probeAdapter,
  resolveNodeAdapterScript,
  selectConfig,
  validateConditionSyntax,
  type AdapterKind,
  type NormalizedLaunchConfig,
  type SpawnFn,
} from '@ai-factory/debugger';

const PREFIX = '/api/debug';
const MAX_SESSIONS = 8;
const MAX_OUTPUT_LINES = 200;
const LAUNCH_TIMEOUT_MS = 60000;

/** Race a promise against a timeout; the timer is always cleared. */
async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DebugError('DAP_TIMEOUT', message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class DebugRouteError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'DebugRouteError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// setter-injected wiring (dual-mode import rule: no value-import of siblings)
// ---------------------------------------------------------------------------

let inspectionRootResolver: ((root?: string) => string) | null = null;
export function setDebugInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  inspectionRootResolver = fn;
}

/** Test seam: replace the adapter spawn (server tests inject a fake DAP adapter). */
let adapterSpawnFn: SpawnFn | null = null;
export function setDebugAdapterSpawnFn(fn: SpawnFn | null): void {
  adapterSpawnFn = fn;
}

/**
 * Sandbox decider: coordinator-injected decideExecSandbox (V3R18 #6(m)).
 * Same setter-injection pattern as the other wiring above — this module
 * is imported from src by tests, so it must not value-import
 * ../exec-sandbox (dual-mode import rule). Unwired → 'disabled'
 * decision (sessions launch as before); production always wires it.
 */
let debugSandboxDecider: ((cwd: string) => Promise<ExecSandboxDecision>) | null = null;
export function setDebugSandboxDecider(fn: ((cwd: string) => Promise<ExecSandboxDecision>) | null): void {
  debugSandboxDecider = fn;
}

function resolveTargetDir(rawDir?: string): string {
  if (!inspectionRootResolver) {
    throw new DebugRouteError('inspection root resolver is not wired', 'not-wired', 500);
  }
  try {
    return inspectionRootResolver(rawDir);
  } catch (e) {
    throw new DebugRouteError((e as Error).message, 'bad-target-dir');
  }
}

/** Jail a project-relative file to the target dir; fail-closed. */
function jailFile(root: string, file: string, label: string): string {
  if (typeof file !== 'string' || !file.trim() || file.length > 1024) {
    throw new DebugRouteError(`invalid ${label}: ${String(file).slice(0, 80)}`, 'bad-file');
  }
  // V3R19 #6(p): decide on the canonical path — a symlink inside the
  // target dir that points outside it must be refused exactly like a
  // direct path outside the dir (the existsSync check below still runs
  // on the canonical path, so a dangling link is 'not-found' as before).
  const abs = canonicalizePathSync(resolve(root, file));
  const realRoot = canonicalizePathSync(root);
  if (abs !== realRoot && !canonicalPathIsInside(abs, realRoot)) {
    throw new DebugRouteError(`${label} escapes the target dir: ${file}`, 'jail');
  }
  if (!existsSync(abs)) {
    throw new DebugRouteError(`${label} does not exist: ${file}`, 'not-found');
  }
  return abs;
}

// ---------------------------------------------------------------------------
// session store
// ---------------------------------------------------------------------------

interface OutputLine {
  seq: number;
  category: string;
  output: string;
}

interface DebugSession {
  id: string;
  name: string;
  request: 'launch' | 'attach';
  adapter: AdapterKind;
  client: DebugClient;
  createdAt: string;
  state: 'starting' | 'running' | 'paused' | 'terminated';
  stopReason?: string;
  stopThreadId?: number;
  output: OutputLine[];
  outputSeq: number;
}

const sessions = new Map<string, DebugSession>();

function sweepDead(): void {
  for (const [id, s] of sessions) {
    if (s.client.exited && s.state === 'terminated') sessions.delete(id);
  }
}

function getSession(id: string): DebugSession {
  const s = sessions.get(id);
  if (!s) throw new DebugRouteError('unknown debug session', 'no-session', 404);
  return s;
}

function requireLive(s: DebugSession): DebugClient {
  if (s.client.exited || s.state === 'terminated') {
    throw new DebugRouteError('debug session is dead', 'session-dead', 410);
  }
  return s.client;
}

function mapDebugError(e: unknown): DebugRouteError {
  if (e instanceof DebugRouteError) return e;
  if (e instanceof LaunchConfigError) {
    const notFound = /no launch configuration named/.test(e.message);
    return new DebugRouteError(e.message, 'bad-config', notFound ? 404 : 400);
  }
  if (e instanceof DebugError) {
    if (e.code === 'ADAPTER_NOT_IMPLEMENTED') {
      return new DebugRouteError(e.message, 'adapter-not-implemented', 501);
    }
    if (e.code === 'ADAPTER_SPAWN_FAILED' || e.code === 'ADAPTER_EXITED') {
      return new DebugRouteError(`debug adapter failed: ${e.message}`, 'adapter-failed', 502);
    }
    if (e.code === 'DAP_TIMEOUT') {
      return new DebugRouteError(`debug adapter timed out: ${e.message}`, 'dap-timeout', 504);
    }
    if (/NOT_PAUSED/i.test(e.message)) {
      return new DebugRouteError('target is not stopped', 'not-paused', 409);
    }
    return new DebugRouteError(`debug request failed: ${e.message}`, 'dap-error', 500);
  }
  return new DebugRouteError(`debug failed: ${(e as Error).message}`, 'debug-error', 500);
}

// ---------------------------------------------------------------------------
// launch.json
// ---------------------------------------------------------------------------

function loadLaunchConfigs(root: string): { configurations: NormalizedLaunchConfig[]; note?: string } {
  const file = resolve(root, '.vscode', 'launch.json');
  if (!existsSync(file)) {
    return { configurations: [], note: 'no .vscode/launch.json in the target dir' };
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new DebugRouteError(`cannot read launch.json: ${(e as Error).message}`, 'read-failed');
  }
  const raw = parseLaunchJson(text);
  const out: NormalizedLaunchConfig[] = [];
  const skipped: string[] = [];
  for (const c of raw) {
    try {
      out.push(
        normalizeConfig(c, (p) => {
          // launch.json paths are workspace-relative; jail them to the root.
          if (/^[/\\]/.test(p) || /^[A-Za-z]:/.test(p)) {
            throw new Error(`absolute path not allowed in launch.json: ${p}`);
          }
          const abs = resolve(root, p);
          if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`path escapes workspace: ${p}`);
          return abs;
        }),
      );
    } catch {
      // Unsupported configs are skipped honestly (named in the note) rather
      // than failing the whole file.
      skipped.push(String(c.name ?? '<unnamed>'));
    }
  }
  const note =
    out.length === 0
      ? `no supported configurations found${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}`
      : skipped.length
        ? `skipped unsupported configurations: ${skipped.join(', ')}`
        : undefined;
  return { configurations: out, note };
}

// ---------------------------------------------------------------------------
// adapter registry (round-7 R7-#7)
// ---------------------------------------------------------------------------

async function handleGetAdapters(_req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  void _req;
  ctx.json(res, 200, { adapters: listAdapters() });
  return true;
}

async function handleProbeAdapter(_req: IncomingMessage, res: ServerResponse, ctx: RouteContext, kind: string): Promise<boolean> {
  void _req;
  try {
    const info = getAdapterInfo(kind);
    const probe = probeAdapter(info.kind);
    ctx.json(res, 200, { ...probe, implemented: info.implemented, installHint: info.installHint });
  } catch (e) {
    const err = mapDebugError(e);
    ctx.json(res, err.code === 'dap-error' ? 400 : err.status, {
      error: err.message,
      code: err.code === 'dap-error' ? 'unknown-adapter' : err.code,
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

function strOf(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

async function handleGetConfigs(req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext): Promise<boolean> {
  const projectId = strOf(url.searchParams.get('projectId'));
  if (!projectId) {
    ctx.json(res, 400, { error: 'projectId is required', code: 'bad-project' });
    return true;
  }
  const targetDir = strOf(url.searchParams.get('targetDir')) ?? undefined;
  let root: string;
  try {
    root = resolveTargetDir(targetDir);
  } catch (e) {
    const err = e as DebugRouteError;
    ctx.json(res, err.status, { error: err.message, code: err.code });
    return true;
  }
  try {
    ctx.json(res, 200, loadLaunchConfigs(root));
  } catch (e) {
    const err = mapDebugError(e);
    ctx.json(res, err.status, { error: err.message, code: err.code });
  }
  return true;
}

interface StartSessionBody {
  projectId?: unknown;
  targetDir?: unknown;
  configName?: unknown;
  config?: unknown;
  /** Optional breakpoints applied before configurationDone (deterministic). */
  breakpoints?: unknown;
}

async function handleStartSession(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const body = (await ctx.readBody(req)) as StartSessionBody;
  const projectId = strOf(body.projectId);
  if (!projectId) {
    ctx.json(res, 400, { error: 'projectId is required', code: 'bad-project' });
    return true;
  }
  const targetDir = strOf(body.targetDir) ?? undefined;
  let root: string;
  try {
    root = resolveTargetDir(targetDir);
  } catch (e) {
    const err = e as DebugRouteError;
    ctx.json(res, err.status, { error: err.message, code: err.code });
    return true;
  }
  sweepDead();
  if (sessions.size >= MAX_SESSIONS) {
    ctx.json(res, 409, { error: `too many debug sessions (max ${MAX_SESSIONS})`, code: 'too-many-sessions' });
    return true;
  }

  // Resolve the config: by name from launch.json, or inline.
  let cfg: NormalizedLaunchConfig;
  try {
    const configName = strOf(body.configName);
    if (configName) {
      const file = resolve(root, '.vscode', 'launch.json');
      if (!existsSync(file)) {
        throw new DebugRouteError(`no .vscode/launch.json, cannot resolve config "${configName}"`, 'no-launch-json', 404);
      }
      const rawAll = parseLaunchJson(readFileSync(file, 'utf8'));
      const rawCfg = selectConfig(rawAll, configName);
      cfg = normalizeConfig(rawCfg, (p) => jailFile(root, p, 'program'));
    } else if (body.config && typeof body.config === 'object') {
      const c = body.config as Record<string, unknown>;
      cfg = normalizeConfig(
        {
          name: strOf(c.name) ?? 'inline',
          type: strOf(c.type) ?? 'node',
          request: strOf(c.request) ?? 'launch',
          program: strOf(c.program) ?? undefined,
          args: Array.isArray(c.args) ? (c.args as unknown[]).filter((a): a is string => typeof a === 'string') : [],
          cwd: strOf(c.cwd) ?? undefined,
          env: typeof c.env === 'object' && c.env ? (c.env as Record<string, string>) : {},
          stopOnEntry: c.stopOnEntry === true,
          port: typeof c.port === 'number' ? c.port : undefined,
          address: strOf(c.address) ?? undefined,
        },
        (p) => jailFile(root, p, 'program'),
      );
    } else {
      throw new DebugRouteError('configName or config is required', 'bad-params');
    }
  } catch (e) {
    const err = e instanceof DebugRouteError ? e : mapDebugError(e);
    const status = err instanceof DebugRouteError ? err.status : 400;
    ctx.json(res, status, { error: err.message, code: (err as DebugRouteError).code ?? 'bad-config' });
    return true;
  }

  // Loopback-only attach: the address field is accepted but constrained.
  if (cfg.request === 'attach' && cfg.address !== '127.0.0.1' && cfg.address !== 'localhost' && cfg.address !== '::1') {
    ctx.json(res, 400, { error: 'attach is loopback-only (127.0.0.1)', code: 'bad-address' });
    return true;
  }

  // Round-7 R7-#7: python/go configs normalize but are not driven. Refuse
  // before spawning anything — never fall back to the Node adapter.
  if (cfg.adapter !== 'node') {
    const info = getAdapterInfo(cfg.adapter);
    ctx.json(res, 501, {
      error: `${info.displayName} is registered but not yet driven by this server (${info.installHint})`,
      code: 'adapter-not-implemented',
      adapter: info,
    });
    return true;
  }

  // V3R18 #6(m): the debuggee executes inside the exec bwrap sandbox
  // (cwd = the launch config's cwd, jailed to the target root by
  // normalizeConfig; the server cwd when the config sets none). The
  // sandbox prefix travels to the adapter inside the DAP launch args
  // and the adapter prepends it to the debuggee spawn argv. Fail-closed:
  // when bwrap is unavailable the session is not created — never
  // launched unisolated. The adapter process itself is server code and
  // is not sandboxed; only the operator-supplied debuggee is.
  const debuggeeCwd = cfg.cwd ?? process.cwd();
  const sb: ExecSandboxDecision = debugSandboxDecider
    ? await debugSandboxDecider(debuggeeCwd)
    : { mode: 'disabled', prefix: [], reason: null, sandboxed: false, refused: false, refuseCode: null };
  if (sb.refused) {
    ctx.json(res, 403, {
      error:
        `${sb.refuseCode ?? 'SANDBOX_UNAVAILABLE'}: debug sessions require OS-enforced isolation (bwrap), ` +
        `but no working bwrap was found${sb.reason ? ` (${sb.reason})` : ''} — refusing to launch unisolated`,
      code: sb.refuseCode ?? 'SANDBOX_UNAVAILABLE',
    });
    return true;
  }

  const sessionId = randomUUID();
  const client = new DebugClient(resolveNodeAdapterScript(), {
    spawnFn: adapterSpawnFn ?? undefined,
    requestTimeoutMs: 20000,
  });
  const session: DebugSession = {
    id: sessionId,
    name: cfg.name,
    request: cfg.request,
    adapter: cfg.adapter,
    client,
    createdAt: new Date().toISOString(),
    state: 'starting',
    output: [],
    outputSeq: 0,
  };
  client.on('stopped', (b) => {
    const body = b as { reason?: string; threadId?: number };
    session.state = 'paused';
    session.stopReason = body.reason;
    session.stopThreadId = body.threadId;
  });
  client.on('continued', () => {
    session.state = 'running';
    session.stopReason = undefined;
  });
  client.on('terminated', () => {
    session.state = 'terminated';
  });
  client.on('output', (b) => {
    const body = b as { category?: string; output?: string };
    session.outputSeq += 1;
    // R15 #6(f): the buffered output is returned verbatim by GET /output,
    // so secret-shaped values are redacted before buffering (runhistory /
    // quality-gate precedent). The primary fix is the scrubbed target env;
    // this only covers values the target prints from its own config.
    // V3R17 #6(h): ambient credential VALUES are redacted too —
    // redactText's key-shape matching is blind to a bare value.
    session.output.push({ seq: session.outputSeq, category: String(body.category ?? 'stdout'), output: redactAmbientCredentialValues(redactText(String(body.output ?? ''))) });
    if (session.output.length > MAX_OUTPUT_LINES) session.output.splice(0, session.output.length - MAX_OUTPUT_LINES);
  });

  let initialBreakpoints: { id: number; verified: boolean; line?: number; file: string }[] = [];
  try {
    await client.start();
    await client.initialize();
    if (cfg.request === 'launch') {
      const args: Record<string, unknown> = {
        program: cfg.program,
        args: cfg.args,
        stopOnEntry: cfg.stopOnEntry,
        env: cfg.env,
      };
      if (cfg.cwd) args.cwd = cfg.cwd;
      // V3R18 #6(m): the sandbox prefix for the debuggee spawn (only
      // present when the decision actually sandboxed the session).
      if (sb.prefix.length > 0) args.sandboxPrefix = sb.prefix;
      await withTimeout(client.launch(args), LAUNCH_TIMEOUT_MS, 'launch handshake timed out');
    } else {
      await withTimeout(
        client.attach({ port: cfg.port, address: '127.0.0.1' }),
        LAUNCH_TIMEOUT_MS,
        'attach handshake timed out',
      );
    }
    // Breakpoints up front, then configurationDone — the DAP-faithful order.
    // (The node adapter launches --inspect-brk internally, so breakpoints set
    // here are in place before the target runs a single line.)
    if (body.breakpoints !== undefined) {
      const byFile = parseAndJailBreakpoints(root, body.breakpoints);
      initialBreakpoints = await applyBreakpoints(root, client, byFile);
    }
    await client.configurationDone();
  } catch (e) {
    const err = mapDebugError(e);
    try {
      await client.stop();
    } catch {
      /* ignore */
    }
    ctx.json(res, err.status, { error: err.message, code: err.code });
    return true;
  }

  sessions.set(sessionId, session);
  session.state = 'running';
  ctx.audit.record('human', 'DEBUG_SESSION_STARTED', 'debug', sessionId, {
    projectId,
    name: cfg.name,
    request: cfg.request,
  });
  ctx.json(res, 201, {
    sessionId,
    name: cfg.name,
    request: cfg.request,
    state: session.state,
    createdAt: session.createdAt,
    breakpoints: initialBreakpoints,
  });
  return true;
}

function sessionSummary(s: DebugSession): Record<string, unknown> {
  return {
    sessionId: s.id,
    name: s.name,
    request: s.request,
    adapter: s.adapter,
    state: s.state,
    stopReason: s.stopReason,
    stopThreadId: s.stopThreadId,
    createdAt: s.createdAt,
    exited: s.client.exited,
  };
}

async function handleListSessions(_req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  sweepDead();
  ctx.json(res, 200, { sessions: [...sessions.values()].map(sessionSummary) });
  return true;
}

async function handleGetSession(req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext, id: string): Promise<boolean> {
  void req;
  void url;
  try {
    ctx.json(res, 200, { session: sessionSummary(getSession(id)) });
  } catch (e) {
    const err = mapDebugError(e);
    ctx.json(res, err.status, { error: err.message, code: err.code });
  }
  return true;
}

async function handleGetOutput(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext, id: string): Promise<boolean> {
  try {
    const s = getSession(id);
    const since = Number(url.searchParams.get('since') ?? '0');
    const lines = s.output.filter((l) => l.seq > since);
    ctx.json(res, 200, { lines, latestSeq: s.outputSeq });
  } catch (e) {
    const err = mapDebugError(e);
    ctx.json(res, err.status, { error: err.message, code: err.code });
  }
  return true;
}

interface BreakpointInput {
  file?: unknown;
  line?: unknown;
  column?: unknown;
  condition?: unknown;
  logMessage?: unknown;
}

/**
 * Validate + jail a breakpoint list; groups by absolute file path.
 * Shared by session start (breakpoints up front) and the /breakpoints route.
 */
function parseAndJailBreakpoints(
  root: string,
  rawList: unknown,
): Map<string, { line: number; column?: number; condition?: string; logMessage?: string }[]> {
  if (!Array.isArray(rawList)) {
    throw new DebugRouteError('breakpoints must be an array', 'bad-params');
  }
  const byFile = new Map<string, { line: number; column?: number; condition?: string; logMessage?: string }[]>();
  for (const raw of rawList as BreakpointInput[]) {
    const file = typeof raw.file === 'string' ? raw.file : '';
    const line = typeof raw.line === 'number' ? raw.line : NaN;
    if (!file || !Number.isFinite(line) || line < 1 || line > 1000000) {
      throw new DebugRouteError(`invalid breakpoint: file=${String(raw.file).slice(0, 60)} line=${String(raw.line)}`, 'bad-breakpoint');
    }
    const abs = jailFile(root, file, 'breakpoint file');
    const arr = byFile.get(abs) ?? [];
    const bp: { line: number; column?: number; condition?: string; logMessage?: string } = { line: Math.floor(line) };
    if (typeof raw.column === 'number' && raw.column >= 1) bp.column = Math.floor(raw.column);
    if (typeof raw.condition === 'string' && raw.condition) {
      // Parse-only syntax check (never executed): a syntactically invalid
      // condition is a 400 here, not a broken session later.
      const syntaxErr = validateConditionSyntax(raw.condition.slice(0, 2000));
      if (syntaxErr) {
        throw new DebugRouteError(`invalid breakpoint condition at ${file}:${Math.floor(line)}: ${syntaxErr}`, 'bad-breakpoint');
      }
      bp.condition = raw.condition.slice(0, 2000);
    }
    if (typeof raw.logMessage === 'string' && raw.logMessage) bp.logMessage = raw.logMessage.slice(0, 2000);
    arr.push(bp);
    byFile.set(abs, arr);
  }
  return byFile;
}

async function applyBreakpoints(
  root: string,
  client: DebugClient,
  byFile: Map<string, { line: number; column?: number; condition?: string; logMessage?: string }[]>,
): Promise<{ id: number; verified: boolean; line?: number; file: string; kind?: string }[]> {
  const out: { id: number; verified: boolean; line?: number; file: string; kind?: string }[] = [];
  for (const [abs, bps] of byFile) {
    const rel = abs.startsWith(root + sep) ? abs.slice(root.length + 1) : basename(abs);
    const dapBps = await client.setBreakpoints({ path: abs }, bps);
    // DAP preserves request order, so zip by index when lengths agree.
    for (let i = 0; i < dapBps.length; i += 1) {
      const b = dapBps[i];
      const kind = dapBps.length === bps.length ? classifyBreakpoint(bps[i]) : undefined;
      out.push({ id: b.id, verified: b.verified, line: b.line, file: rel, kind });
    }
  }
  return out;
}

async function handleSetBreakpoints(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, id: string): Promise<boolean> {
  const body = (await ctx.readBody(req)) as { breakpoints?: unknown; targetDir?: unknown };
  const s = getSession(id);
  let client: DebugClient;
  try {
    client = requireLive(s);
  } catch (e) {
    const err = mapDebugError(e);
    ctx.json(res, err.status, { error: err.message, code: err.code });
    return true;
  }
  if (!Array.isArray(body.breakpoints)) {
    ctx.json(res, 400, { error: 'breakpoints must be an array', code: 'bad-params' });
    return true;
  }
  const targetDir = typeof body.targetDir === 'string' ? body.targetDir : undefined;
  let root: string;
  try {
    root = resolveTargetDir(targetDir);
  } catch (e) {
    const err = e as DebugRouteError;
    ctx.json(res, err.status, { error: err.message, code: err.code });
    return true;
  }
  try {
    const byFile = parseAndJailBreakpoints(root, body.breakpoints);
    const out = await applyBreakpoints(root, client, byFile);
      ctx.audit.record('human', 'DEBUG_BREAKPOINTS_SET', 'debug', id, { count: out.length });
    ctx.json(res, 200, { breakpoints: out });
  } catch (e) {
    const err = mapDebugError(e);
    ctx.json(res, err.status, { error: err.message, code: err.code });
  }
  return true;
}

async function handleStepAction(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, id: string, action: string): Promise<boolean> {
  void req;
  const s = getSession(id);
  let client: DebugClient;
  try {
    client = requireLive(s);
  } catch (e) {
    const err = mapDebugError(e);
    ctx.json(res, err.status, { error: err.message, code: err.code });
    return true;
  }
  try {
    if (action === 'continue') await client.continue(1);
    else if (action === 'next') await client.next(1);
    else if (action === 'step-in') await client.stepIn(1);
    else if (action === 'step-out') await client.stepOut(1);
    else if (action === 'pause') await client.pause(1);
    else throw new DebugRouteError(`unknown step action: ${action}`, 'bad-action');
    ctx.json(res, 200, { ok: true });
  } catch (e) {
    const err = mapDebugError(e);
    ctx.json(res, err.status, { error: err.message, code: err.code });
  }
  return true;
}

async function handleStack(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext, id: string): Promise<boolean> {
  const s = getSession(id);
  try {
    const client = requireLive(s);
    const threadId = Number(url.searchParams.get('threadId') ?? '1');
    ctx.json(res, 200, await client.stackTrace(threadId));
  } catch (e) {
    const err = mapDebugError(e);
    ctx.json(res, err.status, { error: err.message, code: err.code });
  }
  return true;
}

async function handleScopes(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext, id: string): Promise<boolean> {
  const s = getSession(id);
  try {
    const client = requireLive(s);
    const frameId = Number(url.searchParams.get('frameId') ?? '1');
    if (!Number.isFinite(frameId) || frameId < 1) throw new DebugRouteError('frameId must be >= 1', 'bad-params');
    ctx.json(res, 200, { scopes: await client.scopes(frameId) });
  } catch (e) {
    const err = mapDebugError(e);
    ctx.json(res, err.status, { error: err.message, code: err.code });
  }
  return true;
}

async function handleVariables(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: RouteContext, id: string): Promise<boolean> {
  const s = getSession(id);
  try {
    const client = requireLive(s);
    const ref = Number(url.searchParams.get('ref') ?? '0');
    if (!Number.isFinite(ref) || ref < 1) throw new DebugRouteError('ref must be >= 1', 'bad-params');
    ctx.json(res, 200, { variables: await client.variables(ref) });
  } catch (e) {
    const err = mapDebugError(e);
    ctx.json(res, err.status, { error: err.message, code: err.code });
  }
  return true;
}

async function handleEvaluate(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, id: string): Promise<boolean> {
  const body = (await ctx.readBody(req)) as { expression?: unknown; frameId?: unknown; context?: unknown };
  const s = getSession(id);
  try {
    const client = requireLive(s);
    const expression = typeof body.expression === 'string' ? body.expression : '';
    if (!expression || expression.length > 10000) throw new DebugRouteError('expression is required (max 10000 chars)', 'bad-params');
    const frameId = typeof body.frameId === 'number' && body.frameId >= 1 ? Math.floor(body.frameId) : undefined;
    const context = typeof body.context === 'string' && ['repl', 'watch', 'hover'].includes(body.context) ? body.context : 'repl';
    // V3R17 #6(h): the evaluated value is returned verbatim to the API,
    // so ambient credential values are redacted from it before it
    // leaves the server.
    const evaluated = await client.evaluate(expression, { frameId, context });
    ctx.json(res, 200, { ...evaluated, result: redactAmbientCredentialValues(redactText(evaluated.result)) });
  } catch (e) {
    const err = mapDebugError(e);
    ctx.json(res, err.status, { error: err.message, code: err.code });
  }
  return true;
}

async function handleDeleteSession(_req: IncomingMessage, res: ServerResponse, ctx: RouteContext, id: string): Promise<boolean> {
  const s = sessions.get(id);
  if (!s) {
    ctx.json(res, 404, { error: 'unknown debug session', code: 'no-session' });
    return true;
  }
  sessions.delete(id);
  try {
    await s.client.stop();
  } catch {
    /* ignore */
  }
  ctx.audit.record('human', 'DEBUG_SESSION_STOPPED', 'debug', id, {});
  ctx.json(res, 200, { ok: true });
  return true;
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export async function handleDebugRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  try {
    if (method === 'GET' && path === `${PREFIX}/configs`) return await handleGetConfigs(req, res, url, ctx);
    if (method === 'GET' && path === `${PREFIX}/adapters`) return await handleGetAdapters(req, res, ctx);
    const probeMatch = /^\/api\/debug\/adapters\/([^/]+)\/probe$/.exec(path);
    if (method === 'POST' && probeMatch) return await handleProbeAdapter(req, res, ctx, decodeURIComponent(probeMatch[1]));
    if (method === 'POST' && path === `${PREFIX}/sessions`) return await handleStartSession(req, res, ctx);
    if (method === 'GET' && path === `${PREFIX}/sessions`) return await handleListSessions(req, res, ctx);

    const idMatch = /^\/api\/debug\/sessions\/([0-9a-f-]+)(\/.*)?$/.exec(path);
    if (idMatch) {
      const id = idMatch[1];
      const rest = idMatch[2] ?? '';
      if (method === 'GET' && rest === '') return await handleGetSession(req, res, url, ctx, id);
      if (method === 'GET' && rest === '/output') return await handleGetOutput(req, res, url, ctx, id);
      if (method === 'POST' && rest === '/breakpoints') return await handleSetBreakpoints(req, res, ctx, id);
      if (method === 'POST' && ['/continue', '/next', '/step-in', '/step-out', '/pause'].includes(rest)) {
        return await handleStepAction(req, res, ctx, id, rest.slice(1));
      }
      if (method === 'GET' && rest === '/stack') return await handleStack(req, res, url, ctx, id);
      if (method === 'GET' && rest === '/scopes') return await handleScopes(req, res, url, ctx, id);
      if (method === 'GET' && rest === '/variables') return await handleVariables(req, res, url, ctx, id);
      if (method === 'POST' && rest === '/evaluate') return await handleEvaluate(req, res, ctx, id);
      if (method === 'DELETE' && rest === '') return await handleDeleteSession(req, res, ctx, id);
    }
  } catch (e) {
    const err = mapDebugError(e);
    ctx.json(res, err.status, { error: err.message, code: err.code });
    return true;
  }

  ctx.json(res, 404, { error: 'unknown debug route', code: 'not-found' });
  return true;
}

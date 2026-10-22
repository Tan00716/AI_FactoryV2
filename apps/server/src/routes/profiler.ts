/**
 * Performance profiling routes (round-4 task R4-A7).
 *
 *   POST /api/profiler/cpu    {script, args?, timeoutMs?, sampleIntervalUs?}
 *                             → 200 CpuProfileResult {hotspots[10], flame tree,
 *                                 sampleCount, totalUs, durationMs (real)}
 *   POST /api/profiler/heap   {script, args?, timeoutMs?}
 *                             → 200 HeapSummary {totalBytes, nodeCount,
 *                                 top[10] constructors, durationMs (real)}
 *
 * Both endpoints spawn the jailed script in a child `node` process:
 *  - CPU: native `--cpu-prof` V8 sampling; the .cpuprofile is parsed into
 *    hotspots + a folded flame tree. Real samples — no synthetic data.
 *  - Heap: `--require` preload writes a real `v8.writeHeapSnapshot()` on
 *    process exit; parsed for per-constructor count / self-size aggregates.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleProfilerRoutes, setProfilerInspectionRootResolver } from './routes/profiler';
 *   if (await handleProfilerRoutes(req, res, url, routeCtx)) return;
 *   setProfilerInspectionRootResolver((root) => resolveInspectionRoot(root));
 *
 * RBAC: the default prefix rule in auth.ts (requiredRoleFor) gives GET →
 * viewer and every other method → operator for this prefix — no auth.ts
 * change needed.
 *
 * Audit: PROFILER_CPU_CAPTURED / PROFILER_HEAP_CAPTURED.
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - "Retained size" per constructor is NOT computed (dominator tree too
 *    costly); the heap table reports self size and says so.
 *  - --cpu-prof flushes only on natural exit: a script killed by the
 *    timeout yields no profile (fail-closed 'no-profile'), never partial data.
 *  - Sampling is statistical; sampleCount/totalUs are reported so the user
 *    can judge significance.
 *  - The heap script must terminate on its own (snapshot is written on
 *    process exit); long-running servers will hit the timeout (max 120s).
 */
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RouteContext } from './context';
import {
  captureCpuProfile,
  captureHeapSnapshot,
  ProfilerError,
} from '@ai-factory/profiler';

const PREFIX = '/api/profiler';
const SCRIPT_EXTS = new Set(['.js', '.mjs', '.cjs']);
const MAX_TIMEOUT_MS = 120000;

class ProfilerRouteError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'ProfilerRouteError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Inspection-root resolver, injected by the coordinator (setter-injection
 * pattern: routes/profiler must not value-import ../inspections, so that
 * direct type-stripping tests keep working — AGENTS.md dual-mode rule).
 */
let inspectionRootResolver: ((root?: string) => string) | null = null;

export function setProfilerInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  inspectionRootResolver = fn;
}

function targetRoot(): string {
  if (!inspectionRootResolver) {
    throw new ProfilerRouteError('inspection root resolver is not wired', 'not-wired', 500);
  }
  try {
    return inspectionRootResolver(undefined);
  } catch (e) {
    throw new ProfilerRouteError((e as Error).message, 'bad-root');
  }
}

function strField(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > maxLen) return null;
  return s;
}

/** Jail a requested relative script path to the target dir; fail-closed. */
function jailScript(root: string, file: string): string {
  const abs = resolve(root, file);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new ProfilerRouteError(`script escapes the target dir: ${file}`, 'jail', 403);
  }
  const lower = abs.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  if (!SCRIPT_EXTS.has(ext)) {
    throw new ProfilerRouteError(
      `only .js/.mjs/.cjs scripts can be profiled, got: ${file}`,
      'bad-ext',
    );
  }
  if (!existsSync(abs)) {
    throw new ProfilerRouteError(`script does not exist: ${file}`, 'not-found', 404);
  }
  return abs;
}

function clampTimeout(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 60000;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1000, n));
}

function clampInterval(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 1000;
  return Math.min(1000000, Math.max(100, n));
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string').slice(0, 32);
}

export async function handleProfilerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  try {
    if (method === 'POST' && path === `${PREFIX}/cpu`) {
      const body = (await ctx.readBody(req)) as Record<string, unknown>;
      const script = strField(body.script, 512);
      if (!script) throw new ProfilerRouteError('body.script is required', 'bad-script');
      const root = targetRoot();
      const abs = jailScript(root, script);
      try {
        const result = await captureCpuProfile({
          scriptPath: abs,
          args: strArray(body.args),
          cwd: root,
          timeoutMs: clampTimeout(body.timeoutMs),
          sampleIntervalUs: clampInterval(body.sampleIntervalUs),
        });
        ctx.audit.record('human', 'PROFILER_CPU_CAPTURED', 'profiler', script, {
          samples: result.sampleCount,
          durationMs: result.durationMs,
        });
        ctx.json(res, 200, result);
      } catch (e) {
        if (e instanceof ProfilerError) {
          ctx.json(res, 400, { error: e.message, code: e.code });
        } else {
          throw e;
        }
      }
      return true;
    }

    if (method === 'POST' && path === `${PREFIX}/heap`) {
      const body = (await ctx.readBody(req)) as Record<string, unknown>;
      const script = strField(body.script, 512);
      if (!script) throw new ProfilerRouteError('body.script is required', 'bad-script');
      const root = targetRoot();
      const abs = jailScript(root, script);
      try {
        const result = await captureHeapSnapshot({
          scriptPath: abs,
          args: strArray(body.args),
          cwd: root,
          timeoutMs: clampTimeout(body.timeoutMs),
        });
        ctx.audit.record('human', 'PROFILER_HEAP_CAPTURED', 'profiler', script, {
          totalBytes: result.totalBytes,
          durationMs: result.durationMs,
        });
        ctx.json(res, 200, result);
      } catch (e) {
        if (e instanceof ProfilerError) {
          ctx.json(res, 400, { error: e.message, code: e.code });
        } else {
          throw e;
        }
      }
      return true;
    }
  } catch (e) {
    const err = e as ProfilerRouteError;
    ctx.json(res, err.status ?? 400, { error: err.message, code: err.code ?? 'profiler-error' });
    return true;
  }

  ctx.json(res, 404, { error: 'unknown profiler route', code: 'not-found' });
  return true;
}

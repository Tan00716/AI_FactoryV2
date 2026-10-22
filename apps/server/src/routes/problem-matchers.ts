/**
 * Problem matchers — HTTP surface (task ③).
 *
 *   GET  /api/problem-matchers?projectId=          config + builtin metas (viewer)
 *   PUT  /api/problem-matchers                     replace project config (operator)
 *   POST /api/problem-matchers/test                dry-run parse — nothing stored (operator)
 *   GET  /api/problem-matchers/diagnostics?projectId=&source=   stored diagnostics (viewer)
 *   POST /api/problem-matchers/collect             parse text/terminal/quality/scheduler output → store (operator)
 *   POST /api/problem-matchers/clear               drop a project's diagnostics (operator)
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps GET →
 * viewer and everything else → operator by default. No auth.ts change.
 *
 * Ingestion wiring (installed once from index.ts):
 *  - Quality gate: routes/quality.ts exposes setQualityGateOutputSink;
 *    this module installs a sink that parses every gate run's output
 *    automatically (source 'quality-gate').
 *  - Terminal / scheduler: their session/job state lives in other route
 *    modules that must not be value-imported from here (dual-mode import
 *    rule), so index.ts injects readers via setProblemMatcherDeps —
 *    the same setter-injection pattern as the context providers.
 *  - Manual text: POST /collect with { text } parses anything the
 *    operator pastes (source 'manual'), and POST /test dry-runs without
 *    storing.
 *
 * Honest boundaries (see also ../problem-matchers.ts):
 *  - Parse stats (match rate) are returned with every parse and stored
 *    per source; a low rate means "unparsed prose", never "no issues".
 *  - Collected terminal/scheduler output is a snapshot of what the dep
 *    reader returns right now; closed terminal sessions are gone.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BUILTIN_MATCHERS,
  ProblemMatcherConfigError,
  builtinMatcher,
  parseOutput,
  parseAndStoreProblems,
  problemDiagnosticsStore,
  problemMatcherStore,
  resolveMatchers,
  validateMatcherDef,
  type ProblemMatcherDef,
  type ProblemSource,
  type ProblemMatcherConfig,
} from '../problem-matchers';
import type { RouteContext } from './context';

const PREFIX = '/api/problem-matchers';

export interface ProblemMatcherDeps {
  /** Tail of a terminal session transcript (routes/terminal.ts). */
  terminalTail(
    sessionId: string | null,
    maxLines: number,
  ): { found: boolean; sessionId?: string; text?: string; note?: string };
  /** Scheduler jobs' latest recorded outputs (routes/schedules.ts). */
  schedulerOutputs(): Array<{
    scheduleId: string;
    title: string;
    lastOutput: string | null;
    lastRunAt: string | null;
  }>;
}

let deps: ProblemMatcherDeps | null = null;

/** Installed once by index.ts at boot. */
export function setProblemMatcherDeps(d: ProblemMatcherDeps | null): void {
  deps = d;
}

function projectIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > 128) return null;
  return id;
}

function sourceOf(value: unknown): ProblemSource | null {
  return value === 'terminal' ||
    value === 'quality-gate' ||
    value === 'scheduler' ||
    value === 'manual' ||
    value === 'tasks'
    ? (value as ProblemSource)
    : null;
}

function matcherMeta(m: ProblemMatcherDef): Record<string, unknown> {
  return {
    name: m.name,
    description: m.description,
    builtin: m.builtin === true,
    patterns: m.patterns.map((p) => ({
      regexp: p.regexp,
      file: p.file,
      line: p.line,
      ...(p.column !== undefined ? { column: p.column } : {}),
      ...(p.severity !== undefined ? { severity: p.severity } : {}),
      ...(p.message !== undefined ? { message: p.message } : {}),
      ...(p.loop ? { loop: true } : {}),
      ...(p.continuation ? { continuation: p.continuation } : {}),
    })),
  };
}

export async function handleProblemMatcherRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/problem-matchers?projectId= — config + builtin/custom metas.
  if (method === 'GET' && path === PREFIX) {
    const projectId = projectIdOf(url.searchParams.get('projectId')) ?? '__global__';
    try {
      const cfg = problemMatcherStore().get(projectId);
      ctx.json(res, 200, {
        projectId,
        enabled: cfg.enabled,
        customs: Object.values(cfg.customs).map(matcherMeta),
        builtins: BUILTIN_MATCHERS.map(matcherMeta),
        active: resolveMatchers(projectId).map((m) => m.name),
      });
    } catch (e) {
      if (e instanceof ProblemMatcherConfigError) {
        ctx.json(res, 500, {
          error: 'problem matcher store is corrupt; fix or remove the file, then retry',
          code: 'PROBLEM_MATCHER_STORE_CORRUPT',
        });
        return true;
      }
      throw e;
    }
    return true;
  }

  // PUT /api/problem-matchers — replace a project's matcher config.
  if (method === 'PUT' && path === PREFIX) {
    const body = await ctx.readBody(req);
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    const enabledRaw = body['enabled'];
    if (!Array.isArray(enabledRaw) || enabledRaw.some((x) => typeof x !== 'string')) {
      ctx.json(res, 400, { error: 'enabled must be an array of matcher names' });
      return true;
    }
    const enabled = enabledRaw as string[];
    if (enabled.length > 32) {
      ctx.json(res, 400, { error: 'at most 32 matchers may be enabled' });
      return true;
    }
    const customsRaw = body['customs'];
    const errors: string[] = [];
    const customs: ProblemMatcherConfig['customs'] = {};
    if (customsRaw !== undefined) {
      if (!customsRaw || typeof customsRaw !== 'object' || Array.isArray(customsRaw)) {
        ctx.json(res, 400, { error: 'customs must be an object keyed by matcher name' });
        return true;
      }
      for (const [name, def] of Object.entries(customsRaw as Record<string, unknown>)) {
        const v = validateMatcherDef(name, def);
        if (v.def) customs[name] = v.def;
        else errors.push(...v.errors.map((e) => `${name}: ${e}`));
      }
    }
    for (const name of enabled) {
      if (!customs[name] && !builtinMatcher(name)) {
        errors.push(`enabled matcher "${name}" is neither a builtin nor a defined custom`);
      }
    }
    if (errors.length > 0) {
      ctx.json(res, 400, { error: `invalid problem matcher config: ${errors.join('; ')}` });
      return true;
    }
    try {
      const saved = problemMatcherStore().set(projectId, { enabled, customs });
      ctx.audit.record('human', 'PROBLEM_MATCHERS_UPDATED', 'problem-matchers', projectId, {
        enabled: saved.enabled,
        customs: Object.keys(saved.customs),
      });
      ctx.json(res, 200, { ok: true, projectId, enabled: saved.enabled, customs: Object.keys(saved.customs) });
    } catch (e) {
      if (e instanceof ProblemMatcherConfigError) {
        ctx.json(res, 500, {
          error: 'problem matcher store is corrupt; fix or remove the file, then retry',
          code: 'PROBLEM_MATCHER_STORE_CORRUPT',
        });
        return true;
      }
      throw e;
    }
    return true;
  }

  // POST /api/problem-matchers/test — dry-run: parse, never store.
  if (method === 'POST' && path === `${PREFIX}/test`) {
    const body = await ctx.readBody(req);
    const text = body['text'];
    if (typeof text !== 'string') {
      ctx.json(res, 400, { error: 'text is required' });
      return true;
    }
    if (text.length > 1024 * 1024) {
      ctx.json(res, 400, { error: 'text is too large (max 1MB)' });
      return true;
    }
    const projectId = projectIdOf(body['projectId']) ?? '__global__';
    let matchers: ProblemMatcherDef[];
    const only = typeof body['matcher'] === 'string' ? body['matcher'] : null;
    if (only) {
      try {
        const cfg = problemMatcherStore().get(projectId);
        const def = cfg.customs[only] ?? builtinMatcher(only);
        if (!def) {
          ctx.json(res, 400, { error: `unknown matcher: ${only}` });
          return true;
        }
        matchers = [def];
      } catch (e) {
        if (e instanceof ProblemMatcherConfigError) {
          ctx.json(res, 500, { error: 'problem matcher store is corrupt', code: 'PROBLEM_MATCHER_STORE_CORRUPT' });
          return true;
        }
        throw e;
      }
    } else {
      matchers = resolveMatchers(projectId);
    }
    const source = sourceOf(body['source']) ?? 'manual';
    const { diagnostics, stats } = parseOutput(text, matchers, source);
    ctx.json(res, 200, { diagnostics, stats, dryRun: true });
    return true;
  }

  // GET /api/problem-matchers/diagnostics?projectId=&source= — stored snapshot.
  if (method === 'GET' && path === `${PREFIX}/diagnostics`) {
    const projectId = projectIdOf(url.searchParams.get('projectId'));
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId query parameter is required' });
      return true;
    }
    const sourceParam = url.searchParams.get('source');
    let source: ProblemSource | undefined;
    if (sourceParam) {
      const s = sourceOf(sourceParam);
      if (!s) {
        ctx.json(res, 400, { error: 'source must be terminal|quality-gate|scheduler|manual|tasks' });
        return true;
      }
      source = s;
    }
    const view = problemDiagnosticsStore.list(projectId, source);
    ctx.json(res, 200, {
      projectId,
      diagnostics: view.diagnostics,
      lastStats: view.lastStats,
      evicted: view.evicted,
    });
    return true;
  }

  // POST /api/problem-matchers/collect — parse output from a source and store it.
  if (method === 'POST' && path === `${PREFIX}/collect`) {
    const body = await ctx.readBody(req);
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    const source = sourceOf(body['source']);
    if (!source) {
      ctx.json(res, 400, { error: 'source must be terminal|quality-gate|scheduler|manual|tasks' });
      return true;
    }
    let text: string | null = null;
    let origin = '';
    if (typeof body['text'] === 'string') {
      text = body['text'] as string;
      if (text.length > 1024 * 1024) {
        ctx.json(res, 400, { error: 'text is too large (max 1MB)' });
        return true;
      }
      origin = 'inline text';
    } else if (source === 'terminal') {
      if (!deps) {
        ctx.json(res, 503, { error: 'terminal ingestion is not wired in this process' });
        return true;
      }
      const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : null;
      const lines =
        typeof body['lines'] === 'number' && Number.isFinite(body['lines'])
          ? Math.min(2000, Math.max(1, Math.floor(body['lines'] as number)))
          : 500;
      const tail = deps.terminalTail(sessionId, lines);
      if (!tail.found) {
        ctx.json(res, 404, { error: 'TERMINAL_UNAVAILABLE', detail: tail.note ?? 'no terminal output available' });
        return true;
      }
      text = tail.text ?? '';
      text = stripAnsi(text);
      origin = `terminal session ${tail.sessionId} (tail ${lines} lines)`;
    } else if (source === 'scheduler') {
      if (!deps) {
        ctx.json(res, 503, { error: 'scheduler ingestion is not wired in this process' });
        return true;
      }
      const scheduleId = typeof body['scheduleId'] === 'string' ? body['scheduleId'] : null;
      const outs = deps.schedulerOutputs().filter((o) => o.lastOutput !== null);
      const pick = scheduleId ? outs.find((o) => o.scheduleId === scheduleId) : outs[0];
      if (!pick) {
        ctx.json(res, 404, { error: 'SCHEDULER_UNAVAILABLE', detail: 'no scheduler job has recorded output yet' });
        return true;
      }
      text = pick.lastOutput ?? '';
      origin = `scheduler job ${pick.scheduleId} (${pick.title}) last run ${pick.lastRunAt}`;
    } else {
      ctx.json(res, 400, { error: 'text is required for this source' });
      return true;
    }
    const result = parseAndStoreProblems(projectId, source, text);
    ctx.audit.record('human', 'PROBLEM_MATCHER_PARSED', 'problem-matchers', projectId, {
      source,
      origin,
      added: result.added,
      total: result.total,
      lines: result.stats.lines,
      matchedLines: result.stats.matchedLines,
      matchRate: result.stats.matchRate,
      truncated: result.stats.truncated,
    });
    const view = problemDiagnosticsStore.list(projectId, source);
    ctx.json(res, 200, {
      ok: true,
      projectId,
      source,
      origin,
      added: result.added,
      total: result.total,
      stats: result.stats,
      diagnostics: view.diagnostics,
    });
    return true;
  }

  // POST /api/problem-matchers/clear — drop stored diagnostics for a project.
  if (method === 'POST' && path === `${PREFIX}/clear`) {
    const body = await ctx.readBody(req);
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    problemDiagnosticsStore.clear(projectId);
    ctx.audit.record('human', 'PROBLEM_MATCHERS_CLEARED', 'problem-matchers', projectId, {});
    ctx.json(res, 200, { ok: true, projectId });
    return true;
  }

  return false;
}

/**
 * Quality-gate auto-parse sink (installed via routes/quality.ts's
 * setQualityGateOutputSink from index.ts): every gate run's stdout +
 * stderr is parsed with the project's matchers and stored with source
 * 'quality-gate'. Best-effort by construction — parseAndStoreProblems
 * never throws on bad output, and the caller swallows anyway.
 */
export function qualityGateOutputSink(projectId: string, _kind: string, stdout: string, stderr: string): void {
  parseAndStoreProblems(projectId, 'quality-gate', `${stdout}\n${stderr}`);
}

/**
 * Strip ANSI escape sequences from terminal transcripts before parsing.
 * Terminal output is the one source that routinely carries color/paste
 * control codes; leaving them in guarantees misfires (e.g. a `[?2004h`
 * prefix gluing onto a captured file path). Quality-gate and scheduler
 * output is parsed verbatim — what the command wrote is what we match.
 */
export function stripAnsi(text: string): string {
  // Bare carriage returns (xterm reflow) glue onto line starts and
  // defeat ^-anchored patterns, so they are removed as well.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g, '').replace(/\r/g, '');
}

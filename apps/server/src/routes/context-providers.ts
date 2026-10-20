/**
 * Deterministic @-context providers — HTTP surface (task ⑥).
 *
 *   GET  /api/context-providers               list provider metadata (viewer)
 *   POST /api/context-providers/resolve        dry-run: resolve @refs in text (operator)
 *   POST /api/context-providers/open-files     register the desktop's open files (operator)
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps GET → viewer
 * and POST → operator. No auth.ts change.
 *
 * This module also assembles the ProviderDeps for the host process and
 * installs the run-creation resolver on the runtime routes
 * (initRuntimeContextResolution, called once from index.ts) — the same
 * setter-injection pattern as setRuntimeCodeIndexService, because
 * routes/runtime.ts is imported straight from src by server tests and
 * must not value-import siblings (dual-mode import rule).
 *
 * Honest boundaries (see also ../context-providers.ts):
 *  - @problems only reports quality-gate history that actually exists.
 *  - @terminal only reads live in-process sessions.
 *  - @open only lists registered files, never guesses.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CONTEXT_PROVIDER_METAS,
  ContextProviderError,
  resolveContextRefs,
  resolveJailedRoot,
  type ProviderDeps,
  type QualityProblem,
  type ResolvedContext,
} from '../context-providers';
// 第三波任务⑥在途：commands.ts 从本模块导入 CONTEXT_PROVIDER_METAS，
// 此处补 re-export（drive-by，任务⑩，收口人知悉）。
export { CONTEXT_PROVIDER_METAS };
import { setRuntimeContextResolver } from './runtime';
import { getTerminalTailForContext } from './terminal';
import { qualityGateStore } from './quality';

const PREFIX = '/api/context-providers';

/** Files the desktop client registered as open (process-local, like terminal sessions). */
let registeredOpenFiles: string[] = [];

/** Test seam: replace the registry. */
export function setRegisteredOpenFiles(files: string[]): void {
  registeredOpenFiles = [...files];
}

function defaultDeps(): ProviderDeps {
  return {
    workspaceRoot: () => {
      try {
        return resolveJailedRoot(null);
      } catch {
        return null;
      }
    },
    terminalTail: (sessionId, maxLines) => getTerminalTailForContext(sessionId, maxLines),
    qualityProblems: (projectId) => {
      const out: QualityProblem[] = [];
      if (!projectId) return out;
      let lastRun: Record<string, { kind: string; ok: boolean; exitCode: number | null; timedOut: boolean; durationMs: number; at: string } | null>;
      try {
        lastRun = qualityGateStore().getLastRun(projectId) as typeof lastRun;
      } catch {
        return out;
      }
      for (const kind of Object.keys(lastRun)) {
        const r = lastRun[kind];
        if (!r) continue;
        out.push({
          source: 'quality-gate',
          kind: r.kind,
          ok: r.ok,
          detail:
            `exit ${r.exitCode === null ? 'n/a' : r.exitCode}` +
            (r.timedOut ? ' (timed out)' : '') +
            `, ${r.durationMs}ms`,
          at: r.at,
        });
      }
      return out;
    },
    openFiles: () => [...registeredOpenFiles],
  };
}

export interface RunContextResolution {
  texts: string[];
  projectId: string | null;
}

export type RunContextOutcome =
  | { ok: true; texts: string[]; resolved: ResolvedContext[] }
  | { ok: false; error: string; code: string };

/**
 * Coordinator wiring (index.ts, once at boot): run creation resolves
 * @-references through this process's providers. Installed here — not
 * in routes/runtime.ts — because that module is src-imported by tests.
 */
export function initRuntimeContextResolution(): void {
  setRuntimeContextResolver(async ({ texts, projectId }: RunContextResolution): Promise<RunContextOutcome> => {
    try {
      const deps = defaultDeps();
      const outTexts: string[] = [];
      const allResolved: ResolvedContext[] = [];
      for (const t of texts) {
        const r = resolveContextRefs(t, { deps, projectId });
        outTexts.push(r.text);
        allResolved.push(...r.resolved);
      }
      return { ok: true, texts: outTexts, resolved: allResolved };
    } catch (e) {
      if (e instanceof ContextProviderError) {
        return { ok: false, error: e.message, code: e.code };
      }
      throw e;
    }
  });
}

function contextError(
  res: ServerResponse,
  ctx: Pick<import('./context').RouteContext, 'json'>,
  err: unknown,
): boolean {
  if (err instanceof ContextProviderError) {
    const status = err.code === 'ROOT_DENIED' ? 403 : 400;
    ctx.json(res, status, { error: err.code, detail: err.message });
    return true;
  }
  ctx.json(res, 500, { error: 'context provider failed', detail: err instanceof Error ? err.message : String(err) });
  return true;
}

export async function handleContextProviderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: import('./context').RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/context-providers — provider metadata for the @-mention UI.
  if (method === 'GET' && path === PREFIX) {
    ctx.json(res, 200, { providers: CONTEXT_PROVIDER_METAS });
    return true;
  }

  // POST /api/context-providers/resolve — dry-run: resolve @refs in text.
  if (method === 'POST' && path === `${PREFIX}/resolve`) {
    const b = await ctx.readBody(req);
    const text = b['text'];
    if (typeof text !== 'string') {
      ctx.json(res, 400, { error: 'text is required' });
      return true;
    }
    const projectId = typeof b['projectId'] === 'string' ? b['projectId'] : null;
    try {
      const r = resolveContextRefs(text, { deps: defaultDeps(), projectId });
      ctx.audit.record('human', 'CONTEXT_PROVIDER_PREVIEWED', 'context', '-', {
        refs: r.resolved.map((c) => ({ provider: c.provider, arg: c.arg })),
        projectId,
      });
      ctx.json(res, 200, { text: r.text, resolved: r.resolved });
    } catch (e) {
      return contextError(res, ctx, e);
    }
    return true;
  }

  // POST /api/context-providers/open-files — register the desktop's open files.
  if (method === 'POST' && path === `${PREFIX}/open-files`) {
    const b = await ctx.readBody(req);
    const files = b['files'];
    if (!Array.isArray(files) || files.some((f) => typeof f !== 'string')) {
      ctx.json(res, 400, { error: 'files must be an array of strings' });
      return true;
    }
    if (files.length > 100) {
      ctx.json(res, 400, { error: 'at most 100 open files may be registered' });
      return true;
    }
    for (const f of files) {
      if ((f as string).length > 1024) {
        ctx.json(res, 400, { error: 'an open-file path exceeds 1024 characters' });
        return true;
      }
    }
    registeredOpenFiles = (files as string[]).map((f) => f.trim()).filter(Boolean);
    ctx.audit.record('human', 'CONTEXT_OPEN_FILES_REGISTERED', 'context', '-', {
      count: registeredOpenFiles.length,
    });
    ctx.json(res, 200, { ok: true, count: registeredOpenFiles.length });
    return true;
  }

  return false;
}

/**
 * User-initiated diagnostics bundle export (V3-#10).
 *
 *   GET  /api/diagnostics/preview   what an export would contain (viewer)
 *   POST /api/diagnostics/export    { confirm: true } -> { bundle }
 *                                   (operator; audited DIAGNOSTICS_EXPORTED)
 *
 * The preview lists includes/excludes WITHOUT building a bundle; the
 * export builds one only after explicit confirm, runs the bundle
 * self-check, and refuses (409) if any secret pattern survives.
 *
 * Privacy shape (enforced by @ai-factory/diagpack, not by this file):
 * - audit records contribute counts + stripped fields only; `details`
 *   payloads are never read into a bundle;
 * - task evidence is counts only (no titles, no file contents);
 * - config is modes and counts only (auth mode, egress summary);
 * - environment variable names and values are never included;
 * - nothing is uploaded anywhere: the bundle is returned to the caller,
 *   who decides what to do with it. No telemetry, no auto-reporting.
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps GET ->
 * viewer and POST -> operator for this prefix — no auth.ts change.
 *
 * Wiring: the coordinator (index.ts) injects the config provider
 * (auth mode + egress summary, both already public to viewers via
 * /api/auth/whoami and /api/egress/config) and the baseline loader.
 * Unwired, both degrade to honest "unavailable" sections, never to
 * invented values. The baseline loader defaults to the
 * FACTORY_PERFBENCH_BASELINE file (V3-#4 baseline.json) and reports
 * unavailable when the file is missing or unparsable.
 *
 * Dual-mode: value imports are node builtins + @ai-factory/* packages
 * only, so tests may import this module from src with an explicit `.ts`
 * suffix; the HTTP tests boot the real dist server instead.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildBundle,
  isErrorShaped,
  previewManifest,
  type AuditSummaryRecord,
  type ConfigSnapshot,
  type PerfBaselineSummary,
} from '@ai-factory/diagpack';
import type { RouteContext } from './context';

const PREVIEW_PATH = '/api/diagnostics/preview';
const EXPORT_PATH = '/api/diagnostics/export';

export const DIAGNOSTICS_EXPORTED_ACTION = 'DIAGNOSTICS_EXPORTED';

const RECENT_LIMIT = 20;
const ERROR_LIMIT = 50;

/** Config provider: coordinator-injected, defaults to honest unknown. */
let configProvider: () => ConfigSnapshot = () => ({
  authMode: 'unknown',
  egress: null,
  egressUnavailableReason: 'diagnostics config provider unwired',
});

export function setDiagnosticsConfigProvider(fn: () => ConfigSnapshot): void {
  configProvider = fn;
}

/** Baseline loader: coordinator-injected, defaults to the env file. */
let baselineLoader: () => PerfBaselineSummary = () => loadBaselineFromEnv();

export function setDiagnosticsBaselineLoader(fn: () => PerfBaselineSummary): void {
  baselineLoader = fn;
}

function loadBaselineFromEnv(): PerfBaselineSummary {
  const path = process.env['FACTORY_PERFBENCH_BASELINE'];
  if (!path) {
    return { available: false, reason: 'FACTORY_PERFBENCH_BASELINE is not set', tasks: [], taskCount: 0 };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const tasks = Array.isArray((parsed as { tasks?: unknown }).tasks)
      ? ((parsed as { tasks: unknown[] }).tasks as Array<Record<string, unknown>>)
      : [];
    const summary = tasks
      .filter((t) => typeof t['name'] === 'string')
      .map((t) => ({
        name: t['name'] as string,
        ms: typeof t['ms'] === 'number' ? t['ms'] : null,
      }));
    return { available: true, reason: null, tasks: summary, taskCount: summary.length };
  } catch (e) {
    return { available: false, reason: `baseline file unreadable: ${(e as Error).message}`, tasks: [], taskCount: 0 };
  }
}

function stripAuditRecords(ctx: RouteContext): AuditSummaryRecord[] {
  return ctx.audit.list().map((r) => ({
    id: r.id,
    ts: r.ts,
    actor: r.actor,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    result: r.result ?? null,
  }));
}

function gatherPreview(ctx: RouteContext): ReturnType<typeof previewManifest> {
  const records = stripAuditRecords(ctx);
  const tasks = ctx.tasks.list();
  return previewManifest({
    auditTotal: records.length,
    taskCount: tasks.length,
    projectCount: ctx.fdb.listProjects().length,
    perfAvailable: baselineLoader().available,
    errorCount: records.filter(isErrorShaped).length,
  });
}

function gatherBundle(ctx: RouteContext): ReturnType<typeof buildBundle> {
  const records = stripAuditRecords(ctx);
  const tasks = ctx.tasks.list();
  const byStatus = new Map<string, number>();
  for (const t of tasks) {
    const s = typeof t.status === 'string' && t.status ? t.status : 'unknown';
    byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
  }
  return buildBundle({
    meta: {
      bundleId: randomUUID(),
      exportedAt: new Date().toISOString(),
      appVersion: '0.2.0',
      serverVersion: '0.1.0',
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },
    auditRecords: records,
    auditTotal: records.length,
    taskEvidence: {
      projectCount: ctx.fdb.listProjects().length,
      taskCount: tasks.length,
      byStatus: [...byStatus.entries()]
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count),
    },
    configSnapshot: configProvider(),
    perfBaseline: baselineLoader(),
    recentLimit: RECENT_LIMIT,
    errorLimit: ERROR_LIMIT,
  });
}

export async function handleDiagnosticsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  try {
    if (path === PREVIEW_PATH && method === 'GET') {
      ctx.json(res, 200, gatherPreview(ctx));
      return true;
    }
    if (path === EXPORT_PATH && method === 'POST') {
      const body = await ctx.readBody(req);
      if (body['confirm'] !== true) {
        ctx.json(res, 400, {
          error: 'export requires explicit confirm: { confirm: true } (preview first at GET /api/diagnostics/preview)',
          code: 'DIAGNOSTICS_CONFIRM_REQUIRED',
        });
        return true;
      }
      let bundle: ReturnType<typeof buildBundle>;
      try {
        bundle = gatherBundle(ctx);
      } catch (e) {
        // Self-check failure: refuse, audit the refusal, ship nothing.
        ctx.audit.record('human', DIAGNOSTICS_EXPORTED_ACTION, 'diagnostics', 'refused', {
          reason: 'self-check failed',
          detail: (e as Error).message,
        });
        ctx.json(res, 409, { error: (e as Error).message, code: 'DIAGNOSTICS_SELF_CHECK_FAILED' });
        return true;
      }
      ctx.audit.record('human', DIAGNOSTICS_EXPORTED_ACTION, 'diagnostics', bundle.meta.bundleId, {
        bundleId: bundle.meta.bundleId,
        role: ctx.callerRole ?? 'unknown',
        auditRecords: bundle.auditSummary.totalRecords,
        taskCount: bundle.taskEvidence.taskCount,
        sections: ['meta', 'privacy', 'auditSummary', 'taskEvidence', 'configSnapshot', 'errorExcerpt', 'perfBaseline'],
      });
      ctx.json(res, 200, { bundle });
      return true;
    }
  } catch (e) {
    ctx.json(res, 500, { error: (e as Error).message, code: 'DIAGNOSTICS_FAILED' });
    return true;
  }
  return false;
}

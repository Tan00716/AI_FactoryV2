/**
 * Coverage routes — operator surface for test coverage visualization
 * (apps/server/src/coverage.ts).
 *
 *   GET  /api/coverage/summary?projectId=   latest summary + history (viewer)
 *   GET  /api/coverage/files?projectId=     per-file coverage list (viewer)
 *   GET  /api/coverage/file?projectId=&path= line-level hit map (viewer)
 *   POST /api/coverage/import               {projectId, reportPath, format?}
 *                                           — parse + store a report now
 *                                           (operator)
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) gives GET →
 * viewer and every other method → operator for this prefix — no
 * auth.ts change needed.
 *
 * Audit: QUALITY_GATE_COVERAGE_IMPORTED (manual import); the quality
 * gate itself records QUALITY_GATE_COVERAGE_PARSED /
 * QUALITY_GATE_COVERAGE_FAILED / QUALITY_GATE_COVERAGE_BLOCKED
 * (routes/quality.ts) when a test run produces a report.
 *
 * Honest boundary (mirrors coverage.ts): importing only reads the
 * project's own report file — we never instrument and never run
 * tests. The report path must sit inside FACTORY_COVERAGE_ROOTS
 * (fail-closed 403 COVERAGE_PATH_DENIED outside the jail).
 */
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import {
  CoverageError,
  CoverageParseError,
  CoveragePathError,
  CoverageStore,
  CoverageStoreError,
  MAX_COVERAGE_REPORT_BYTES,
  detectCoverageFormat,
  parseCoverageReport,
  resolveCoverageReportPath,
  type CoverageFormat,
} from '../coverage';

const PREFIX = '/api/coverage';

/** One store per process, like the other JSON-backed config stores. */
let store: CoverageStore | null = null;
export function coverageStore(): CoverageStore {
  if (!store) store = new CoverageStore();
  return store;
}
/** Test seam: swap the store (hermetic tests point it at a temp file). */
export function setCoverageStore(s: CoverageStore | null): void {
  store = s;
}

function projectIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > 128) return null;
  return id;
}

type FormatOrInvalid = CoverageFormat | 'invalid' | null;
function formatOf(value: unknown): FormatOrInvalid {
  if (value === undefined || value === null) return null;
  if (value === 'lcov' || value === 'cobertura' || value === 'v8') return value;
  return 'invalid';
}

function corruptBody(): { error: string; code: string } {
  return {
    error: 'coverage store is corrupt; fix or remove the file, then retry',
    code: 'COVERAGE_STORE_CORRUPT',
  };
}

function publicFile(f: { path: string; totalLines: number; coveredLines: number; coverage: number }) {
  return { path: f.path, totalLines: f.totalLines, coveredLines: f.coveredLines, coverage: f.coverage };
}

/**
 * Shared import path: resolve the report inside the jail, parse it,
 * store it as the project's latest. Used by POST /api/coverage/import
 * and by the quality-gate linkage (routes/quality.ts re-exports it).
 * Throws CoverageError subclasses on every failure mode.
 */
export function importCoverageReport(
  projectId: string,
  reportPath: string,
  opts: { format?: CoverageFormat | null; trigger?: string } = {},
): { format: CoverageFormat; summary: { files: number; totalLines: number; coveredLines: number; coverage: number }; at: string } {
  const abs = resolveCoverageReportPath(reportPath);
  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    throw new CoverageError(`coverage report not found: ${abs}`);
  }
  if (size > MAX_COVERAGE_REPORT_BYTES) {
    throw new CoverageError(`coverage report exceeds ${MAX_COVERAGE_REPORT_BYTES} bytes`);
  }
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (e) {
    throw new CoverageError(`cannot read coverage report: ${(e as Error).message}`);
  }
  const format = opts.format ?? detectCoverageFormat(text);
  if (!format) {
    throw new CoverageParseError('unrecognized coverage report format (expected lcov, cobertura or v8 JSON)');
  }
  const report = parseCoverageReport(text, { format, reportPath: abs });
  coverageStore().record(projectId, report, { trigger: opts.trigger ?? 'import' });
  return { format, summary: report.summary, at: report.at };
}

export async function handleCoverageRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  const projectIdOfQuery = () => projectIdOf(url.searchParams.get('projectId'));

  // GET /api/coverage/summary?projectId= — latest summary + history.
  if (method === 'GET' && path === `${PREFIX}/summary`) {
    const projectId = projectIdOfQuery();
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId query parameter is required' });
      return true;
    }
    try {
      const rec = coverageStore().get(projectId);
      ctx.json(res, 200, {
        projectId,
        latest: rec.latest
          ? {
              format: rec.latest.format,
              reportPath: rec.latest.reportPath,
              at: rec.latest.at,
              summary: rec.latest.summary,
            }
          : null,
        history: rec.history,
      });
    } catch (e) {
      if (e instanceof CoverageStoreError) {
        ctx.json(res, 500, corruptBody());
        return true;
      }
      throw e;
    }
    return true;
  }

  // GET /api/coverage/files?projectId= — per-file coverage list (worst first).
  if (method === 'GET' && path === `${PREFIX}/files`) {
    const projectId = projectIdOfQuery();
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId query parameter is required' });
      return true;
    }
    try {
      const rec = coverageStore().get(projectId);
      ctx.json(res, 200, {
        projectId,
        at: rec.latest?.at ?? null,
        files: (rec.latest?.files ?? []).map(publicFile),
      });
    } catch (e) {
      if (e instanceof CoverageStoreError) {
        ctx.json(res, 500, corruptBody());
        return true;
      }
      throw e;
    }
    return true;
  }

  // GET /api/coverage/file?projectId=&path= — line-level hit map.
  if (method === 'GET' && path === `${PREFIX}/file`) {
    const projectId = projectIdOfQuery();
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId query parameter is required' });
      return true;
    }
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      ctx.json(res, 400, { error: 'path query parameter is required' });
      return true;
    }
    try {
      const rec = coverageStore().get(projectId);
      const file = rec.latest?.files.find((f) => f.path === filePath);
      if (!file) {
        ctx.json(res, 404, { error: 'no coverage data for that file path', code: 'COVERAGE_FILE_NOT_FOUND' });
        return true;
      }
      ctx.json(res, 200, {
        path: file.path,
        totalLines: file.totalLines,
        coveredLines: file.coveredLines,
        coverage: file.coverage,
        lines: file.lines,
      });
    } catch (e) {
      if (e instanceof CoverageStoreError) {
        ctx.json(res, 500, corruptBody());
        return true;
      }
      throw e;
    }
    return true;
  }

  // POST /api/coverage/import — parse a report file into the store now.
  if (method === 'POST' && path === `${PREFIX}/import`) {
    const body = await ctx.readBody(req);
    const projectId = projectIdOf(body['projectId']);
    if (!projectId) {
      ctx.json(res, 400, { error: 'projectId is required' });
      return true;
    }
    const reportPath = typeof body['reportPath'] === 'string' ? body['reportPath'] : '';
    if (!reportPath.trim()) {
      ctx.json(res, 400, { error: 'reportPath is required' });
      return true;
    }
    const format = formatOf(body['format']);
    if (format === 'invalid') {
      ctx.json(res, 400, { error: 'format must be one of lcov|cobertura|v8' });
      return true;
    }
    const actor = typeof body['actor'] === 'string' && body['actor'].trim()
      ? body['actor'].trim().slice(0, 64)
      : 'human';
    try {
      const imported = importCoverageReport(projectId, reportPath, { format, trigger: 'import' });
      ctx.audit.record(actor, 'QUALITY_GATE_COVERAGE_IMPORTED', 'coverage', projectId, {
        format: imported.format,
        coverage: imported.summary.coverage,
        totalLines: imported.summary.totalLines,
        coveredLines: imported.summary.coveredLines,
        files: imported.summary.files,
      });
      ctx.json(res, 200, { projectId, ...imported });
    } catch (e) {
      if (e instanceof CoveragePathError) {
        ctx.json(res, 403, { error: (e as Error).message, code: 'COVERAGE_PATH_DENIED' });
        return true;
      }
      if (e instanceof CoverageParseError || e instanceof CoverageError) {
        ctx.audit.record(actor, 'QUALITY_GATE_COVERAGE_FAILED', 'coverage', projectId, {
          reason: (e as Error).message,
          trigger: 'import',
        });
        ctx.json(res, 422, { error: (e as Error).message, code: 'COVERAGE_IMPORT_FAILED' });
        return true;
      }
      if (e instanceof CoverageStoreError) {
        ctx.json(res, 500, corruptBody());
        return true;
      }
      throw e;
    }
    return true;
  }

  return false;
}

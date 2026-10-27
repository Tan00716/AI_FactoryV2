/**
 * Data-file preview routes (round-6 task R6-B10) — read-only table
 * preview for JSONL/NDJSON/CSV files.
 *
 *   POST /api/datapreview/preview
 *     { root?, path, format?, page?, pageSize?, sortColumn?, sortDir?, filter? }
 *     → { format, columns, columnsTruncated, totalRows, filteredRows,
 *         malformedRows, truncated, page, pageSize, totalPages, rows }
 *
 * Read-only by construction: the route never writes to the file, and
 * the desktop panel renders the table without an edit path. This is a
 * FILE preview, not the database browser (round-4 A5): it reads one
 * workspace file, it never opens a database connection.
 *
 * Safety (same seams as the code search route):
 *  - The root is jailed by the injected resolver (the same
 *    resolveInspectionRoot(FACTORY_INSPECT_ROOTS, default cwd) as the
 *    quality-gate scan): a path escaping the root → 403.
 *  - Files over DATA_PREVIEW_MAX_FILE_BYTES → 413 (never loaded).
 *  - Rows past 100,000 stop the parse with `truncated: true`;
 *    malformed rows are skipped and counted, never guessed.
 *  - The preview itself is not audited (read-only, like the code
 *    search and the TODO scan).
 *
 * The route must not value-import ../inspections (dual-mode import
 * rule: this module is imported from src by tests, so no extensionless
 * value-imports of sibling modules) — the root resolver arrives by
 * setter injection, codesearch/trojan pattern:
 *
 *   import { handleDataPreviewRoutes, setDataPreviewRootResolver } from './routes/datapreview';
 *   setDataPreviewRootResolver((root) => resolveInspectionRoot(root));
 *   if (await handleDataPreviewRoutes(req, res, url, routeCtx)) return;
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  DATA_PREVIEW_MAX_FILE_BYTES,
  DataPreviewError,
  detectDataPreviewFormat,
  previewDataFile,
  type DataPreviewFormat,
} from '@ai-factory/datapreview';
import type { RouteContext } from './context';

const PREFIX = '/api/datapreview';

/** Inspection-root resolver (setter injection, codesearch pattern). */
let rootResolver: ((root?: string) => string) | null = null;

export function setDataPreviewRootResolver(fn: ((root?: string) => string) | null): void {
  rootResolver = fn;
}

function resolveRoot(raw: unknown): string {
  if (!rootResolver) throw new DataPreviewError('data preview root resolver is not configured');
  const s = typeof raw === 'string' ? raw.trim() : '';
  return rootResolver(s ? s : undefined);
}

export async function handleDataPreviewRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== `${PREFIX}/preview`) return false;
  if (method !== 'POST') return false;

  const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
  let root: string;
  try {
    root = resolveRoot(body['root']);
  } catch (e) {
    ctx.json(res, 403, { error: (e as Error).message });
    return true;
  }
  const rel = typeof body['path'] === 'string' ? body['path'].trim() : '';
  if (rel === '') {
    ctx.json(res, 400, { error: 'path is required' });
    return true;
  }
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    ctx.json(res, 403, { error: 'path escapes the project root' });
    return true;
  }
  let format: DataPreviewFormat | null = null;
  if (typeof body['format'] === 'string' && body['format'] !== '') {
    if (body['format'] !== 'jsonl' && body['format'] !== 'csv') {
      ctx.json(res, 400, { error: `unsupported format: ${body['format']}` });
      return true;
    }
    format = body['format'];
  } else {
    format = detectDataPreviewFormat(abs);
  }
  if (format === null) {
    ctx.json(res, 415, { error: 'unsupported file type for data preview (want .jsonl, .ndjson, or .csv)' });
    return true;
  }
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    ctx.json(res, 404, { error: `file not found: ${rel}` });
    return true;
  }
  if (!stat.isFile()) {
    ctx.json(res, 400, { error: 'path is not a file' });
    return true;
  }
  if (stat.size > DATA_PREVIEW_MAX_FILE_BYTES) {
    ctx.json(res, 413, { error: `file exceeds the ${DATA_PREVIEW_MAX_FILE_BYTES} byte preview limit` });
    return true;
  }
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (e) {
    ctx.json(res, 500, { error: (e as Error).message });
    return true;
  }
  try {
    const page = previewDataFile(text, format, {
      page: typeof body['page'] === 'number' ? body['page'] : undefined,
      pageSize: typeof body['pageSize'] === 'number' ? body['pageSize'] : undefined,
      sortColumn: typeof body['sortColumn'] === 'string' ? body['sortColumn'] : undefined,
      sortDir: body['sortDir'] === 'desc' ? 'desc' : 'asc',
      filter: typeof body['filter'] === 'string' ? body['filter'] : undefined,
    });
    ctx.json(res, 200, page);
  } catch (e) {
    const code = e instanceof DataPreviewError ? 400 : 500;
    ctx.json(res, code, { error: (e as Error).message });
  }
  return true;
}

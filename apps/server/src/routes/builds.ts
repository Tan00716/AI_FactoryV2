/**
 * Builds read surface — SPEC v2 §40 (Batch 31).
 *
 *   GET  /api/builds        list build records, oldest first
 *   GET  /api/builds/:id    single build record
 *
 * Closes the read-surface gap the first-run walkthrough (B30, F9) named
 * honestly: after a background build finished, an HTTP-only consumer
 * had no read endpoint to observe the landed build — the walkthrough
 * read the DB file directly. This is that endpoint.
 *
 * READ-ONLY, deliberately:
 *  - no route here enqueues, starts, reruns, or mutates a build in any
 *    way; it only exposes the builds table (§40 records written by the
 *    merge path / build-runner);
 *  - non-GET methods are refused with 405 (nothing writable exists);
 *  - the records themselves are the same copies the db store hands out
 *    (fresh deep copies), serialized as-is. Fields that record absence
 *    stay absent: digest/sbomRef/attestationRef are null exactly when
 *    no real build produced them, with the pinned reason notes
 *    (digestNote/sbomNote) — never fabricated here.
 *
 * RBAC: viewer (see requiredRoleFor in src/auth.ts). RBAC is enforced
 * by the coordinator's pre-dispatch gate; this module only implements
 * the read surface.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';
import type { BuildRecordStatus } from '@ai-factory/db';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const VALID_STATUSES: readonly BuildRecordStatus[] = [
  'NOT_EXECUTED',
  'SUCCEEDED',
  'FAILED',
];

function isValidStatus(s: string): s is BuildRecordStatus {
  return (VALID_STATUSES as readonly string[]).includes(s);
}

function parsePositiveInt(
  raw: string | null,
  name: string,
  max: number | null,
): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: name === 'limit' ? DEFAULT_LIMIT : 0 };
  if (!/^\d+$/.test(raw)) {
    return { ok: false, error: `${name} must be a non-negative integer, got ${JSON.stringify(raw)}` };
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, error: `${name} is out of range` };
  }
  if (max !== null && value > max) {
    return { ok: false, error: `${name} must be <= ${max}, got ${value}` };
  }
  return { ok: true, value };
}

export async function handleBuildsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const { json, fdb } = ctx;
  const method = req.method ?? 'GET';
  const p = url.pathname;
  if (p !== '/api/builds' && !p.startsWith('/api/builds/')) return false;

  if (method !== 'GET') {
    json(res, 405, {
      error: 'method not allowed — /api/builds is read-only (no writable surface exists)',
    });
    return true;
  }

  if (p === '/api/builds') {
    // ---------------------------------------------------------- list --
    const statusParam = url.searchParams.get('status');
    if (statusParam !== null && !isValidStatus(statusParam)) {
      json(res, 400, {
        error: `status must be one of ${VALID_STATUSES.join(' | ')}, got ${JSON.stringify(statusParam)}`,
      });
      return true;
    }
    const limitParsed = parsePositiveInt(url.searchParams.get('limit'), 'limit', MAX_LIMIT);
    if (!limitParsed.ok) {
      json(res, 400, { error: limitParsed.error });
      return true;
    }
    const offsetParsed = parsePositiveInt(url.searchParams.get('offset'), 'offset', null);
    if (!offsetParsed.ok) {
      json(res, 400, { error: offsetParsed.error });
      return true;
    }
    const prIdParam = url.searchParams.get('prId');
    const revisionParam = url.searchParams.get('revision');

    // The store's list() contract: oldest first. Filters are applied
    // in memory over the store's copies — single-machine table, no
    // pagination pressure, and the filters mirror the store's own
    // listByPr/listByRevision semantics.
    let records = fdb.builds.list();
    if (statusParam) records = records.filter((r) => r.status === statusParam);
    if (prIdParam !== null) records = records.filter((r) => r.prId === prIdParam);
    if (revisionParam !== null) records = records.filter((r) => r.revision === revisionParam);

    const total = records.length;
    const items = records.slice(offsetParsed.value, offsetParsed.value + limitParsed.value);
    json(res, 200, {
      items,
      total,
      limit: limitParsed.value,
      offset: offsetParsed.value,
    });
    return true;
  }

  // ------------------------------------------------------------ one --
  // Single id segment only; deeper paths are not a builds route.
  const rest = p.slice('/api/builds/'.length);
  if (rest === '' || rest.includes('/')) return false;
  const record = fdb.builds.get(rest);
  if (!record) {
    json(res, 404, { error: 'build record not found' });
    return true;
  }
  json(res, 200, { build: record });
  return true;
}

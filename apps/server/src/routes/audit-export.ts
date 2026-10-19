/**
 * Audit compliance export — GET /api/audit/export
 *
 *   GET /api/audit/export?format=csv|json&from=<ISO>&to=<ISO>
 *
 * Produces a compliance-grade report of the §32 audit chain:
 *
 *  1. The chain is verified FIRST (forward hash chain + tail anchor, the
 *     same verifier as GET /api/audit/verify). A broken chain or a
 *     truncated/rewritten tail is a 409 — a compliance report must never
 *     be built on an unverifiable chain (fail-closed).
 *  2. Records are filtered by the optional from/to ISO time range.
 *  3. The export itself is audited (AUDIT_EXPORTED with actor, time,
 *     format and range) AFTER the snapshot is built, so the report
 *     reflects exactly the chain that verified.
 *
 * Formats:
 *  - csv  — pure RFC4180 records (id,ts,actor,action,entity_type,
 *    entity_id,reason,result,details_json,prev_hash,summary_hash); every
 *    field is escaped (quote/comma/CRLF → quoted, embedded quote doubled).
 *  - json — { report: { exportedAt, chainLength, headHash, verifyOk,
 *    tailAnchorStatus, format, from, to, recordCount }, records: [...] }.
 *
 * Report header (exportedAt / chainLength / headHash / verify result) is
 * carried in X-Audit-Export-* response headers on both formats (the CSV
 * body stays parseable records), and embedded in the JSON body.
 *
 * PDF: deliberately NOT offered. A presentable PDF needs a layout engine;
 * this codebase has a zero-external-deps policy and CSV/JSON satisfy
 * compliance retention (importable by Excel/SIEM). Documented here so
 * nobody files it as a missing feature.
 *
 * RBAC: operator+ (auth.ts requiredRoleFor). Listing (/api/audit) is
 * viewer, but minting an attested compliance artifact is a control
 * action — same posture as /api/audit/verify.
 *
 * Dual-mode: value imports are node builtins + @ai-factory/* packages
 * only, so tests may import this module from src with an explicit `.ts`
 * suffix.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditRecord } from '@ai-factory/core';
import type { TailAnchoredVerification } from '../audit-tail-anchor';
import type { RouteContext } from './context';

const PREFIX = '/api/audit/export';

/** The action recorded when an export is minted. */
export const AUDIT_EXPORTED_ACTION = 'AUDIT_EXPORTED';

export type AuditExportFormat = 'csv' | 'json';

/** CSV column order — stable; a shape change is a breaking API change. */
export const AUDIT_EXPORT_CSV_COLUMNS = [
  'id',
  'ts',
  'actor',
  'action',
  'entity_type',
  'entity_id',
  'reason',
  'result',
  'details_json',
  'prev_hash',
  'summary_hash',
] as const;

/**
 * RFC4180 field escaping: a field containing a double quote, comma, CR or
 * LF is wrapped in double quotes and every embedded quote is doubled.
 */
export function csvEscapeField(value: string): string {
  if (/[",\r\n]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
  return value;
}

/** One audit record → one RFC4180 row. */
export function auditRecordToCsvRow(r: AuditRecord): string {
  const fields = [
    r.id,
    r.ts,
    r.actor,
    r.action,
    r.entityType,
    r.entityId,
    r.reason ?? '',
    r.result ?? '',
    JSON.stringify(r.details ?? {}),
    r.prevHash ?? '',
    r.summaryHash ?? '',
  ];
  return fields.map(csvEscapeField).join(',');
}

export function auditExportCsv(records: AuditRecord[]): string {
  const lines = [AUDIT_EXPORT_CSV_COLUMNS.join(',')];
  for (const r of records) lines.push(auditRecordToCsvRow(r));
  return lines.join('\r\n') + '\r\n';
}

export interface AuditExportReportHeader {
  exportedAt: string;
  /** Full chain length at verify time (before range filtering). */
  chainLength: number;
  /** summaryHash of the last chained record ('' when the chain is empty). */
  headHash: string;
  verifyOk: boolean;
  tailAnchorStatus: string;
  format: AuditExportFormat;
  from: string | null;
  to: string | null;
  recordCount: number;
}

type TimeParam = { ok: true; ms: number | null } | { ok: false; error: string };

function parseTimeParam(name: string, raw: string | null): TimeParam {
  if (raw === null || raw === '') return { ok: true, ms: null };
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return { ok: false, error: `invalid ${name}: not an ISO-8601 timestamp` };
  return { ok: true, ms };
}

/**
 * Normalized view over the two verifiers this route can use: the
 * tail-anchored production verifier (injected via RouteContext) or the
 * plain forward-chain verify() for embedders that omit it.
 */
interface NormalizedVerification {
  ok: boolean;
  tailTruncated: boolean;
  tailAnchorStatus: string;
  verifiedCount: number;
  brokenAt?: number;
  code?: string;
}

function normalizeVerification(v: TailAnchoredVerification): NormalizedVerification {
  return {
    ok: v.ok,
    tailTruncated: v.tailTruncated,
    tailAnchorStatus: v.tailAnchorStatus,
    verifiedCount: v.verifiedCount,
    brokenAt: v.brokenAt,
    code: v.code,
  };
}

export async function handleAuditExportRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (url.pathname !== PREFIX) return false;
  if (method !== 'GET') {
    ctx.json(res, 405, { error: 'method not allowed', code: 'AUDIT_EXPORT_METHOD_NOT_ALLOWED' });
    return true;
  }

  const formatParam = url.searchParams.get('format') ?? 'csv';
  if (formatParam !== 'csv' && formatParam !== 'json') {
    ctx.json(res, 400, {
      error: `invalid format "${formatParam}" — expected csv|json`,
      code: 'AUDIT_EXPORT_BAD_FORMAT',
    });
    return true;
  }
  const format = formatParam as AuditExportFormat;

  const fromParsed = parseTimeParam('from', url.searchParams.get('from'));
  const toParsed = parseTimeParam('to', url.searchParams.get('to'));
  if (!fromParsed.ok || !toParsed.ok) {
    const bad = !fromParsed.ok ? fromParsed : toParsed;
    ctx.json(res, 400, { error: (bad as { error: string }).error, code: 'AUDIT_EXPORT_BAD_RANGE' });
    return true;
  }
  const fromMs = fromParsed.ms;
  const toMs = toParsed.ms;
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    ctx.json(res, 400, {
      error: 'invalid range: from is after to',
      code: 'AUDIT_EXPORT_BAD_RANGE',
    });
    return true;
  }

  // 1. Verify FIRST — fail closed. A compliance report is never built on
  // an unverifiable chain.
  const verification: NormalizedVerification = ctx.verifyAuditChainWithTail
    ? normalizeVerification(ctx.verifyAuditChainWithTail())
    : (() => {
        const v = ctx.audit.verify();
        return { ok: v.ok, tailTruncated: false, tailAnchorStatus: 'unavailable', verifiedCount: v.verifiedCount, brokenAt: v.brokenAt };
      })();
  if (!verification.ok || verification.tailTruncated) {
    ctx.json(res, 409, {
      error:
        'audit chain verification failed — export refused: a compliance report cannot be built on an unverifiable chain',
      code: 'AUDIT_EXPORT_CHAIN_INVALID',
      verify: {
        ok: verification.ok,
        tailTruncated: verification.tailTruncated,
        tailAnchorStatus: verification.tailAnchorStatus,
        verifiedCount: verification.verifiedCount,
        brokenAt: verification.brokenAt,
        code: verification.code,
      },
    });
    return true;
  }

  // 2. Snapshot + range filter (audit.list() is oldest-first).
  const all = ctx.audit.list();
  const records = all.filter((r) => {
    const ms = Date.parse(r.ts);
    if (fromMs !== null && !Number.isNaN(ms) && ms < fromMs) return false;
    if (toMs !== null && !Number.isNaN(ms) && ms > toMs) return false;
    return true;
  });
  let headHash = '';
  for (let i = all.length - 1; i >= 0; i--) {
    const h = all[i].summaryHash;
    if (typeof h === 'string') {
      headHash = h;
      break;
    }
  }

  const header: AuditExportReportHeader = {
    exportedAt: new Date().toISOString(),
    chainLength: all.length,
    headHash,
    verifyOk: true,
    tailAnchorStatus: verification.tailAnchorStatus,
    format,
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    recordCount: records.length,
  };

  // 3. Audit the export itself (who/when/scope) after the snapshot is
  // built, so the report reflects exactly the chain that verified. The
  // caller role is resolved by the coordinator (index.ts) via
  // requestRole() — this module never touches credentials.
  const role = ctx.callerRole ?? 'unknown';
  ctx.audit.record('human', AUDIT_EXPORTED_ACTION, 'audit', 'export', {
    format,
    from: header.from,
    to: header.to,
    recordCount: records.length,
    chainLength: all.length,
    headHash,
    role,
  });

  // 4. Emit the report. The header rides in X-Audit-Export-* response
  // headers on both formats (CSV stays pure records); JSON also embeds
  // it in the body.
  const filename = `audit-export-${header.exportedAt.replace(/[:.]/g, '-')}.${format}`;
  const responseHeaders: Record<string, string> = {
    'X-Audit-Export-At': header.exportedAt,
    'X-Audit-Export-Chain-Length': String(header.chainLength),
    'X-Audit-Export-Head-Hash': header.headHash,
    'X-Audit-Export-Verify': 'ok',
    'X-Audit-Export-Tail-Anchor': header.tailAnchorStatus,
    'X-Audit-Export-Record-Count': String(header.recordCount),
  };
  if (format === 'csv') {
    const body = auditExportCsv(records);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      ...responseHeaders,
    });
    res.end(body);
  } else {
    const body = JSON.stringify({ report: header, records }, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      ...responseHeaders,
    });
    res.end(body);
  }
  return true;
}

/**
 * Audit compliance export tests (GET /api/audit/export).
 *
 * Handler-level tests with a fake RouteContext (no server boot): the
 * handler only touches ctx.audit, ctx.json, ctx.verifyAuditChainWithTail
 * and ctx.authConfig, so a hermetic fake is faithful. RBAC is asserted
 * through requiredRoleFor (the central gate's single source of truth).
 *
 * Dual-mode: the src modules are imported with explicit `.ts` suffixes —
 * their value imports are node builtins + @ai-factory/* packages +
 * ../auth (whose own value imports are builtins/packages only), so
 * type-stripping works.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuditLog, InMemoryAuditStore } from '@ai-factory/core';
import type { AuditRecord } from '@ai-factory/core';
import type { TailAnchoredVerification } from '../src/audit-tail-anchor.ts';
import { requiredRoleFor } from '../src/auth.ts';
import {
  handleAuditExportRoutes,
  auditExportCsv,
  csvEscapeField,
  AUDIT_EXPORTED_ACTION,
} from '../src/routes/audit-export.ts';
import type { RouteContext } from '../src/routes/context.ts';

interface Captured {
  status: number | null;
  headers: Record<string, string>;
  body: string;
}

function fakeReq(path: string, method = 'GET'): IncomingMessage {
  return { method, url: path, headers: {} } as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: null, headers: {}, body: '' };
  const res = {
    writeHead: (status: number, headers?: Record<string, string>) => {
      captured.status = status;
      for (const [k, v] of Object.entries(headers ?? {})) captured.headers[k.toLowerCase()] = v;
    },
    setHeader: (k: string, v: string) => {
      captured.headers[k.toLowerCase()] = v;
    },
    end: (body?: unknown) => {
      if (body !== undefined) captured.body += String(body);
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function makeCtx(
  audit: AuditLog,
  opts: {
    verifier?: () => TailAnchoredVerification;
    callerRole?: 'admin' | 'operator' | 'viewer' | null;
    captured: Captured;
  },
): RouteContext {
  return {
    audit,
    json: ((_r: ServerResponse, status: number, body: unknown) => {
      opts.captured.status = status;
      opts.captured.headers['content-type'] = 'application/json';
      opts.captured.body = JSON.stringify(body);
    }) as RouteContext['json'],
    readBody: (async () => ({})) as RouteContext['readBody'],
    verifyAuditChainWithTail: opts.verifier,
    callerRole: opts.callerRole,
  } as unknown as RouteContext;
}

function healthyVerifier(): () => TailAnchoredVerification {
  return () =>
    ({
      ok: true,
      verifiedCount: 1,
      legacyCount: 0,
      tailTruncated: false,
      tailAnchorStatus: 'ok',
    }) as TailAnchoredVerification;
}

function seedAudit(): AuditLog {
  const audit = new AuditLog(new InMemoryAuditStore());
  audit.record('alice', 'TASK_CREATED', 'task', 'task-1', { title: 'plain, "quoted"\nmultiline' });
  audit.record('bob', 'RUN_COMPLETED', 'run', 'run-9', { ok: true }, { result: 'SUCCEEDED' });
  return audit;
}

/** Two records guaranteed distinct millisecond timestamps (for range tests). */
function seedAuditSpaced(): AuditLog {
  const audit = new AuditLog(new InMemoryAuditStore());
  audit.record('alice', 'TASK_CREATED', 'task', 'task-1', {});
  const t0 = Date.now();
  while (Date.now() === t0) {
    /* spin into the next millisecond so nowIso() differs */
  }
  audit.record('bob', 'RUN_COMPLETED', 'run', 'run-9', {});
  return audit;
}

async function callExport(
  audit: AuditLog,
  query: string,
  opts: { verifier?: () => TailAnchoredVerification; callerRole?: 'admin' | 'operator' | 'viewer' | null } = {},
): Promise<{ captured: Captured; handled: boolean }> {
  const { res, captured } = fakeRes();
  const ctx = makeCtx(audit, {
    verifier: opts.verifier,
    callerRole: opts.callerRole === undefined ? 'admin' : opts.callerRole,
    captured,
  });
  const url = new URL(query, 'http://localhost');
  const handled = await handleAuditExportRoutes(fakeReq(query), res, url, ctx);
  return { captured, handled };
}

/** Minimal RFC4180 row parser (test-local) to verify escaping round-trips. */
function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        cur += c;
        i++;
      }
    } else if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  out.push(cur);
  return out;
}

describe('csvEscapeField (RFC4180)', () => {
  test('plain field is untouched', () => {
    assert.equal(csvEscapeField('hello'), 'hello');
  });
  test('comma / quote / newline / CR force quoting, quotes doubled', () => {
    assert.equal(csvEscapeField('a,b'), '"a,b"');
    assert.equal(csvEscapeField('a"b'), '"a""b"');
    assert.equal(csvEscapeField('a\nb'), '"a\nb"');
    assert.equal(csvEscapeField('a\rb'), '"a\rb"');
  });
});

describe('auditExportCsv', () => {
  test('header row + one row per record, CRLF terminated', () => {
    const audit = seedAudit();
    const csv = auditExportCsv(audit.list());
    const lines = csv.split('\r\n');
    assert.equal(lines[0], 'id,ts,actor,action,entity_type,entity_id,reason,result,details_json,prev_hash,summary_hash');
    assert.equal(lines.length, 4); // header + 2 records + trailing ''
    assert.equal(lines[3], '');
  });
  test('fields with comma/quote/newline round-trip through a parser', () => {
    const audit = seedAudit();
    const csv = auditExportCsv(audit.list());
    const dataLine = csv.split('\r\n')[1];
    const fields = parseCsvRow(dataLine);
    assert.equal(fields.length, 11);
    assert.equal(fields[2], 'alice');
    assert.equal(fields[3], 'TASK_CREATED');
    // details_json must survive the round trip byte-identical
    const details = JSON.parse(fields[8]);
    assert.deepEqual(details, { title: 'plain, "quoted"\nmultiline' });
  });
});

describe('handleAuditExportRoutes', () => {
  test('returns false for unrelated paths', async () => {
    const { res, captured } = fakeRes();
    const audit = seedAudit();
    const ctx = makeCtx(audit, { captured });
    const handled = await handleAuditExportRoutes(
      fakeReq('/api/audit'),
      res,
      new URL('/api/audit', 'http://localhost'),
      ctx,
    );
    assert.equal(handled, false);
    assert.equal(captured.status, null);
  });

  test('CSV export: 200, attachment headers, report header in X- headers', async () => {
    const audit = seedAudit();
    const { captured, handled } = await callExport(audit, '/api/audit/export?format=csv', {
      verifier: healthyVerifier(),
    });
    assert.equal(handled, true);
    assert.equal(captured.status, 200);
    assert.match(captured.headers['content-type'], /^text\/csv/);
    assert.match(captured.headers['content-disposition'], /attachment; filename="audit-export-.*\.csv"/);
    assert.equal(captured.headers['x-audit-export-verify'], 'ok');
    assert.equal(captured.headers['x-audit-export-tail-anchor'], 'ok');
    assert.equal(captured.headers['x-audit-export-chain-length'], '2');
    assert.equal(captured.headers['x-audit-export-record-count'], '2');
    assert.ok(captured.headers['x-audit-export-head-hash'].length > 0);
    assert.ok(Date.parse(captured.headers['x-audit-export-at']) > 0);
    // body is parseable CSV with the seeded records
    const lines = captured.body.split('\r\n');
    assert.equal(lines.length, 4);
    assert.ok(captured.body.includes('TASK_CREATED'));
  });

  test('JSON export: report header embedded in body', async () => {
    const audit = seedAudit();
    const { captured } = await callExport(audit, '/api/audit/export?format=json', {
      verifier: healthyVerifier(),
    });
    assert.equal(captured.status, 200);
    assert.match(captured.headers['content-type'], /application\/json/);
    const body = JSON.parse(captured.body);
    assert.equal(body.report.format, 'json');
    assert.equal(body.report.chainLength, 2);
    assert.equal(body.report.recordCount, 2);
    assert.equal(body.report.verifyOk, true);
    assert.equal(body.report.tailAnchorStatus, 'ok');
    assert.ok(body.report.headHash.length > 0);
    assert.ok(Date.parse(body.report.exportedAt) > 0);
    assert.equal(body.records.length, 2);
    assert.equal(body.records[0].action, 'TASK_CREATED');
  });

  test('from/to range filters records', async () => {
    const audit = seedAuditSpaced();
    const first = audit.list()[0];
    const second = audit.list()[1];
    assert.notEqual(first.ts, second.ts);
    // range that only includes the second record
    const q = `/api/audit/export?format=json&from=${encodeURIComponent(second.ts)}&to=${encodeURIComponent(second.ts)}`;
    const { captured } = await callExport(audit, q, { verifier: healthyVerifier() });
    assert.equal(captured.status, 200);
    const body = JSON.parse(captured.body);
    assert.equal(body.report.recordCount, 1);
    assert.equal(body.records[0].id, second.id);
  });

  test('invalid format / bad range → 400', async () => {
    const audit = seedAudit();
    for (const q of [
      '/api/audit/export?format=pdf',
      '/api/audit/export?from=not-a-time',
      '/api/audit/export?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z',
    ]) {
      const { captured } = await callExport(audit, q, { verifier: healthyVerifier() });
      assert.equal(captured.status, 400, q);
      assert.match(JSON.parse(captured.body).code, /^AUDIT_EXPORT_/);
    }
  });

  test('broken chain → 409, no report body', async () => {
    class TamperingStore extends InMemoryAuditStore {
      override list(): AuditRecord[] {
        const rs = super.list();
        if (rs.length > 0) rs[0] = { ...rs[0], details: { hacked: true } };
        return rs;
      }
    }
    const audit = new AuditLog(new TamperingStore());
    audit.record('alice', 'TASK_CREATED', 'task', 't1', {});
    const { captured } = await callExport(audit, '/api/audit/export?format=csv');
    assert.equal(captured.status, 409);
    const body = JSON.parse(captured.body);
    assert.equal(body.code, 'AUDIT_EXPORT_CHAIN_INVALID');
    assert.equal(body.verify.ok, false);
  });

  test('tail truncated → 409 even when the forward chain is fine', async () => {
    const audit = seedAudit();
    const { captured } = await callExport(audit, '/api/audit/export?format=json', {
      verifier: () =>
        ({
          ok: true,
          verifiedCount: 2,
          legacyCount: 0,
          tailTruncated: true,
          tailAnchorStatus: 'ok',
          code: 'AUDIT_TAIL_TRUNCATED',
          expectedChainedCount: 5,
          observedChainedCount: 2,
        }) as TailAnchoredVerification,
    });
    assert.equal(captured.status, 409);
    const body = JSON.parse(captured.body);
    assert.equal(body.code, 'AUDIT_EXPORT_CHAIN_INVALID');
    assert.equal(body.verify.tailTruncated, true);
    assert.equal(body.verify.code, 'AUDIT_TAIL_TRUNCATED');
  });

  test('unreadable anchor → 409 (fail-closed)', async () => {
    const audit = seedAudit();
    const { captured } = await callExport(audit, '/api/audit/export?format=csv', {
      verifier: () =>
        ({
          ok: false,
          verifiedCount: 0,
          legacyCount: 0,
          tailTruncated: false,
          tailAnchorStatus: 'unreadable',
          code: 'AUDIT_TAIL_ANCHOR_UNREADABLE',
        }) as TailAnchoredVerification,
    });
    assert.equal(captured.status, 409);
    assert.equal(JSON.parse(captured.body).code, 'AUDIT_EXPORT_CHAIN_INVALID');
  });

  test('embedder without the tail verifier falls back to forward-chain verify', async () => {
    const audit = seedAudit();
    const { captured } = await callExport(audit, '/api/audit/export?format=json');
    assert.equal(captured.status, 200);
    const body = JSON.parse(captured.body);
    assert.equal(body.report.tailAnchorStatus, 'unavailable');
    assert.equal(captured.headers['x-audit-export-tail-anchor'], 'unavailable');
  });

  test('AUDIT_EXPORTED is recorded with actor, time and scope', async () => {
    const audit = seedAudit();
    const before = audit.list().length;
    const { captured } = await callExport(audit, '/api/audit/export?format=csv', {
      verifier: healthyVerifier(),
    });
    assert.equal(captured.status, 200);
    const after = audit.list();
    assert.equal(after.length, before + 1);
    const last = after[after.length - 1];
    assert.equal(last.action, AUDIT_EXPORTED_ACTION);
    assert.equal(last.actor, 'human');
    assert.equal(last.entityType, 'audit');
    assert.equal((last.details as Record<string, unknown>).format, 'csv');
    assert.equal((last.details as Record<string, unknown>).recordCount, 2);
    // callerRole 'admin' is carried through to the export record
    assert.equal((last.details as Record<string, unknown>).role, 'admin');
  });
});

describe('RBAC', () => {
  test('export requires operator (viewer may list but not mint reports)', () => {
    assert.equal(requiredRoleFor('GET', '/api/audit/export'), 'operator');
    // sanity: listing stays viewer, verify stays operator
    assert.equal(requiredRoleFor('GET', '/api/audit'), 'viewer');
    assert.equal(requiredRoleFor('GET', '/api/audit/verify'), 'operator');
  });
});

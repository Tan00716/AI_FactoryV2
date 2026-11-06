/**
 * HTTP client audit-ingestion redaction tests — R18 #6(o)(b) (R18 N6).
 *
 * Drives POST /api/http/run with a malformed URL carrying embedded
 * credentials and asserts the HTTP_CLIENT_RUN audit record's `error` field
 * carries no userinfo (the audit chain is viewer-readable).
 *
 * Gate note: the egress gate is deliberately set to allow-all here. The
 * real gate parses the URL itself (`new URL()` in evaluateEgress) and
 * blocks malformed URLs before sendHttpRequest ever sees them, so the
 * `invalid URL: <url>` error path is only reachable when egress is
 * disabled. This test exercises exactly that reachable path — the gate
 * under test is the audit-ingestion strip, not the egress policy (which
 * has its own tests).
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/httpclient-audit-redact.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleHttpClientRoutes,
  setHttpClientEgressGate,
  setHttpClientRootResolver,
} from '../src/routes/httpclient.ts';
import type { RouteContext } from '../src/routes/context.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'httpclient-audit-redact-'));

setHttpClientRootResolver(() => TEST_ROOT);
// Allow-all: see the gate note above — the malformed URL must reach
// sendHttpRequest for the `invalid URL` error to exist at all.
setHttpClientEgressGate(() => {});

interface AuditRec {
  event: string;
  details?: Record<string, unknown>;
}

function mockCtx(body: unknown): {
  ctx: RouteContext;
  calls: Array<{ code: number; body: unknown }>;
  audits: AuditRec[];
} {
  const calls: Array<{ code: number; body: unknown }> = [];
  const audits: AuditRec[] = [];
  const ctx = {
    json: (_res: unknown, code: number, b: unknown) => {
      calls.push({ code, body: b });
    },
    readBody: async () => body as Record<string, unknown>,
    audit: {
      record: (_actor: string, event: string, _entityType: string, _entityId: string, details?: Record<string, unknown>) => {
        audits.push({ event, details });
      },
    },
  } as unknown as RouteContext;
  return { ctx, calls, audits };
}

test('R18 N6: malformed-URL error is stripped of userinfo before audit ingestion', async () => {
  // Port 99999 is out of range, so `new URL()` inside sendHttpRequest
  // throws `invalid URL: <raw operator URL>` — the exact shape R18 N6
  // names. The password is 9 chars (long enough that redactText would
  // mask it); the strip must remove the whole userinfo segment.
  const { ctx, calls, audits } = mockCtx({
    text: 'GET https://hookuser:s3cret-pw@127.0.0.1:99999/hook\n',
  });
  const handled = await handleHttpClientRoutes(
    { method: 'POST' } as IncomingMessage,
    {} as ServerResponse,
    new URL('http://127.0.0.1/api/http/run'),
    ctx,
  );
  assert.equal(handled, true);
  assert.equal(calls[0]?.code, 200);
  const run = audits.find((a) => a.event === 'HTTP_CLIENT_RUN');
  assert.ok(run, 'HTTP_CLIENT_RUN must be recorded');
  const error = String(run.details?.['error'] ?? '');
  assert.match(error, /invalid URL/, 'the error shape is the malformed-URL one');
  assert.doesNotMatch(error, /hookuser|s3cret-pw/, 'no userinfo in the audit error');
  assert.match(error, /127\.0\.0\.1/, 'host is preserved after stripping');
});

/**
 * Exec/terminal echo-back desensitization — R20 #6(v) (R20 N4/N5/N6).
 *
 * Drives the real code paths with synthetic credential SHAPES (not real
 * credentials) and asserts the viewer-readable records carry no marker
 * verbatim:
 *   B1  /api/exec EXEC_DENIED entityId + details (no broker: the gap
 *       case — redactSecretValues alone never runs without a broker, and
 *       with one it only replaces broker-known values).
 *   B2  cleanTerminalText — the exact function wired into the
 *       AI_LINE_DENIED record() entry (line + reason) and the two
 *       terminal read endpoints. The live terminal drive (real AI
 *       session + denied line) is in ~/v3r20-6v-shots/probe-6v-live.mjs:
 *       session creation needs bwrap, or the FACTORY_EXEC_SANDBOX=0
 *       opt-out the terminal-history e2e already uses.
 *   B3  HistoryStore.append entry desensitization (store class) —
 *       recent() / search() / history.jsonl carry no verbatim text.
 *
 * Dual-mode note: routes/exec.ts and routes/terminal.ts value-import
 * relative modules extensionless, so both are imported here from
 * compiled dist (v3r19-6r.test.ts precedent) — run after the server
 * build. @ai-factory/termhistory resolves to its compiled dist through
 * the workspace symlink.
 *
 * Deliberately NOT asserted here (out of scope, hunter-B O-c and the
 * (v) brief): the 403 response-body error (denied.message echoes the
 * raw first token; same-operator only) and redactExecOutput (stdout
 * echo-back). See the README in ~/v3r20-6v-shots/ for the R21 notes.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/v3r20-6v.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleExecRoutes } from '../dist/routes/exec.js';
import { cleanTerminalText } from '../dist/routes/terminal.js';
import { HistoryStore } from '@ai-factory/termhistory';
import type { RouteContext } from '../src/routes/context.ts';

const M1 = 'r20v-m1-9f3a7c2e1b5d';
const M2 = 'r20v-m2-9f3a7c2e1b5d';
const M4 = 'r20v-m4-9f3a7c2e1b5d';
const M5 = 'r20v-m5-9f3a7c2e1b5d';
const M6 = 'r20v-m6-9f3a7c2e1b5d';
const M7 = 'r20v-m7-9f3a7c2e1b5d';
const M8 = 'r20v-m8-9f3a7c2e1b5d';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface AuditRec {
  event: string;
  entityId: string;
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
      record: (_actor: string, event: string, _entityType: string, entityId: string, details?: Record<string, unknown>) => {
        audits.push({ event, entityId, details });
      },
    },
    // No secretBroker on purpose: the N4 gap is exactly the no-broker
    // (and broker-knows-other-values) case.
  } as unknown as RouteContext;
  return { ctx, calls, audits };
}

const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;

test('R20 N4: EXEC_DENIED entityId + details carry no pasted marker (no broker)', async () => {
  // (a) assignment as first token, autonomous actor: confinement denial.
  {
    const { ctx, calls, audits } = mockCtx({ command: `FACTORY_API_TOKEN=${M1} echo hi`, actor: 'ai' });
    const handled = await handleExecRoutes(req('POST'), res, new URL('http://127.0.0.1/api/exec'), ctx);
    assert.equal(handled, true);
    assert.equal(calls[0]?.code, 403);
    const denied = audits.find((a) => a.event === 'EXEC_DENIED');
    assert.ok(denied, 'EXEC_DENIED must be recorded');
    assert.equal(denied.entityId, 'FACTORY_API_TOKEN=*** echo hi');
    assert.equal(denied.details?.['reason'], 'CONFINEMENT_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(denied.details ?? {}), new RegExp(escapeRegExp(M1)), 'details_json must not carry the marker');
  }
  // (b) same command, human actor: policy denial — the whitelist
  // refusal embeds the first token in the reason, so the reason must be
  // cleaned too (the (r) reason-cleaning precedent).
  {
    const { ctx, calls, audits } = mockCtx({ command: `FACTORY_API_TOKEN=${M1} echo hi`, actor: 'human' });
    const handled = await handleExecRoutes(req('POST'), res, new URL('http://127.0.0.1/api/exec'), ctx);
    assert.equal(handled, true);
    assert.equal(calls[0]?.code, 403);
    const denied = audits.find((a) => a.event === 'EXEC_DENIED');
    assert.ok(denied, 'EXEC_DENIED must be recorded');
    assert.equal(denied.entityId, 'FACTORY_API_TOKEN=*** echo hi');
    const reason = String(denied.details?.['reason'] ?? '');
    assert.doesNotMatch(reason, new RegExp(escapeRegExp(M1)), 'reason must not carry the marker');
    assert.match(reason, /FACTORY_API_TOKEN=\*\*\*/, 'key name kept, value masked');
    assert.doesNotMatch(JSON.stringify(denied.details ?? {}), new RegExp(escapeRegExp(M1)));
  }
  // (c) whitelisted binary, --flag value form, autonomous actor.
  {
    const { ctx, calls, audits } = mockCtx({ command: `echo --token ${M2}`, actor: 'ai' });
    const handled = await handleExecRoutes(req('POST'), res, new URL('http://127.0.0.1/api/exec'), ctx);
    assert.equal(handled, true);
    assert.equal(calls[0]?.code, 403);
    const denied = audits.find((a) => a.event === 'EXEC_DENIED');
    assert.ok(denied, 'EXEC_DENIED must be recorded');
    assert.equal(denied.entityId, 'echo --token ***');
    assert.doesNotMatch(JSON.stringify(denied.details ?? {}), new RegExp(escapeRegExp(M2)));
  }
});

test('R20 N5: cleanTerminalText (AI_LINE_DENIED record() cleaner) masks assignment + flag forms in line and reason', () => {
  assert.equal(
    cleanTerminalText(`FACTORY_API_TOKEN=${M4} echo hi`),
    'FACTORY_API_TOKEN=*** echo hi',
  );
  assert.equal(
    cleanTerminalText(`command refused: 'FACTORY_API_TOKEN=${M4}' is not in the allowed command list (echo, node)`),
    `command refused: 'FACTORY_API_TOKEN=***' is not in the allowed command list (echo, node)`,
  );
  assert.equal(cleanTerminalText(`echo --token ${M5}`), 'echo --token ***');
  assert.equal(cleanTerminalText('ls -la'), 'ls -la');
});

test('R20 N6: HistoryStore.append desensitizes at the entry — recent() / search() / history.jsonl carry no verbatim text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v3r20-6v-history-'));
  try {
    const store = new HistoryStore(join(dir, 'terminal-history'));
    const appended = store.append({ sessionId: 's1', principal: 'human', command: `export GITHUB_TOKEN=ghp_${M6}`, exitCode: 0 });
    assert.ok(appended !== null, 'append must store the entry');
    assert.equal(store.recent(10)[0]?.command, 'export GITHUB_TOKEN=***');
    assert.equal(store.search('GITHUB_TOKEN', 10)[0]?.command, 'export GITHUB_TOKEN=***');
    store.append({ sessionId: 's1', principal: 'human', command: `FACTORY_API_TOKEN=${M7} node -e 1`, exitCode: 0 });
    assert.equal(store.recent(10)[0]?.command, 'FACTORY_API_TOKEN=*** node -e 1');
    store.append({ sessionId: 's1', principal: 'human', command: `echo --token ${M8}`, exitCode: 0 });
    assert.equal(store.recent(10)[0]?.command, 'echo --token ***');
    // Benign passthrough: ordinary commands are stored verbatim.
    store.append({ sessionId: 's1', principal: 'human', command: 'echo hello-history-test', exitCode: 0 });
    assert.equal(store.recent(10)[0]?.command, 'echo hello-history-test');
    // Persistence surface: the file itself must not carry any marker.
    const content = readFileSync(join(dir, 'terminal-history', 'history.jsonl'), 'utf8');
    for (const m of [M6, M7, M8]) {
      assert.doesNotMatch(content, new RegExp(escapeRegExp(m)), 'history.jsonl must not carry the marker');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

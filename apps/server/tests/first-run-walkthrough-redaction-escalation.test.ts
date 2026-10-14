/**
 * First-run walkthrough: redaction-hit → needs-human escalation leg (Batch 51).
 *
 * Background: Batch 42 added `recordRedactionHit` → `RedactionHitAggregator`
 * (§81 'security-issue' aggregation): one detection event is a detection
 * event only — escalation needs ≥3 events from one source in 5 minutes
 * (REDACTION_ESCALATION_THRESHOLD / REDACTION_ESCALATION_WINDOW_MS).
 * The Batch 49 redaction leg observed exactly 2 hits from its session and
 * asserted NO escalation — this leg crosses the threshold and asserts the
 * escalation path end to end over pure HTTP against a real server with a
 * real pty.
 *
 * Design: one secret in the hermetic vault; a terminal session with
 * secretEnv ref; then ONE input line runs four `printf '%s' "$VAR"` with
 * shell-side `sleep 0.7` between them. Each printf is a full secret print
 * arriving as its own pty data event → its own redactor push. With the
 * cross-chunk carry (carryLen = secretLen−1), pushes emit 0/1/1/1 hits and
 * the stream-close flush emits the last → ≥3 detection events for the one
 * session → the aggregator escalates exactly once, writing an OPEN
 * 'security-issue' row with the honest narrative in detailJson.
 *
 * Legs (one `it`, pure HTTP, zero mocks):
 *   E1 — ≥3 SECRET_REDACTED_HIT detection events exist for the session
 *          (the escalation precondition — asserted, not assumed).
 *   E2 — GET /api/needs-human?status=open has exactly one OPEN
 *          'security-issue' row from `redaction-monitor:terminal:<sid>`.
 *   E3 — that row's detailJson.narrative carries the honest qualifier
 *          ("human judgment needed" — a single hit can be benign, the
 *          aggregated pattern is what escalates).
 *   E4 — the stream is free of secret bytes (Batch 48 guarantee holds)
 *          and the row's detailJson/audit never carry secret content.
 *
 * Hermeticity: temp DB + temp FACTORY_SECRETS_DIR. Dual-mode: node
 * builtins + fetch only, zero src imports.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = 'admin-walk-escal-zzz';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

type Json = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bootServer(): Promise<{ child: ChildProcess; port: number; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-walk-escal-'));
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: join(dir, 'factory.db'),
    FACTORY_API_TOKENS: `admin:${ADMIN}`,
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
  };
  delete env['FACTORY_API_TOKEN'];
  const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port, dir };
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not come up in time');
    }
    await sleep(150);
  }
}

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
}

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: adminHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: parsed };
}

interface SseFrame {
  event: string;
  data: string;
}

/** Minimal SSE reader over fetch: collects frames until `until` says stop. */
async function readSse(
  port: number,
  sessionId: string,
  until: (frames: SseFrame[]) => boolean,
  timeoutMs = 60_000,
): Promise<SseFrame[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${sessionId}/stream`, {
    headers: { Authorization: `Bearer ${ADMIN}`, Accept: 'text/event-stream' },
  });
  assert.equal(res.status, 200, 'SSE stream must open');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (until(frames)) break;
      if (Date.now() > deadline) {
        throw new Error(
          `SSE wait timed out; frames so far: ${JSON.stringify(frames.map((f) => ({ event: f.event, data: f.data.slice(0, 80) })))}`,
        );
      }
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length > 0 || event !== 'message') {
          frames.push({ event, data: dataLines.join('\n') });
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return frames;
}

function decodedOutput(frames: SseFrame[]): string {
  return frames
    .filter((f) => f.event === 'output')
    .map((f) => Buffer.from(JSON.parse(f.data).b64, 'base64').toString('utf8'))
    .join('');
}

function auditRecords(body: unknown): Array<Json> {
  // GET /api/audit returns a bare array (newest first) — pinned by
  // audit-list-contract.test.ts (Batch 46, F21).
  if (Array.isArray(body)) return body as Array<Json>;
  return (((body as Json)['records'] ?? []) as Array<Json>);
}

describe('first-run walkthrough: redaction-hit → needs-human escalation leg (Batch 51)', () => {
  it(
    'repeated redaction hits from one terminal session escalate to a security-issue upgrade',
    { timeout: 120_000 },
    async (t) => {
      const { child, port, dir } = await bootServer();
      try {
        const ts = Date.now();
        const secret = `walk-b51-sentinel-${ts}`; // ~25 chars: carryLen = 24

        const put = await api(port, 'PUT', '/api/secrets/walk-b51-escal', {
          value: secret,
          purpose: 'walkthrough-b51-escalation',
        });
        assert.equal(put.status, 200, 'secret stored');
        assert.ok(!('value' in put.body), 'PUT response is metadata only');
        t.diagnostic('secret stored in the hermetic vault');

        const created = await api(port, 'POST', '/api/terminal/sessions', {
          principal: 'human',
          shell: ['/bin/bash', '-i'],
          rows: 24,
          cols: 80,
          secretEnv: { WALK_B51_S: 'walk-b51-escal' },
        });
        assert.equal(created.status, 201, 'terminal session created');
        const sessionId = String((created.body as Json)['id'] ?? '');
        assert.ok(sessionId, 'session id present');

        // Subscribe BEFORE any input: backlog + live chunks go through one
        // cross-chunk redactor instance. Read until the session's `close`
        // event — the handler flushes the held tail before it.
        const streamDone = readSse(
          port,
          sessionId,
          (frames) => frames.some((f) => f.event === 'close'),
          60_000,
        );
        await sleep(1200); // let interactive bash settle

        const input = async (data: string): Promise<void> => {
          const r = await api(port, 'POST', `/api/terminal/sessions/${sessionId}/input`, { data });
          assert.equal(r.status, 200, `input accepted: ${data.slice(0, 40)}`);
        };

        await input('stty -echo\n');
        await sleep(800);

        // Four full secret prints, shell-side sleeps between them → four
        // separate pty data events → four redactor pushes. The first push
        // holds (carry), the next three each emit a hit, and the close
        // flush emits the last → 4 detection events ≥ threshold 3.
        await input(
          `printf '%s' "$WALK_B51_S"; sleep 0.7; printf '%s' "$WALK_B51_S"; sleep 0.7; printf '%s' "$WALK_B51_S"; sleep 0.7; printf '%s' "$WALK_B51_S"\n`,
        );
        await sleep(4000);
        t.diagnostic('4 full secret prints emitted (0.7s apart)');

        await input('exit\n');
        const frames = await streamDone;
        assert.ok(frames.some((f) => f.event === 'close'), 'stream ended with a close event');
        const text = decodedOutput(frames);

        // E1: the escalation precondition — ≥3 detection events for this
        // session, audited, never carrying secret content.
        const audit = await api(port, 'GET', '/api/audit?limit=2000');
        assert.equal(audit.status, 200, 'audit readable');
        const hits = auditRecords(audit.body).filter((r) => r['action'] === 'SECRET_REDACTED_HIT');
        const sessionHits = hits.filter((r) => r['entityId'] === sessionId);
        assert.ok(
          sessionHits.length >= 3,
          `E1: expected ≥3 detection events for the session, got ${sessionHits.length}`,
        );
        for (const h of sessionHits) {
          assert.equal(h['entityType'], 'terminal');
        }
        const hitsJson = JSON.stringify(sessionHits);
        assert.ok(!hitsJson.includes(secret), 'E1: audit never carries secret content');
        t.diagnostic(`E1: ${sessionHits.length} SECRET_REDACTED_HIT events for the session`);

        // E2: exactly one OPEN security-issue row from redaction-monitor.
        const r = await api(port, 'GET', '/api/needs-human?status=open');
        assert.equal(r.status, 200, 'needs-human readable');
        const items = (r.body['items'] ?? []) as Array<Json>;
        const escalations = items.filter(
          (row) =>
            row['reason'] === 'security-issue' &&
            String(row['source'] ?? '').startsWith(`redaction-monitor:terminal:`),
        );
        assert.equal(
          escalations.length,
          1,
          `E2: expected exactly one redaction-monitor escalation row, got ${escalations.length}`,
        );
        const row = escalations[0];
        assert.equal(row['status'], 'open');
        assert.equal(row['requiredDeciderLevel'], 'operator');
        t.diagnostic(`E2: escalation row ${String(row['id']).slice(0, 8)}… OPEN, operator level`);

        // E3: the honest narrative survived persistence into detailJson.
        const detail = JSON.parse(String(row['detailJson'] ?? '{}')) as Json;
        const narrative = String(detail['narrative'] ?? '');
        assert.ok(
          narrative.includes('human judgment needed'),
          `E3: narrative carries the honest qualifier, got: ${narrative.slice(0, 160)}`,
        );
        assert.ok(
          narrative.includes('can be benign'),
          'E3: narrative admits a single hit can be benign',
        );
        assert.ok(!narrative.includes(secret), 'E3: narrative never carries secret content');
        t.diagnostic('E3: honest narrative persisted in detailJson.narrative');

        // E4: the Batch 48 guarantee holds — zero secret bytes in the
        // stream, and the aggregated pattern (not one hit) is what fired.
        assert.ok(!text.includes(secret), 'E4: no secret bytes in the SSE stream');
        assert.ok(text.includes('***'), 'E4: redaction markers present in the stream');
        const raised = auditRecords(audit.body).filter(
          (rr) => rr['action'] === 'NEEDS_HUMAN_RAISED' && rr['entityId'] === row['id'],
        );
        assert.ok(raised.length >= 1, 'E4: NEEDS_HUMAN_RAISED audited for the escalation row');
      } finally {
        child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

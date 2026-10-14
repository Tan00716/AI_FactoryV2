/**
 * First-run walkthrough: redaction leg (Batch 49).
 *
 * The walkthrough series (v1–v8) never covered secret redaction; Batch 48
 * made the terminal SSE stream cross-chunk safe (createCrossChunkRedactor:
 * each push only commits matches ending before len-carryLen, and the
 * emitter pulls back to the start of any in-progress match — proven
 * airtight, incl. the short-is-prefix-of-long overlap case).
 *
 * This leg drives it end to end over pure HTTP against a real server with
 * a real pty: store real secrets in the hermetic file vault, create a
 * terminal session with secretEnv refs, and emit each secret SPLIT across
 * two pty writes. The split is forced deterministically — one input line
 * runs `printf <first half>; sleep 0.7; printf <second half>`, so the two
 * halves are contiguous in the transcript (no shell prompt between them)
 * but arrive as two separate pty data events (0.7s apart) → two separate
 * redactor pushes. A single SSE subscription reads to the session's
 * `close` event; the handler flushes the held tail BEFORE the close frame,
 * so the collected text is the complete redacted transcript.
 *
 * Legs (one `it`, pure HTTP, zero mocks):
 *   R1 — a realistic token split mid-value across two chunks → fully
 *          redacted, no remnant, `***` present.
 *   R2 — prefix-overlap pair (short value is a strict prefix of the long
 *          one): emit the long one with the split exactly at the
 *          short/long boundary → longest-first match, no partial
 *          `-longer` tail leaks (the Batch 48 unit test's `xxAB|CDEFyy`
 *          scenario, live).
 *   R3 — no duplication / no loss: with `stty -echo` the marker line is
 *          emitted exactly once in the collected stream.
 *   R4 — SECRET_REDACTED_HIT detection events exist in /api/audit
 *          (entity_type 'terminal', entity_id = the session) and never
 *          carry secret content.
 *
 * Hermeticity: temp DB + temp FACTORY_SECRETS_DIR (never the developer's
 * local vault). Dual-mode: node builtins + fetch only, zero src imports.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = 'admin-walk-redact-zzz';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

type Json = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bootServer(): Promise<{ child: ChildProcess; port: number; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-walk-redact-'));
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: join(dir, 'factory.db'),
    FACTORY_API_TOKENS: `admin:${ADMIN}`,
    // Hermetic secrets: the R-legs store real secrets in this temp vault.
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

describe('first-run walkthrough: redaction leg — cross-chunk secrets over SSE (Batch 49)', () => {
  it(
    'split secrets are redacted across chunks, with no loss or duplication',
    { timeout: 120_000 },
    async (t) => {
      const { child, port, dir } = await bootServer();
      try {
        const ts = Date.now();
        const secretA = `walk-b49-sentinel-${ts}`;
        const secretB = 'walk-b49-pre';
        const secretC = 'walk-b49-pre-longer'; // secretB is a strict prefix of secretC
        const marker = `m${ts.toString(36)}`;

        // Store real secrets; responses are metadata only.
        const stored: Array<[string, string]> = [
          ['walk-b49-leak', secretA],
          ['walk-b49-pre', secretB],
          ['walk-b49-prelong', secretC],
        ];
        for (const [name, value] of stored) {
          const put = await api(port, 'PUT', `/api/secrets/${name}`, {
            value,
            purpose: 'walkthrough-b49-redaction',
          });
          assert.equal(put.status, 200, `secret ${name} stored`);
          assert.ok(!('value' in put.body), 'PUT response is metadata only');
        }
        t.diagnostic('3 secrets stored in the hermetic vault');

        // Create a terminal session with secretEnv refs (values injected
        // into the pty env AND registered as redaction values).
        const created = await api(port, 'POST', '/api/terminal/sessions', {
          principal: 'human',
          shell: ['/bin/bash', '-i'],
          rows: 24,
          cols: 80,
          secretEnv: {
            WALK_B49_A: 'walk-b49-leak',
            WALK_B49_B: 'walk-b49-pre',
            WALK_B49_C: 'walk-b49-prelong',
          },
        });
        assert.equal(created.status, 201, 'terminal session created');
        const sessionId = String((created.body as Json)['id'] ?? '');
        assert.ok(sessionId, 'session id present');

        // Subscribe BEFORE any input: backlog + live chunks go through one
        // cross-chunk redactor instance. Read until the session's `close`
        // event — the handler flushes the held tail before it, so the
        // collected text is the complete redacted transcript.
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

        // Echo off: command lines are not echoed back, so the NORMAL
        // marker below can be asserted exactly-once. (This line itself is
        // still echoed — echo was on when it was typed — and carries no
        // secret.)
        await input('stty -echo\n');
        await sleep(800);

        // R1: realistic token, split mid-value across two pty writes. One
        // input line runs both printfs with a shell-side sleep between, so
        // the halves are contiguous in the transcript (no prompt between)
        // but arrive as two separate pty data events → two redactor pushes.
        await input(`printf '%s' "\${WALK_B49_A:0:12}"; sleep 0.7; printf '%s' "\${WALK_B49_A:12}"\n`);
        await sleep(1500);
        t.diagnostic('R1 emitted: secret A in two halves (12 + rest)');

        // R2: prefix-overlap — split exactly at the short/long boundary, so
        // the first chunk ends with the complete short value `walk-b49-pre`.
        // Longest-first matching must claim the long value; the `-longer`
        // tail must not leak (the Batch 48 `xxAB|CDEFyy` scenario, live).
        await input(`printf '%s' "\${WALK_B49_C:0:12}"; sleep 0.7; printf '%s' "\${WALK_B49_C:12}"\n`);
        await sleep(1500);
        t.diagnostic('R2 emitted: secret C split at the B/C boundary');

        // R3: plain marker line for the no-duplication / no-loss check.
        await input(`printf 'NORMAL-${marker}\\n'\n`);
        await sleep(800);

        // End the shell: pty close → SSE handler flushes the held tail,
        // then the `close` frame.
        await input('exit\n');
        const frames = await streamDone;
        assert.ok(frames.some((f) => f.event === 'close'), 'stream ended with a close event');
        const text = decodedOutput(frames);
        t.diagnostic(`collected ${text.length} chars of redacted transcript`);

        // R1: the split token is fully redacted — no remnant anywhere.
        assert.ok(!text.includes(secretA), 'R1: secret A fully redacted (no cross-chunk remnant)');
        // R2: the long value is gone too, and specifically no partial
        // `-longer` tail leaked past a short-value match.
        assert.ok(!text.includes(secretC), 'R2: secret C fully redacted');
        assert.ok(!text.includes('-longer'), 'R2: no partial tail of the long secret leaked');
        assert.ok(!text.includes(secretB), 'R2: short secret value never appears standalone');
        const redactionMarks = text.split('***').length - 1;
        assert.ok(redactionMarks >= 2, `expected ≥2 redaction markers, got ${redactionMarks}`);
        t.diagnostic(`R1+R2: ${redactionMarks} redaction markers, zero secret bytes in stream`);

        // R3: the marker line appears exactly once — the redactor neither
        // duplicated nor dropped output (echo was off, so the command line
        // itself is not in the transcript).
        const normalCount = text.split(`NORMAL-${marker}`).length - 1;
        assert.equal(normalCount, 1, 'R3: marker line appears exactly once (no duplication, no loss)');

        // R4: detection events are audited and never carry secret content.
        const audit = await api(port, 'GET', '/api/audit?limit=2000');
        assert.equal(audit.status, 200, 'audit readable');
        const hits = auditRecords(audit.body).filter((r) => r['action'] === 'SECRET_REDACTED_HIT');
        assert.ok(hits.length >= 1, `R4: at least one detection event, got ${hits.length}`);
        for (const h of hits) {
          assert.equal(h['entityType'], 'terminal');
          assert.equal(h['entityId'], sessionId);
        }
        const hitsJson = JSON.stringify(hits);
        assert.ok(!hitsJson.includes(secretA), 'R4: audit never carries secret A');
        assert.ok(!hitsJson.includes(secretB), 'R4: audit never carries secret B');
        assert.ok(!hitsJson.includes(secretC), 'R4: audit never carries secret C');
        t.diagnostic(`R4: ${hits.length} SECRET_REDACTED_HIT events, all terminal-scoped, no secret content`);
      } finally {
        child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

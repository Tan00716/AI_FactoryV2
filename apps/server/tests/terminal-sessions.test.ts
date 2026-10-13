/**
 * Interactive terminal session server tests — Batch 19 (§50.1).
 *
 * Two layers:
 *  1. Pure classification: requiredRoleFor on the /api/terminal/*
 *     surface (reads viewer, writes operator — the global default).
 *  2. The real server binary (dist/index.js) booted over a temp DB:
 *       - session lifecycle over HTTP: create → list → input →
 *         SSE stream shows the output → resize → `stty size` reads
 *         the new dimensions back → close;
 *       - AI principal line gating: an allowed line runs, a denied
 *         line is refused (SSE 'denied' event) and never reaches the
 *         pty;
 *       - principal isolation: two sessions never cross streams;
 *       - RBAC: viewer cannot create (403), anonymous gets 401.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredRoleFor } from '../src/auth.ts';

const VIEWER = 'viewer-terminal-aaa';
const OPERATOR = 'operator-terminal-bbb';
const ADMIN = 'admin-terminal-ccc';

describe('requiredRoleFor /api/terminal/* (§50.1 RBAC classification)', () => {
  it('reads are viewer, writes are operator', () => {
    assert.equal(requiredRoleFor('GET', '/api/terminal/sessions'), 'viewer');
    assert.equal(requiredRoleFor('GET', '/api/terminal/sessions/abc'), 'viewer');
    assert.equal(requiredRoleFor('GET', '/api/terminal/sessions/abc/stream'), 'viewer');
    assert.equal(requiredRoleFor('POST', '/api/terminal/sessions'), 'operator');
    assert.equal(requiredRoleFor('POST', '/api/terminal/sessions/abc/input'), 'operator');
    assert.equal(requiredRoleFor('POST', '/api/terminal/sessions/abc/resize'), 'operator');
    assert.equal(requiredRoleFor('DELETE', '/api/terminal/sessions/abc'), 'operator');
  });
});

// ------------------------------------------------------- real server (e2e) --

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

interface Booted {
  child: ChildProcess;
  port: number;
  dir: string;
}

async function bootRealServer(extraEnv: Record<string, string>): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-terminal-e2e-'));
  const port = 26_000 + Math.floor(Math.random() * 18_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: join(dir, 'factory.db'),
    ...extraEnv,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_API_TOKENS']) {
    if (!(k in extraEnv)) delete env[k];
  }
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
    await new Promise((r) => setTimeout(r, 150));
  }
}

function headers(token?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

interface SseFrame {
  event: string;
  data: string;
}

/** Minimal SSE reader over fetch: collects frames until `until` says stop. */
async function readSse(
  port: number,
  sessionId: string,
  token: string,
  until: (frames: SseFrame[]) => boolean,
  timeoutMs = 20_000,
): Promise<SseFrame[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${sessionId}/stream`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
  });
  assert.equal(res.status, 200, 'SSE stream must open');
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
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
          `SSE wait timed out; frames so far: ${JSON.stringify(frames.map((f) => ({ event: f.event, data: f.data.slice(0, 120) })))}`,
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

describe('terminal sessions e2e (§50.1)', () => {
  it('full lifecycle: create → input → SSE output → resize → close', async function () {
    const { child, port, dir } = await bootRealServer({
      FACTORY_API_TOKENS: `viewer:${VIEWER},operator:${OPERATOR},admin:${ADMIN}`,
    });
    try {
      // anonymous → 401
      {
        const r = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({}),
        });
        assert.equal(r.status, 401);
      }
      // viewer → 403 on the write surface
      {
        const r = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions`, {
          method: 'POST',
          headers: headers(VIEWER),
          body: JSON.stringify({ shell: ['/bin/sh'] }),
        });
        assert.equal(r.status, 403);
      }

      const created = await (
        await fetch(`http://127.0.0.1:${port}/api/terminal/sessions`, {
          method: 'POST',
          headers: headers(OPERATOR),
          body: JSON.stringify({ principal: 'human', shell: ['/bin/sh'], rows: 24, cols: 80 }),
        })
      ).json() as { id: string; principal: string; rows: number; cols: number };
      assert.ok(created.id);
      assert.equal(created.principal, 'human');
      assert.equal(created.rows, 24);

      const list = (await (
        await fetch(`http://127.0.0.1:${port}/api/terminal/sessions`, { headers: headers(VIEWER) })
      ).json()) as { sessions: Array<{ id: string }> };
      assert.ok(list.sessions.some((s) => s.id === created.id));

      // input + streamed output
      const marker = `e2e-marker-${Date.now()}`;
      const streamPromise = readSse(
        port,
        created.id,
        OPERATOR,
        (frames) => decodedOutput(frames).includes(marker),
      );
      await new Promise((r) => setTimeout(r, 300));
      const inputRes = await fetch(
        `http://127.0.0.1:${port}/api/terminal/sessions/${created.id}/input`,
        {
          method: 'POST',
          headers: headers(OPERATOR),
          body: JSON.stringify({ data: `echo ${marker}\n` }),
        },
      );
      assert.equal(inputRes.status, 200);
      const frames = await streamPromise;
      assert.ok(decodedOutput(frames).includes(marker), 'SSE stream must carry the command output');

      // resize is real: stty size reads the new dimensions back
      const resizeRes = await fetch(
        `http://127.0.0.1:${port}/api/terminal/sessions/${created.id}/resize`,
        {
          method: 'POST',
          headers: headers(OPERATOR),
          body: JSON.stringify({ rows: 40, cols: 120 }),
        },
      );
      assert.equal(resizeRes.status, 200);
      const sizeBody = (await resizeRes.json()) as { rows: number; cols: number };
      assert.equal(sizeBody.rows, 40);
      const sizeMarker = `size-${Date.now()}`;
      const stream2 = readSse(
        port,
        created.id,
        OPERATOR,
        (f2) => decodedOutput(f2).includes('40 120'),
      );
      await new Promise((r) => setTimeout(r, 300));
      await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${created.id}/input`, {
        method: 'POST',
        headers: headers(OPERATOR),
        body: JSON.stringify({ data: `stty size; echo ${sizeMarker}\n` }),
      });
      const frames2 = await stream2;
      assert.ok(
        decodedOutput(frames2).includes('40 120'),
        'resized session must report the new size via stty',
      );

      // close
      const delRes = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${created.id}`, {
        method: 'DELETE',
        headers: headers(OPERATOR),
      });
      assert.equal(delRes.status, 200);
      const after = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${created.id}`, {
        headers: headers(VIEWER),
      });
      assert.equal(after.status, 404);
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ai sessions are line-gated: denied lines never reach the pty', async () => {
    const { child, port, dir } = await bootRealServer({
      FACTORY_API_TOKENS: `operator:${OPERATOR},admin:${ADMIN}`,
    });
    try {
      const created = (await (
        await fetch(`http://127.0.0.1:${port}/api/terminal/sessions`, {
          method: 'POST',
          headers: headers(OPERATOR),
          body: JSON.stringify({ principal: 'ai', shell: ['/bin/sh'] }),
        })
      ).json()) as { id: string };
      assert.ok(created.id);

      const okMarker = `ai-ok-${Date.now()}`;
      const framesPromise = readSse(
        port,
        created.id,
        OPERATOR,
        (frames) =>
          decodedOutput(frames).includes(okMarker) &&
          frames.some((f) => f.event === 'denied'),
      );
      await new Promise((r) => setTimeout(r, 300));
      await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${created.id}/input`, {
        method: 'POST',
        headers: headers(OPERATOR),
        body: JSON.stringify({ data: `echo ${okMarker}\n` }),
      });
      await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${created.id}/input`, {
        method: 'POST',
        headers: headers(OPERATOR),
        body: JSON.stringify({ data: 'rm -rf /\n' }),
      });
      const frames = await framesPromise;
      const denied = frames.find((f) => f.event === 'denied');
      assert.ok(denied, 'a denied line must surface as an SSE denied event');
      const deniedBody = JSON.parse(denied!.data) as { line: string; reason: string };
      assert.equal(deniedBody.line, 'rm -rf /');
      assert.match(deniedBody.reason, /execution safety policy/);
      const out = decodedOutput(frames);
      assert.ok(out.includes(okMarker), 'the allowed line must run');
      assert.ok(!out.includes('rm -rf /'), 'the denied line must never reach the terminal');

      await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${created.id}`, {
        method: 'DELETE',
        headers: headers(OPERATOR),
      });
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('concurrent sessions are isolated per principal', async () => {
    const { child, port, dir } = await bootRealServer({
      FACTORY_API_TOKENS: `operator:${OPERATOR}`,
    });
    try {
      const mk = async (principal: string): Promise<string> => {
        const b = (await (
          await fetch(`http://127.0.0.1:${port}/api/terminal/sessions`, {
            method: 'POST',
            headers: headers(OPERATOR),
            body: JSON.stringify({ principal, shell: ['/bin/sh'] }),
          })
        ).json()) as { id: string };
        return b.id;
      };
      const a = await mk('human');
      const b = await mk('ai');
      const markerA = `iso-A-${Date.now()}`;
      const markerB = `iso-B-${Date.now()}`;
      const [fa, fb] = await Promise.all([
        readSse(port, a, OPERATOR, (f) => decodedOutput(f).includes(markerA)),
        readSse(port, b, OPERATOR, (f) => decodedOutput(f).includes(markerB)),
        (async () => {
          await new Promise((r) => setTimeout(r, 300));
          await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${a}/input`, {
            method: 'POST',
            headers: headers(OPERATOR),
            body: JSON.stringify({ data: `echo ${markerA}\n` }),
          });
          await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${b}/input`, {
            method: 'POST',
            headers: headers(OPERATOR),
            body: JSON.stringify({ data: `echo ${markerB}\n` }),
          });
        })(),
      ]);
      assert.ok(!decodedOutput(fa).includes(markerB));
      assert.ok(!decodedOutput(fb).includes(markerA));

      for (const sid of [a, b]) {
        await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${sid}`, {
          method: 'DELETE',
          headers: headers(OPERATOR),
        });
      }
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

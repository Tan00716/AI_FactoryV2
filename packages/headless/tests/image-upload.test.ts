/**
 * Headless --image upload tests (W-E) — mock HttpClient, temp png file.
 * Run: node --test packages/headless/dist/tests/*.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  execCommand,
  uploadTaskImage,
  EXIT_OK,
  EXIT_FAILED,
  type HttpClient,
  type HttpResult,
} from '../src/index.js';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function mockClient(handler: (method: string, p: string, body?: unknown) => HttpResult): HttpClient {
  return {
    request(method: string, p: string, body?: unknown): Promise<HttpResult> {
      return Promise.resolve(handler(method, p, body));
    },
  };
}

function writePng(dir: string, name = 'shot.png'): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(PNG_B64, 'base64'));
  return p;
}

test('uploadTaskImage posts base64 to the attachments endpoint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-hl-img-'));
  try {
    const file = writePng(dir);
    let seen: { method: string; path: string; body: unknown } | null = null;
    const http = mockClient((method, p, body) => {
      seen = { method, path: p, body };
      return { status: 201, body: { attachment: { id: 'x' } } };
    });
    await uploadTaskImage(http, 'task-1', file);
    assert.ok(seen);
    assert.equal((seen as { method: string }).method, 'POST');
    assert.equal((seen as { path: string }).path, '/api/tasks/task-1/attachments');
    const body = (seen as { body: unknown }).body as Record<string, unknown>;
    assert.equal(body['filename'], 'shot.png');
    assert.equal(body['mimeType'], 'image/png');
    assert.equal(body['dataBase64'], PNG_B64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uploadTaskImage rejects missing files, bad extensions, oversize', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-hl-img-'));
  const http = mockClient(() => ({ status: 201, body: {} }));
  try {
    await assert.rejects(() => uploadTaskImage(http, 't', path.join(dir, 'nope.png')), /not found/);
    const txt = path.join(dir, 'note.txt');
    fs.writeFileSync(txt, 'hello');
    await assert.rejects(() => uploadTaskImage(http, 't', txt), /unsupported image type/);
    const big = path.join(dir, 'big.png');
    fs.writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
    await assert.rejects(() => uploadTaskImage(http, 't', big), /exceeds 10 MiB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exec --image uploads before the run; upload failure is loud', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-hl-img-'));
  try {
    const file = writePng(dir);
    const calls: string[] = [];
    const http = mockClient((method, p) => {
      calls.push(`${method} ${p}`);
      if (p === '/api/projects') return { status: 200, body: [{ id: 'proj-1' }] };
      if (p === '/api/tasks') return { status: 201, body: { id: 'task-9' } };
      if (p === '/api/agents') return { status: 200, body: [{ id: 'agent-1' }] };
      if (p.endsWith('/attachments')) return { status: 201, body: { attachment: { id: 'a1' } } };
      if (p === '/api/runtime/runs') return { status: 202, body: { id: 'run-1' } };
      if (p === '/api/runtime/runs/run-1') return { status: 200, body: { status: 'COMPLETED' } };
      return { status: 404, body: {} };
    });
    const ok = await execCommand(
      { prompt: 'look at this', images: [file], json: false, timeoutMs: 5000, pollMs: 10 },
      http,
    );
    assert.equal(ok.exitCode, EXIT_OK);
    assert.ok(calls.includes('POST /api/tasks/task-9/attachments'), `calls: ${calls.join(',')}`);

    const badCalls: string[] = [];
    const badHttp = mockClient((method, p) => {
      badCalls.push(`${method} ${p}`);
      if (p === '/api/projects') return { status: 200, body: [{ id: 'proj-1' }] };
      if (p === '/api/tasks') return { status: 201, body: { id: 'task-9' } };
      if (p === '/api/agents') return { status: 200, body: [{ id: 'agent-1' }] };
      return { status: 404, body: {} };
    });
    const bad = await execCommand(
      { prompt: 'look at this', images: [path.join(dir, 'missing.png')], json: false, timeoutMs: 5000, pollMs: 10 },
      badHttp,
    );
    assert.equal(bad.exitCode, EXIT_FAILED);
    assert.match(String((bad.output as unknown[])[0]), /not found/);
    // The run must not have started when the upload failed.
    assert.ok(!badCalls.some((c) => c === 'POST /api/runtime/runs'), `calls: ${badCalls.join(',')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

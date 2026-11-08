/**
 * V3.0 audit round 20, item #6 sub-item (t) — datapreview entry
 * control-directory exclusion (R20 N1, P1).
 *
 * POST /api/datapreview/preview had no control-plane exclusion: its
 * only jail was lexical resolve + startsWith, and the vault lives
 * INSIDE the default inspection root (<cwd>/data/secrets), so an
 * operator could read vault.key + vault.json with zero prerequisites
 * (explicit format:'csv' bypassed the extension gate; the key came
 * back as a CSV column name, the ciphertext lines as row cells).
 *
 * The fix (routes/datapreview.ts): decide on the canonical path and
 * refuse anything under the secrets directory — FACTORY_SECRETS_DIR
 * when set, else <dirname(DB_PATH)>/secrets — before the format gate
 * and before any read. The rest of the data dir stays previewable:
 * the route's legitimate purpose is previewing data files, and the
 * audit probes place their legit .jsonl fixtures directly under data/.
 *
 * This test boots the real server (dist) with a synthetic vault and
 * asserts the refusal on the live route, plus the legit preview and
 * the sibling editor route as controls. It fails on the pre-fix tree
 * (vault.key / vault.json return 200 with the markers) and passes
 * post-fix.
 *
 * Run: npm run build && node scripts/run-tests-tmp.mjs --test apps/server/tests/v3r20-6t.test.ts
 * (requires a server build first — the server boots from dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

const TOKEN = 'v3r20-6t-probe-token-1234567890';
const KEY_MARKER = 'VjNyMjBUK0VZLU1BUktFUi03ZjNhOWIyZDU4YzE=';
const DATA_MARKER = 'VjNyMjBUREFUQS1NQVJLRVItNWUxYWJjZDRlNjdmYzIwMTIzNDU2Nzg5MA==';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('V3R20 #6(t): datapreview refuses the vault (direct, symlink, and no-format legs) but keeps legit previews', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r20-6t-'));
  const proj = path.join(dir, 'proj');
  const secretsDir = path.join(proj, 'data', 'secrets');
  fs.mkdirSync(secretsDir, { recursive: true });
  const vaultJson = {
    version: 1,
    entries: {
      FACTORY_API_TOKEN: {
        iv: 'AAAAAAAAAAAAAAAAAAAAAA==',
        tag: 'BBBBBBBBBBBBBBBBBBBBBB==',
        data: DATA_MARKER,
        updatedAt: '2026-11-06T00:00:00.000Z',
      },
    },
  };
  fs.writeFileSync(path.join(secretsDir, 'vault.json'), JSON.stringify(vaultJson, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(secretsDir, 'vault.key'), KEY_MARKER + '\n', 'utf8');
  fs.writeFileSync(
    path.join(proj, 'data', 'notes.jsonl'),
    JSON.stringify({ a: 1 }) + '\n' + JSON.stringify({ a: 2 }) + '\n',
    'utf8',
  );
  fs.symlinkSync(path.join(secretsDir, 'vault.json'), path.join(proj, 'evil.jsonl'), 'file');

  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.JARVIS_TRACE_CONTEXT;
  delete env.JARVIS_RUNTIME_CONTEXT_TOKEN;
  env.PORT = String(port);
  env.DB_PATH = path.join(proj, 'data', 'factory.db');
  env.AI_FACTORY_DATA_DIR = path.join(proj, 'data');
  env.FACTORY_SECRETS_DIR = secretsDir;
  env.FACTORY_ALLOW_OPEN_LOCAL = '1';
  env.FACTORY_API_TOKEN = TOKEN;
  const proc: ChildProcess = spawn(process.execPath, [serverEntry], {
    env,
    cwd: proj,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error('server did not start in 30s');
      try {
        await new Promise<void>((resolve, reject) => {
          const s = net.connect(port, '127.0.0.1');
          s.once('connect', () => {
            s.end();
            resolve();
          });
          s.once('error', reject);
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // T1: vault.key via explicit csv — refused (pre-fix: 200, key as columns[0]).
    const t1 = await api(port, 'POST', '/api/datapreview/preview', {
      path: 'data/secrets/vault.key',
      format: 'csv',
    });
    assert.equal(t1.status, 403, `vault.key csv not refused: ${JSON.stringify(t1.body)}`);
    assert.equal(t1.body?.columns?.[0] ?? null, null, 'vault.key marker leaked in columns');

    // T2: vault.json via explicit csv — refused (pre-fix: 200, ciphertext cell in rows).
    const t2 = await api(port, 'POST', '/api/datapreview/preview', {
      path: 'data/secrets/vault.json',
      format: 'csv',
    });
    assert.equal(t2.status, 403, `vault.json csv not refused: ${JSON.stringify(t2.body)}`);
    const t2cells = (t2.body?.rows ?? []).flat();
    assert.equal(
      t2cells.includes(`      "data": "${DATA_MARKER}"`),
      false,
      'vault.json ciphertext marker leaked in rows',
    );

    // T3: symlink leg — evil.jsonl -> vault.json — refused (pre-fix: 200).
    const t3 = await api(port, 'POST', '/api/datapreview/preview', {
      path: 'evil.jsonl',
      format: 'csv',
    });
    assert.equal(t3.status, 403, `symlink vault.json csv not refused: ${JSON.stringify(t3.body)}`);

    // T4: vault.key with no explicit format — refused by the guard
    // before the format gate (pre-fix: 415 from the extension gate).
    const t4 = await api(port, 'POST', '/api/datapreview/preview', {
      path: 'data/secrets/vault.key',
    });
    assert.equal(t4.status, 403, `vault.key without format not refused: ${JSON.stringify(t4.body)}`);

    // T5 (control): legitimate preview still works.
    const t5 = await api(port, 'POST', '/api/datapreview/preview', {
      path: 'data/notes.jsonl',
      format: 'jsonl',
    });
    assert.equal(t5.status, 200, `legit jsonl preview broke: ${JSON.stringify(t5.body)}`);
    assert.equal((t5.body?.rows ?? []).length, 2, 'legit jsonl preview row count changed');

    // T6 (control): the sibling editor route refuses the same path.
    const t6 = await api(port, 'GET', '/api/file?path=data/secrets/vault.key');
    assert.equal(t6.status, 403, `GET /api/file vault.key not refused: ${JSON.stringify(t6.body)}`);
  } finally {
    proc.kill('SIGKILL');
    await new Promise((resolve) => proc.once('exit', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

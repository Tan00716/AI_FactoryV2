/**
 * W-C P0: /api/file control-plane guard (H3-A4 probe).
 *
 * Finding (confirmed live): POST /api/file had NO control-plane
 * guard — any local API caller could write data/factory.db (and
 * secrets/, snapshots/, …) via {path: 'data/factory.db'}, i.e.
 * full database replacement including the audit chain. GET happened
 * to block .db reads via the binary check, but writes were open.
 *
 * This pins: with the server's cwd as workspace root and the DEFAULT
 * DB_PATH (./data/factory.db → <cwd>/data), the control-plane tree
 * is refused on all three file surfaces —
 *   POST /api/file {path:'data/x'}        → 403 (+ FILE_WRITE_DENIED audit)
 *   GET  /api/file?path=data/x            → 403
 *   GET  /api/files?root=data             → 403
 * — while legitimate workspace writes/reads still work.
 *
 * Requires the workspace build: boots ../dist/index.js with cwd set
 * to a temp dir (so the default data/ dir is hermetic).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
let child: ChildProcess | null = null;
let port = 0;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

after(() => {
  child?.kill('SIGKILL');
});

await (async () => {
  // cwd = temp dir → WORKSPACE_ROOT = temp, default DB_PATH
  // ./data/factory.db → <temp>/data (the guarded tree).
  const workRoot = mkdtempSync(join(homedir(), 'wc-fileguard-'));
  port = 24000 + Math.floor(Math.random() * 20000);
  child = spawn(process.execPath, [serverMain], {
    cwd: workRoot,
    env: {
      ...process.env,
      PORT: String(port),
      FACTORY_SECRETS_DIR: join(workRoot, 'secrets-test'),
      TMPDIR: tmpdir(),
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not boot');
    await new Promise((r) => setTimeout(r, 200));
  }
})();

describe('W-C P0: control-plane file guard', () => {
  it("POST /api/file refuses writes under data/ (was: full DB overwrite)", async () => {
    const r = await api('POST', '/api/file', { path: 'data/wc-p0.txt', content: 'x', actor: 'agent:rogue' });
    assert.equal(r.status, 403);
    assert.match((r.json as { error: string }).error, /control-plane/);
  });

  it('POST /api/file refuses the DB file itself', async () => {
    const r = await api('POST', '/api/file', { path: 'data/factory.db', content: 'x' });
    assert.equal(r.status, 403);
  });

  it('GET /api/file refuses reads under data/', async () => {
    const r = await api('GET', '/api/file?path=data/wc-p0.txt');
    assert.equal(r.status, 403);
  });

  it('GET /api/files refuses listing data/', async () => {
    const r = await api('GET', '/api/files?root=data');
    assert.equal(r.status, 403);
  });

  it('legitimate workspace writes still work', async () => {
    const w = await api('POST', '/api/file', { path: 'notes/hello.txt', content: 'hi' });
    assert.equal(w.status, 200);
    const r = await api('GET', '/api/file?path=notes/hello.txt');
    assert.equal(r.status, 200);
    assert.equal((r.json as { content: string }).content, 'hi');
  });

  it('path traversal outside the workspace is still refused', async () => {
    const r = await api('POST', '/api/file', { path: '../escape.txt', content: 'x' });
    assert.equal(r.status, 403);
  });
});

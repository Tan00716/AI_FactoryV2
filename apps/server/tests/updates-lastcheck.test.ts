/**
 * Persisted update lastCheck HTTP tests (V3.0 audit round 3, item #10) —
 * boots the real server (dist) with an isolated DB/data dir:
 *
 *   unconfigured: status feedConfigured false + lastCheck null;
 *                 POST check => not-configured, persisted to disk
 *   restart:      status still shows the same lastCheck `at` (no re-check)
 *   corrupt file: status lastCheckCorrupt true + lastCheck null, and the
 *                 next check overwrites the file with a valid record
 *   configured:   fresh dir + local feed => status lastCheck null
 *                 (configured-but-never-checked); POST check => up-to-date,
 *                 persisted; restart keeps it
 *   failed:       feed serving garbage => POST check => feed-error,
 *                 persisted as the failed state (not "up to date")
 *
 * Feed is served by an in-test loopback HTTP server (loopback is always
 * egress-allowed); the served version equals the repo version (0.2.0),
 * so a well-formed feed yields up-to-date.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/updates-lastcheck.test.ts
 * (requires a server build first — the server boots from dist).
 * Temp base is $HOME, never /tmp (512MB tmpfs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

const GOOD_FEED = `# electron-builder generic provider
version: 0.2.0
files:
  - url: AI-Factory-0.2.0.AppImage
    sha512: abc123
    size: 134217728
path: AI-Factory-0.2.0.AppImage
sha512: abc123
releaseDate: '2026-11-01T10:00:00.000Z'
`;

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
}

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
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(dir: string, extraEnv: Record<string, string>): Promise<Running> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'db', 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
    FACTORY_INSPECT_ROOTS: dir,
    FACTORY_SHADOW_ROOTS: dir,
    FACTORY_ALLOW_OPEN_LOCAL: '1',
    FACTORY_UPDATE_AUTO_CHECK: 'false',
    ...extraEnv,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS', 'BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY']) {
    delete env[k];
  }
  if (!extraEnv['FACTORY_UPDATE_FEED_URL']) delete env['FACTORY_UPDATE_FEED_URL'];
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('server did not start in 30s');
    }
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
  return { port, proc, dir };
}

async function stopServer(r: Running): Promise<void> {
  if (r.proc.exitCode !== null) return;
  r.proc.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => r.proc.once('exit', () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!exited && r.proc.exitCode === null) r.proc.kill('SIGKILL');
  if (r.proc.exitCode === null) {
    await new Promise((resolve) => r.proc.once('exit', resolve));
  }
}

async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('update lastCheck persists across restart; unconfigured/checked/failed states distinct', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'aif-updlast-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lastCheckFile = path.join(dir, 'data', 'update-lastcheck.json');

  // Phase 1: unconfigured — status shows no feed and no lastCheck.
  const srv1 = await startServer(dir, {});
  try {
    const s0 = await api(srv1.port, 'GET', '/api/updates/status');
    assert.equal(s0.status, 200, JSON.stringify(s0.body));
    assert.equal(s0.body.feedConfigured, false);
    assert.equal(s0.body.lastCheck, null);
    assert.equal(s0.body.lastCheckCorrupt, false);
    assert.equal(s0.body.lastCheckPersistError, null);

    const c1 = await api(srv1.port, 'POST', '/api/updates/check');
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    assert.equal(c1.body.result.status, 'not-configured');
    assert.ok(c1.body.lastCheck && typeof c1.body.lastCheck.at === 'number');
    assert.equal(c1.body.lastCheckPersistError, null);
    const at1 = c1.body.lastCheck.at;
    const onDisk = JSON.parse(fs.readFileSync(lastCheckFile, 'utf8'));
    assert.equal(onDisk.at, at1);
    assert.equal(onDisk.result.status, 'not-configured');
  } finally {
    await stopServer(srv1);
  }

  // Phase 2: restart, same data dir — the record survives, no re-check.
  const srv2 = await startServer(dir, {});
  try {
    const s1 = await api(srv2.port, 'GET', '/api/updates/status');
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    assert.equal(s1.body.feedConfigured, false);
    assert.ok(s1.body.lastCheck);
    assert.equal(s1.body.lastCheck.result.status, 'not-configured');
    assert.equal(s1.body.lastCheckCorrupt, false);

    // Phase 3: corrupt file — status reports corruption, check still works and repairs it.
    fs.writeFileSync(lastCheckFile, '{not json', 'utf8');
  } finally {
    await stopServer(srv2);
  }
  const srv3 = await startServer(dir, {});
  try {
    const s2 = await api(srv3.port, 'GET', '/api/updates/status');
    assert.equal(s2.status, 200, JSON.stringify(s2.body));
    assert.equal(s2.body.lastCheck, null);
    assert.equal(s2.body.lastCheckCorrupt, true);
    const c2 = await api(srv3.port, 'POST', '/api/updates/check');
    assert.equal(c2.status, 200, JSON.stringify(c2.body));
    assert.equal(c2.body.lastCheckCorrupt, false);
    const repaired = JSON.parse(fs.readFileSync(lastCheckFile, 'utf8'));
    assert.equal(repaired.result.status, 'not-configured');
  } finally {
    await stopServer(srv3);
  }

  // Phase 4: configured feed — never-checked, then checked, then failed, each persisted.
  let feedBody = GOOD_FEED;
  const feedSrv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(feedBody);
  });
  await new Promise<void>((resolve) => feedSrv.listen(0, '127.0.0.1', resolve));
  t.after(() => feedSrv.close());
  const feedAddr = feedSrv.address();
  assert.ok(feedAddr && typeof feedAddr !== 'string');
  const feedUrl = `http://127.0.0.1:${feedAddr.port}/latest.yml`;
  const dir2 = fs.mkdtempSync(path.join(os.homedir(), 'aif-updlast2-'));
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  const lastCheckFile2 = path.join(dir2, 'data', 'update-lastcheck.json');

  const srv4 = await startServer(dir2, { FACTORY_UPDATE_FEED_URL: feedUrl });
  try {
    const s3 = await api(srv4.port, 'GET', '/api/updates/status');
    assert.equal(s3.status, 200, JSON.stringify(s3.body));
    assert.equal(s3.body.feedConfigured, true);
    assert.equal(s3.body.lastCheck, null);

    const c3 = await api(srv4.port, 'POST', '/api/updates/check');
    assert.equal(c3.status, 200, JSON.stringify(c3.body));
    assert.equal(c3.body.result.status, 'up-to-date');
    const at3 = c3.body.lastCheck.at;

    feedBody = 'this is not a feed';
    const c4 = await api(srv4.port, 'POST', '/api/updates/check');
    assert.equal(c4.status, 200, JSON.stringify(c4.body));
    assert.equal(c4.body.result.status, 'feed-error');
    const failed = JSON.parse(fs.readFileSync(lastCheckFile2, 'utf8'));
    assert.equal(failed.result.status, 'feed-error');
    assert.ok(failed.at >= at3);
  } finally {
    await stopServer(srv4);
  }

  // Restart keeps the failed record (failed is a real check outcome, not "up to date").
  const srv5 = await startServer(dir2, { FACTORY_UPDATE_FEED_URL: feedUrl });
  try {
    const s4 = await api(srv5.port, 'GET', '/api/updates/status');
    assert.equal(s4.status, 200, JSON.stringify(s4.body));
    assert.equal(s4.body.feedConfigured, true);
    assert.equal(s4.body.lastCheck.result.status, 'feed-error');
    assert.equal(s4.body.lastCheckCorrupt, false);
  } finally {
    await stopServer(srv5);
  }
});

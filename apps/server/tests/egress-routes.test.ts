/**
 * Egress firewall HTTP tests — boots the real server (dist) with an
 * isolated DB and exercises the whole feature end to end:
 *
 *   GET  /api/egress/config            default: disabled, no rules
 *   PUT  /api/egress/config (global)   invalid rule → 400
 *   PUT  /api/egress/config (global)   enabled + deny www.bing.com
 *   POST /api/egress/test              dry-run verdicts (deny-rule /
 *                                      allow-rule / default-deny /
 *                                      loopback-exempt)
 *   POST /api/search                   403 EGRESS_BLOCKED (provider
 *                                      pre-check; no network needed —
 *                                      the refusal happens first)
 *   GET  /api/egress/log               the block is recorded
 *   GET  /api/notifications            EGRESS_BLOCKED HIGH notification
 *   PUT  (scope: project) + dry-run    project layer deny beats allow
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/egress-routes.test.ts
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

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
  projDir: string;
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
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-egress-http-'));
  const projDir = path.join(dir, 'projects', 'demo');
  fs.mkdirSync(projDir, { recursive: true });
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS', 'BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY']) {
    delete env[k];
  }
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
  return { port, proc, dir, projDir };
}

async function stopServer(r: Running): Promise<void> {
  r.proc.kill('SIGKILL');
  await new Promise((resolve) => r.proc.once('exit', resolve));
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

test('egress firewall end to end over HTTP', async () => {
  const srv = await startServer();
  try {
    const projectId = 'egress-proj-1';
    {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(srv.dir, 'factory.db'));
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO projects (id, name, description, path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(projectId, 'Egress Demo', '', srv.projDir, 'active', now, now);
      db.close();
    }

    // 1. Default state: disabled, deny default policy, no rules.
    let r = await api(srv.port, 'GET', `/api/egress/config?projectId=${encodeURIComponent(projectId)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.global.enabled, false);
    assert.equal(r.body.global.defaultPolicy, 'deny');
    assert.deepEqual(r.body.global.rules, []);
    assert.equal(r.body.project.rules.length, 0);

    // 2. Invalid rule → 400 with details (wildcard rejected).
    r = await api(srv.port, 'PUT', '/api/egress/config', {
      scope: 'global',
      enabled: true,
      defaultPolicy: 'deny',
      rules: [{ domain: '*.bing.com', action: 'deny' }],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'EGRESS_RULE_INVALID');

    // 3. Enable with deny www.bing.com + allow api.example.com/v1/.
    r = await api(srv.port, 'PUT', '/api/egress/config', {
      scope: 'global',
      enabled: true,
      defaultPolicy: 'deny',
      rules: [
        { domain: 'www.bing.com', action: 'deny' },
        { domain: 'api.example.com', pathPrefix: '/v1/', action: 'allow' },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.global.enabled, true);
    // On disk under the data dir.
    const onDisk = JSON.parse(fs.readFileSync(path.join(srv.dir, 'data', 'egress.json'), 'utf8')) as { rules: unknown[] };
    assert.equal(onDisk.rules.length, 2);

    // 4. Dry-run verdicts.
    r = await api(srv.port, 'POST', '/api/egress/test', { url: 'https://www.bing.com/search?format=rss&q=x' });
    assert.equal(r.status, 200);
    assert.equal(r.body.allowed, false);
    assert.equal(r.body.reason, 'deny-rule');
    assert.equal(r.body.matchedLayer, 'global');
    // subdomain of a denied domain is denied too
    r = await api(srv.port, 'POST', '/api/egress/test', { url: 'https://sub.www.bing.com/x' });
    assert.equal(r.body.allowed, false);
    // allowed by rule (path subtree)
    r = await api(srv.port, 'POST', '/api/egress/test', { url: 'https://api.example.com/v1/models' });
    assert.equal(r.body.allowed, true);
    assert.equal(r.body.reason, 'allow-rule');
    // path outside the allowed subtree → default-deny
    r = await api(srv.port, 'POST', '/api/egress/test', { url: 'https://api.example.com/v2/models' });
    assert.equal(r.body.allowed, false);
    assert.equal(r.body.reason, 'default-deny');
    // loopback exempt
    r = await api(srv.port, 'POST', '/api/egress/test', { url: 'http://127.0.0.1:3100/api/health' });
    assert.equal(r.body.allowed, true);
    assert.equal(r.body.reason, 'loopback-exempt');

    // 5. Web search is refused BEFORE any network call (Bing is the
    // only configured provider here, and it is denied).
    r = await api(srv.port, 'POST', '/api/search', { query: 'egress test query' });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'EGRESS_BLOCKED');

    // 6. The block is in the log…
    r = await api(srv.port, 'GET', '/api/egress/log?limit=10');
    assert.equal(r.status, 200);
    assert.ok(r.body.entries.length >= 1, 'block log has entries');
    assert.equal(r.body.entries[0].hostname, 'www.bing.com');

    // 7. …and produced a HIGH EGRESS_BLOCKED notification.
    r = await api(srv.port, 'GET', '/api/notifications');
    assert.equal(r.status, 200);
    const items = r.body.notifications as Array<{ type: string; priority: string }>;
    const egressNotes = items.filter((n) => n.type === 'EGRESS_BLOCKED');
    assert.ok(egressNotes.length >= 1, 'EGRESS_BLOCKED notification exists');
    assert.equal(egressNotes[0]!.priority, 'HIGH');

    // 8. Project layer: deny api.example.com beats the global allow.
    r = await api(srv.port, 'PUT', '/api/egress/config', {
      scope: 'project',
      projectId,
      rules: [{ domain: 'api.example.com', action: 'deny' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(srv.port, 'POST', '/api/egress/test', {
      url: 'https://api.example.com/v1/models',
      projectId,
    });
    assert.equal(r.body.allowed, false);
    assert.equal(r.body.matchedLayer, 'project');
    // On disk in the project's .ai-factory/egress.json.
    const projFile = JSON.parse(
      fs.readFileSync(path.join(srv.projDir, '.ai-factory', 'egress.json'), 'utf8'),
    ) as { rules: Array<{ domain: string }> };
    assert.equal(projFile.rules[0]!.domain, 'api.example.com');

    // 9. Task layer beats project allow for that task only.
    r = await api(srv.port, 'PUT', '/api/egress/config', {
      scope: 'task',
      projectId,
      taskId: 'task-9',
      taskRules: [{ domain: 'task-only.example', action: 'allow' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(srv.port, 'POST', '/api/egress/test', { url: 'https://task-only.example/x', projectId, taskId: 'task-9' });
    assert.equal(r.body.allowed, true);
    assert.equal(r.body.matchedLayer, 'task');
    r = await api(srv.port, 'POST', '/api/egress/test', { url: 'https://task-only.example/x', projectId });
    assert.equal(r.body.allowed, false); // without the task context → default-deny
  } finally {
    await stopServer(srv);
    fs.rmSync(srv.dir, { recursive: true, force: true });
  }
});

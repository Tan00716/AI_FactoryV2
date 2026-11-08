/**
 * Ignores HTTP tests — boots the real server (dist) with an isolated DB
 * and exercises the two-tier ignore gate end to end:
 *
 *   GET  /api/ignores?projectId=          empty state
 *   PUT  /api/ignores                     writes both layers + audits
 *   GET  /api/ignores/preview             dry-run lists the fake secret
 *   POST /api/codeindex/index + search    the secret is unsearchable
 *   POST /api/context-providers/resolve   @tree does not list it
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/ignores-routes.test.ts
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
  // R20 closeout: the server state dir (DB + data) lives apart from the
  // fixture project. controlPlaneDirs() treats dirname(DB_PATH) as a
  // control dir, and the #6(u) walker fail-closes a root inside one —
  // nesting the fixture under the DB dir (as before) makes codeindex
  // index zero files and the ignore-config files never appear.
  stateDir: string;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-ign-http-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-ign-state-'));
  const projDir = path.join(dir, 'projects', 'demo');
  fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'src', 'main.ts'), 'export function helloMain(): number { return 1; }\n');
  fs.writeFileSync(path.join(projDir, 'leaked.pem'), 'export function topSecretFn(): number { return 42; }\n');
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(stateDir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(stateDir, 'data'),
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
    FACTORY_CODEINDEX_ROOTS: projDir,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
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
  return { port, proc, dir, projDir, stateDir };
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

test('two-tier ignores end to end over HTTP', async () => {
  const srv = await startServer();
  try {
    // Insert the project record directly (the schema was created by the
    // server on boot; no project-creation API sets a path without a
    // template/clone side effect).
    const projectId = 'ign-proj-1';
    {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(srv.stateDir, 'factory.db'));
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO projects (id, name, description, path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(projectId, 'Ignore Demo', '', srv.projDir, 'active', now, now);
      db.close();
    }

    // 1. Empty state.
    let r = await api(srv.port, 'GET', `/api/ignores?projectId=${encodeURIComponent(projectId)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.hard, '');
    assert.equal(r.body.hardPatterns, 0);
    assert.deepEqual(r.body.errors, []);

    // 2. Write both layers.
    r = await api(srv.port, 'PUT', '/api/ignores', {
      projectId,
      hard: '*.pem\n',
      indexing: 'src/**\n',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.hardPatterns, 1);
    assert.equal(r.body.indexingPatterns, 1);
    // On disk under the project directory.
    assert.equal(fs.readFileSync(path.join(srv.projDir, '.ai-factory', 'ignore'), 'utf8'), '*.pem\n');
    assert.equal(fs.readFileSync(path.join(srv.projDir, '.ai-factory', 'indexing-ignore'), 'utf8'), 'src/**\n');

    // 3. Preview: the fake secret is hard-ignored with its pattern+line.
    r = await api(srv.port, 'GET', `/api/ignores/preview?projectId=${encodeURIComponent(projectId)}`);
    assert.equal(r.status, 200);
    const hardRel = (r.body.hardIgnored as { rel: string; pattern: string; line: number }[]);
    const hit = hardRel.find((e) => e.rel === 'leaked.pem');
    assert.ok(hit, 'leaked.pem in preview');
    assert.equal(hit?.pattern, '*.pem');
    assert.equal(hit?.line, 1);

    // 4. Code index build + search: the secret symbol is unsearchable,
    //    and so is the indexing-tier-excluded src file.
    r = await api(srv.port, 'POST', '/api/codeindex/index', { root: srv.projDir });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // The only indexed files are the two ignore CONFIG files themselves
    // (pattern files, not secrets — same treatment as .gitignore). Both
    // content files are gated out: leaked.pem by the hard tier, src/** by
    // the indexing tier.
    assert.equal(r.body.stats.files, 2, 'only the ignore config files remain indexed');
    r = await api(srv.port, 'GET', `/api/codeindex/search?root=${encodeURIComponent(srv.projDir)}&q=topSecretFn&mode=symbols`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.hits, []);
    r = await api(srv.port, 'GET', `/api/codeindex/search?root=${encodeURIComponent(srv.projDir)}&q=helloMain&mode=symbols`);
    assert.deepEqual(r.body.hits, [], 'indexing tier hides src/** from the index');

    // 5. @tree: leaked.pem is gone; src still listed (indexing tier ≠ invisible).
    r = await api(srv.port, 'POST', '/api/context-providers/resolve', { text: '@tree' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const treeText: string = r.body.resolved?.[0]?.text ?? '';
    assert.ok(!treeText.includes('leaked.pem'), '@tree hides the hard-ignored file');
    assert.ok(treeText.includes('src'), '@tree still lists indexing-ignored dirs');

    // 6. Invalid PUT text → 400.
    r = await api(srv.port, 'PUT', '/api/ignores', { projectId, hard: 'bad\0text' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'IGNORE_TEXT_INVALID');

    // 7. Audit contains IGNORES_UPDATED.
    r = await api(srv.port, 'GET', '/api/audit?limit=300');
    const actions = (r.body as { action: string }[]).map((x) => x.action);
    assert.ok(actions.includes('IGNORES_UPDATED'), 'IGNORES_UPDATED audited');
  } finally {
    await stopServer(srv);
  }
});

/**
 * PR/Issue linkage HTTP tests — R7-#6.
 * Boots the real server (dist) with an isolated DB and exercises the
 * whole feature end to end:
 *
 *   No provider (first boot): status configured:false; /linked answers
 *     configured:false with zero items (never fabricated data);
 *     local branch + log references parse from a real git repo;
 *     local review archive round-trips; issue import creates a DRAFT
 *     task; remote write without the enable flag -> 403 + audit.
 *   Fixture provider (second boot): /linked resolves numbers, detail
 *     carries review excerpts + checks, write with enable flag but
 *     confirm missing -> 400, fixture post -> 501.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/prlink-routes.test.ts
 * (requires a server build first — the server boots from dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
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
  repoDir: string;
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
      srv.close(() => resolve((addr as net.AddressInfo).port));
    });
  });
}

function makeRepo(dir: string): string {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init #1'], { cwd: repo });
  execFileSync('git', ['checkout', '-b', 'feat/#42-login'], { cwd: repo });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'close #42'], { cwd: repo });
  return repo;
}

async function startServer(withFixture: boolean): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-prlink-http-'));
  const repoDir = makeRepo(dir);
  let fixtureFile = '';
  if (withFixture) {
    fixtureFile = path.join(dir, 'fixture.json');
    fs.writeFileSync(
      fixtureFile,
      JSON.stringify({
        items: [
          {
            kind: 'pull', number: 42, repo: 'owner/repo', title: 'Add login', state: 'open',
            author: 'alice', url: 'https://example.invalid/owner/repo/pull/42', labels: [],
            createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
            bodyExcerpt: 'Implements login.', headSha: 'abc123',
          },
        ],
        reviews: { 'owner/repo#42': [{ author: 'carol', state: 'APPROVED', submittedAt: '2026-01-02T00:00:00Z', bodyExcerpt: 'LGTM' }] },
        checks: { 'owner/repo#42': [{ name: 'ci', status: 'completed', conclusion: 'success', url: 'https://example.invalid/ci' }] },
      }),
      'utf8',
    );
  }
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'db', 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_INSPECT_ROOTS: dir,
    FACTORY_ALLOW_OPEN_LOCAL: '1',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_PRLINK_TOKEN', 'FACTORY_PRLINK_TOKEN_FILE']) {
    delete env[k];
  }
  if (withFixture) {
    env.FACTORY_PRLINK_PROVIDER = 'fixture';
    env.FACTORY_PRLINK_FIXTURE_FILE = fixtureFile;
    env.FACTORY_PRLINK_WRITES_ENABLED = '1';
  } else {
    delete env.FACTORY_PRLINK_PROVIDER;
    delete env.FACTORY_PRLINK_FIXTURE_FILE;
    delete env.FACTORY_PRLINK_WRITES_ENABLED;
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
  return { port, proc, dir, repoDir };
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
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

test('prlink without a provider: honest unconfigured state, local linkage, gated writes', async () => {
  const srv = await startServer(false);
  try {
    const status = await api(srv.port, 'GET', '/api/prlink/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.configured, false);
    assert.equal(status.body.provider, null);
    assert.equal(status.body.writesEnabled, false);

    const local = await api(srv.port, 'GET', `/api/prlink/local?root=${encodeURIComponent(srv.repoDir)}`);
    assert.equal(local.status, 200);
    assert.equal(local.body.branch, 'feat/#42-login');
    assert.deepEqual(
      local.body.references.map((r: any) => `${r.repo ?? ''}#${r.number}`),
      ['#42', '#1'],
    );

    const linked = await api(srv.port, 'GET', `/api/prlink/linked?root=${encodeURIComponent(srv.repoDir)}&repo=owner/repo`);
    assert.equal(linked.status, 200);
    assert.equal(linked.body.configured, false);
    assert.deepEqual(linked.body.items, []);

    const review = await api(srv.port, 'POST', '/api/prlink/reviews/local', {
      repo: 'owner/repo', number: 42, file: 'a.ts', line: 10, body: 'nit: rename',
    });
    assert.equal(review.status, 201);
    const listed = await api(srv.port, 'GET', '/api/prlink/reviews/local?repo=owner/repo&number=42');
    assert.equal(listed.body.reviews.length, 1);
    assert.equal(listed.body.reviews[0].body, 'nit: rename');

    const imported = await api(srv.port, 'POST', '/api/projects', { name: 'prlink-demo' });
    assert.equal(imported.status, 201);
    const projectId = imported.body.project?.id ?? imported.body.id;
    assert.ok(typeof projectId === 'string' && projectId.length > 0);
    const importedTask = await api(srv.port, 'POST', '/api/prlink/issues/import', {
      projectId, repo: 'owner/repo', number: 42, title: 'Add login',
    });
    assert.equal(importedTask.status, 201);
    assert.equal(importedTask.body.task.authorizationStatus, 'DRAFT');
    assert.match(importedTask.body.task.description, /owner\/repo#42/);

    const unknownProject = await api(srv.port, 'POST', '/api/prlink/issues/import', {
      projectId: 'no-such-project', repo: 'owner/repo', number: 42, title: 'Add login',
    });
    assert.equal(unknownProject.status, 409);

    const write = await api(srv.port, 'POST', '/api/prlink/write/comment', {
      repo: 'owner/repo', number: 42, body: 'hello', confirm: true,
    });
    assert.equal(write.status, 403);

    const audit = await api(srv.port, 'GET', '/api/audit?limit=50');
    const auditList = Array.isArray(audit.body) ? audit.body : (audit.body.events ?? audit.body.entries ?? []);
    const actions = auditList.map((e: any) => e.action ?? e.type);
    assert.ok(actions.includes('PRLINK_WRITE_REFUSED'));
    assert.ok(actions.includes('PRLINK_ISSUE_IMPORTED'));
  } finally {
    await stopServer(srv);
  }
});

test('prlink with a fixture provider: linked detail, gated write paths', async () => {
  const srv = await startServer(true);
  try {
    const status = await api(srv.port, 'GET', '/api/prlink/status');
    assert.equal(status.body.configured, true);
    assert.equal(status.body.provider, 'fixture');
    assert.equal(status.body.writesEnabled, true);

    const linked = await api(srv.port, 'GET', `/api/prlink/linked?root=${encodeURIComponent(srv.repoDir)}&repo=owner/repo`);
    assert.equal(linked.status, 200);
    assert.equal(linked.body.items.length, 1);
    assert.equal(linked.body.items[0].title, 'Add login');

    const detail = await api(srv.port, 'GET', '/api/prlink/linked/42?repo=owner/repo');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.item.kind, 'pull');
    assert.equal(detail.body.reviews[0].state, 'APPROVED');
    assert.equal(detail.body.checks[0].conclusion, 'success');

    const missing = await api(srv.port, 'GET', '/api/prlink/linked/999?repo=owner/repo');
    assert.equal(missing.status, 404);

    const noConfirm = await api(srv.port, 'POST', '/api/prlink/write/comment', {
      repo: 'owner/repo', number: 42, body: 'hello',
    });
    assert.equal(noConfirm.status, 400);

    const fixturePost = await api(srv.port, 'POST', '/api/prlink/write/comment', {
      repo: 'owner/repo', number: 42, body: 'hello', confirm: true,
    });
    assert.equal(fixturePost.status, 501);
  } finally {
    await stopServer(srv);
  }
});

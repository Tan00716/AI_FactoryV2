/**
 * Project archive lifecycle over HTTP — Batch 14.
 *
 * Real compiled server, two boots over ONE temp DB file:
 *
 *   Boot A — create project P (+ a task, plus a second active project Q
 *   as a control); archive P → 200 changed:true, archive again → 200
 *   changed:false (idempotent, pinned); GET /api/projects hides P by
 *   default, ?includeArchived=1 shows it, ?status=archived lists only
 *   archived; writes under P are refused 409 PROJECT_ARCHIVED (create
 *   task, task evidence, task transition, project import) while reads
 *   stay open (GET task, final-report, export all 200) and Q is
 *   unaffected; archive of an unknown id → 404. Unarchive P → writes
 *   work again (create task 201); re-archive before shutdown.
 *   Boot B — P is still archived after the restart: hidden from the
 *   default list, writes still refused.
 *
 * Requires the workspace build (root `npm run build`): the server under
 * test is dist/index.js — same precondition as backup-restore.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'archive-test-token-0123456789';

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, never> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, never> = {};
  try {
    parsed = JSON.parse(text) as Record<string, never>;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: parsed };
}

interface BootedServer {
  child: ChildProcess;
  port: number;
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(dbFile: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKEN: TOKEN,
  };
  delete env['FACTORY_RUNTIME_TOOLS'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function stopServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((r) => s.child.once('exit', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    s.child.kill('SIGKILL');
    await new Promise((r) => s.child.once('exit', r));
  }
}

function ids(list: unknown): string[] {
  return (list as { id: string }[]).map((p) => p.id);
}

describe('project archive lifecycle (Batch 14)', () => {
  it('archive closes a project to new facts, reads stay open, unarchive reopens, state survives restart', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-arch-'));
    const dbFile = join(dir, 'factory.db');
    let server: BootedServer | undefined;
    try {
      // ------------------------------------------------------------ boot A
      server = await bootServer(dbFile);
      const port = server.port;

      const p = await api(port, 'POST', '/api/projects', { name: 'ArchMe' });
      assert.equal(p.status, 201);
      const pid = p.body['id'] as unknown as string;
      assert.equal(p.body['status'], 'active');
      assert.equal(p.body['archived_at'], null);

      const q = await api(port, 'POST', '/api/projects', { name: 'Control' });
      const qid = q.body['id'] as unknown as string;

      const t = await api(port, 'POST', '/api/tasks', { projectId: pid, title: 'T1' });
      assert.equal(t.status, 201);
      const tid = t.body['id'] as unknown as string;

      // Archive: state change reported once, then idempotent.
      const a1 = await api(port, 'POST', `/api/projects/${pid}/archive`, {});
      assert.equal(a1.status, 200);
      assert.equal(a1.body['status'], 'archived');
      assert.equal(a1.body['changed'], true);
      assert.ok(typeof a1.body['archived_at'] === 'string');
      const a2 = await api(port, 'POST', `/api/projects/${pid}/archive`, {});
      assert.equal(a2.status, 200);
      assert.equal(a2.body['changed'], false);
      assert.equal(a2.body['archived_at'], a1.body['archived_at']);

      // Unknown project → 404 on both verbs.
      assert.equal((await api(port, 'POST', '/api/projects/nope/archive', {})).status, 404);
      assert.equal((await api(port, 'POST', '/api/projects/nope/unarchive', {})).status, 404);

      // Listings: default hides archived; explicit params opt back in.
      const def = await api(port, 'GET', '/api/projects');
      assert.ok(!ids(def.body).includes(pid), 'default list hides archived');
      assert.ok(ids(def.body).includes(qid), 'default list keeps active');
      const inc = await api(port, 'GET', '/api/projects?includeArchived=1');
      assert.ok(ids(inc.body).includes(pid), 'includeArchived shows archived');
      const onlyArch = await api(port, 'GET', '/api/projects?status=archived');
      assert.deepEqual(ids(onlyArch.body), [pid]);
      const onlyActive = await api(port, 'GET', '/api/projects?status=active');
      assert.ok(!ids(onlyActive.body).includes(pid));
      assert.equal((await api(port, 'GET', '/api/projects?status=bogus')).status, 400);

      // Writes under the archived project → 409 PROJECT_ARCHIVED.
      const wt = await api(port, 'POST', '/api/tasks', { projectId: pid, title: 'Nope' });
      assert.equal(wt.status, 409);
      assert.equal(wt.body['code'], 'PROJECT_ARCHIVED');
      const we = await api(port, 'POST', `/api/tasks/${tid}/evidence`, { type: 'plan', title: 'E' });
      assert.equal(we.status, 409);
      assert.equal(we.body['code'], 'PROJECT_ARCHIVED');
      const wtr = await api(port, 'POST', `/api/tasks/${tid}/transition`, { to: 'IN_PROGRESS' });
      assert.equal(wtr.status, 409);
      assert.equal(wtr.body['code'], 'PROJECT_ARCHIVED');
      const wi = await api(port, 'POST', `/api/projects/${pid}/import`, {});
      assert.equal(wi.status, 409);
      assert.equal(wi.body['code'], 'PROJECT_ARCHIVED');

      // Reads stay open: task, final report, export.
      assert.equal((await api(port, 'GET', `/api/tasks/${tid}`)).status, 200);
      assert.equal((await api(port, 'GET', `/api/projects/${pid}/final-report`)).status, 200);
      assert.equal((await api(port, 'GET', `/api/projects/${pid}/export`)).status, 200);

      // The control project is unaffected.
      assert.equal((await api(port, 'POST', '/api/tasks', { projectId: qid, title: 'QT' })).status, 201);

      // Unarchive reopens writes; then re-archive for the restart check.
      const u1 = await api(port, 'POST', `/api/projects/${pid}/unarchive`, {});
      assert.equal(u1.status, 200);
      assert.equal(u1.body['status'], 'active');
      assert.equal(u1.body['changed'], true);
      assert.equal(u1.body['archived_at'], null);
      assert.equal((await api(port, 'POST', `/api/projects/${pid}/unarchive`, {})).body['changed'], false);
      assert.equal((await api(port, 'POST', '/api/tasks', { projectId: pid, title: 'T2' })).status, 201);
      assert.equal((await api(port, 'POST', `/api/projects/${pid}/archive`, {})).body['changed'], true);

      await stopServer(server);
      server = undefined;

      // ------------------------------------------------------------ boot B
      server = await bootServer(dbFile);
      const portB = server.port;
      const defB = await api(portB, 'GET', '/api/projects');
      assert.ok(!ids(defB.body).includes(pid), 'archived state survives restart');
      const incB = await api(portB, 'GET', '/api/projects?includeArchived=1');
      const rowB = (incB.body as unknown as { id: string; status: string }[]).find((r) => r.id === pid);
      assert.equal(rowB?.status, 'archived');
      const wtB = await api(portB, 'POST', '/api/tasks', { projectId: pid, title: 'Nope' });
      assert.equal(wtB.status, 409);
      assert.equal(wtB.body['code'], 'PROJECT_ARCHIVED');

      await stopServer(server);
      server = undefined;
    } finally {
      if (server) await stopServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

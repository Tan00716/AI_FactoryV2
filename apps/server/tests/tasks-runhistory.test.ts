/**
 * Persisted run-history HTTP tests (V3.0 audit round 2, item #10) —
 * boots the real server (dist) with an isolated DB/data dir:
 *
 *   POST /api/tasks/run            run a chain (metadata persisted)
 *   GET  /api/tasks/runs           live run present, historyCorrupt false
 *   restart server (same data dir) list still shows the run, marked
 *                                  persisted, steps empty, id sequence
 *                                  continues past the persisted id
 *   GET  /api/tasks/runs/:id       persisted-only detail: metadata view
 *   POST rollback/rerun on it      409 persisted-run-immutable (view,
 *                                  not a re-execution channel)
 *   persisted file on disk         metadata only, token-shaped label
 *                                  redacted, no step outputs/commands
 *   DELETE /api/tasks/runs/history clears the file, audited count-only
 *   corrupt file                   list reports historyCorrupt true,
 *                                  runs still work, DELETE repairs it
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/tasks-runhistory.test.ts
 * (requires a server build first — the server boots from dist).
 * Temp base is $HOME, never /tmp (512MB tmpfs).
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
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

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
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(dir: string, projDir: string): Promise<Running> {
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

test('persisted run history survives restart, stays metadata-only, clears on demand', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'aif-runhist-'));
  const projDir = path.join(dir, 'projects', 'demo');
  fs.mkdirSync(path.join(projDir, '.ai-factory'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(projDir, '.ai-factory', 'tasks.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [
        { label: 'step-one', type: 'shell', command: 'echo hi' },
        { label: `deploy ${TOKEN}`, type: 'shell', command: 'echo secret-label', dependsOn: ['step-one'] },
      ],
    }),
    'utf8',
  );

  // Boot 1: run both chains (second label carries a token-shaped string).
  const srv1 = await startServer(dir, projDir);
  let runId = '';
  let tokenRunId = '';
  try {
    const r1 = await api(srv1.port, 'POST', '/api/tasks/run', {
      label: 'step-one', root: projDir, projectId: 'hist-proj',
    });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const r2 = await api(srv1.port, 'POST', '/api/tasks/run', {
      label: `deploy ${TOKEN}`, root: projDir, projectId: 'hist-proj',
    });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const list1 = await api(srv1.port, 'GET', '/api/tasks/runs');
    assert.equal(list1.status, 200);
    assert.equal(list1.body.historyCorrupt, false);
    assert.equal(list1.body.runs.length, 2);
    runId = list1.body.runs.find((r: any) => r.label === 'step-one').id;
    tokenRunId = list1.body.runs.find((r: any) => r.label.includes('deploy')).id;
    assert.equal(list1.body.runs.every((r: any) => r.persisted !== true), true);

    // Persisted file on disk: metadata only, token redacted.
    const histFile = path.join(dir, 'data', 'run-history.json');
    assert.equal(fs.existsSync(histFile), true);
    const raw = fs.readFileSync(histFile, 'utf8');
    assert.equal(raw.includes(TOKEN), false, 'token must not reach disk');
    assert.match(raw, /REDACTED/);
    assert.equal(raw.includes('echo hi'), false, 'step commands must not be persisted');
    assert.equal(raw.includes('echo secret-label'), false);
    const stored = JSON.parse(raw);
    assert.equal(stored.length, 2);
    assert.deepEqual(Object.keys(stored[0]).sort(), [
      'counts', 'coverage', 'durationMs', 'finishedAt', 'id', 'label', 'ok', 'startedAt', 'taskCount',
    ]);
  } finally {
    await stopServer(srv1);
  }

  // Boot 2 (same data dir): history survives, ids continue past persisted ones.
  const srv2 = await startServer(dir, projDir);
  try {
    const list2 = await api(srv2.port, 'GET', '/api/tasks/runs');
    assert.equal(list2.status, 200);
    assert.equal(list2.body.runs.length, 2);
    const persisted = list2.body.runs.find((r: any) => r.id === runId);
    assert.equal(persisted.persisted, true);
    assert.deepEqual(persisted.steps, []);
    assert.match(persisted.persistedNote, /not a re-execution channel/);

    // Persisted-only detail: metadata view, no step data.
    const detail = await api(srv2.port, 'GET', `/api/tasks/runs/${runId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.persisted, true);
    assert.deepEqual(detail.body.run.steps, []);
    assert.equal(detail.body.run.taskCount, 1);

    // Persisted-only rollback/rerun: refused, with the real route named.
    const rb = await api(srv2.port, 'POST', `/api/tasks/runs/${runId}/rollback`, { stepLabel: 'step-one' });
    assert.equal(rb.status, 409);
    assert.equal(rb.body.code, 'persisted-run-immutable');
    const rr = await api(srv2.port, 'POST', `/api/tasks/runs/${runId}/rerun`, {});
    assert.equal(rr.status, 409);
    assert.equal(rr.body.code, 'persisted-run-immutable');

    // A new run after restart gets an id past the persisted sequence.
    const r3 = await api(srv2.port, 'POST', '/api/tasks/run', {
      label: 'step-one', root: projDir, projectId: 'hist-proj',
    });
    assert.equal(r3.status, 200, JSON.stringify(r3.body));
    const list3 = await api(srv2.port, 'GET', '/api/tasks/runs');
    assert.equal(list3.body.runs.length, 3);
    const fresh = list3.body.runs.find((r: any) => r.persisted !== true);
    assert.match(fresh.id, /^taskrun-[3-9]/);
    assert.notEqual(fresh.id, runId);
    assert.notEqual(fresh.id, tokenRunId);

    // Clear: file gone, audit carries count only, list back to live only.
    const cleared = await api(srv2.port, 'DELETE', '/api/tasks/runs/history');
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.cleared, 3);
    assert.equal(fs.existsSync(path.join(dir, 'data', 'run-history.json')), false);
    const audit = await api(srv2.port, 'GET', '/api/audit?limit=300');
    const events = (Array.isArray(audit.body) ? audit.body : []).filter(
      (r: any) => r.action === 'TASK_RUN_HISTORY_CLEARED',
    );
    assert.equal(events.length, 1);
    // Count-only audit: the event must not carry any run content.
    assert.equal(JSON.stringify(events[0]).includes(TOKEN), false);
    const list4 = await api(srv2.port, 'GET', '/api/tasks/runs');
    assert.equal(list4.body.runs.length, 1);

    // Corrupt file: list reports it, runs still work, DELETE repairs it.
    fs.writeFileSync(path.join(dir, 'data', 'run-history.json'), '{broken', 'utf8');
    const list5 = await api(srv2.port, 'GET', '/api/tasks/runs');
    assert.equal(list5.status, 200);
    assert.equal(list5.body.historyCorrupt, true);
    assert.equal(list5.body.runs.length, 1);
    const r4 = await api(srv2.port, 'POST', '/api/tasks/run', {
      label: 'step-one', root: projDir, projectId: 'hist-proj',
    });
    assert.equal(r4.status, 200, JSON.stringify(r4.body));
    const repaired = await api(srv2.port, 'DELETE', '/api/tasks/runs/history');
    assert.equal(repaired.status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'data', 'run-history.json')), false);
    const list6 = await api(srv2.port, 'GET', '/api/tasks/runs');
    assert.equal(list6.body.historyCorrupt, false);
  } finally {
    await stopServer(srv2);
  }
});

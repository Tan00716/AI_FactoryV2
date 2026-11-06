/**
 * Task timeline HTTP tests (V3-#7) — boots the real server (dist) with an
 * isolated DB and exercises the timeline end to end:
 *
 *   POST /api/tasks/run            chain step-one -> fail-step -> never-ran
 *   GET  /api/tasks/runs           list view: steps present, outputs stripped,
 *                                  no server root leaked, taskCount kept
 *   GET  /api/tasks/runs/:id       full cards: output, error, skipped note,
 *                                  coverage full, checkpoint links empty
 *   POST /api/tasks/runs/:id/rollback  to step-one: later steps superseded,
 *                                  earlier results preserved, audit recorded
 *   POST rollback (again / unknown)   409 already-superseded / step-not-found
 *   POST /api/tasks/runs/:id/rerun     new run linked via rerunOf/rerunFrom
 *   GET  unknown run               404 timeline-not-found
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/tasks-timeline.test.ts
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-timeline-http-'));
  const projDir = path.join(dir, 'projects', 'demo');
  fs.mkdirSync(path.join(projDir, '.ai-factory'), { recursive: true });
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    // NOTE: the DB dir must NOT contain the project root: the control-dir
    // guard refuses any task cwd under dirname(DB_PATH) (substring match).
    DB_PATH: path.join(dir, 'db', 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
    // The task runner jails roots to FACTORY_INSPECT_ROOTS (default: cwd).
    FACTORY_INSPECT_ROOTS: dir,
    // Shadow workspaces jail to FACTORY_SHADOW_ROOTS (default: cwd).
    FACTORY_SHADOW_ROOTS: dir,
    // Test-harness opt-in (same as the V3-#5 smoke script): the server
    // is fail-closed without a token even on loopback since V3-#1.
    FACTORY_ALLOW_OPEN_LOCAL: '1',
    // R17 #6(k): task runs are fail-closed without bwrap; this test
    // exercises the timeline itself, so it opts out explicitly.
    FACTORY_EXEC_SANDBOX: '0',
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

test('task timeline end to end over HTTP', async () => {
  const srv = await startServer();
  try {
    fs.writeFileSync(
      path.join(srv.projDir, '.ai-factory', 'tasks.json'),
      JSON.stringify({
        version: '2.0.0',
        tasks: [
          { label: 'step-one', type: 'shell', command: 'echo hello-from-step-one' },
          {
            label: 'fail-step', type: 'process', command: 'node',
            args: ['--no-such-flag-xyz'], dependsOn: ['step-one'],
          },
          { label: 'never-ran', type: 'shell', command: 'echo never', dependsOn: ['fail-step'] },
        ],
      }),
      'utf8',
    );

    // 1. Run the chain: step-one ok, fail-step fails, chain stops.
    const run = await api(srv.port, 'POST', '/api/tasks/run', {
      label: 'never-ran', root: srv.projDir, projectId: 'timeline-proj',
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.ok, false);
    // stoppedAt is the top-level requested node that stopped (deps nest
    // under it); the failing step itself is fail-step in results.
    assert.equal(run.body.stoppedAt, 'never-ran');
    // R7-#4: the never-ran step is recorded as 'skipped' with the failed
    // dependency named (previously it was absent from chain results and
    // only backfilled by the timeline with a generic note).
    assert.deepEqual(
      run.body.results.map((r: any) => r.label),
      ['step-one', 'fail-step', 'never-ran'],
    );
    assert.equal(run.body.results[2].status, 'skipped');
    assert.match(run.body.results[2].error, /"fail-step"/);

    // 2. List view: one run, three step cards, outputs stripped, no root leak.
    const list = await api(srv.port, 'GET', '/api/tasks/runs');
    assert.equal(list.status, 200);
    assert.equal(list.body.runs.length, 1);
    const listed = list.body.runs[0];
    assert.equal(listed.taskCount, 3);
    assert.equal('root' in listed, false);
    assert.deepEqual(
      listed.steps.map((s: any) => s.status),
      ['ok', 'failed', 'skipped'],
    );
    assert.equal(listed.steps[0].output, '');
    const runId = listed.id as string;

    // 3. Detail view: full cards, skipped reason, coverage, checkpoint links.
    const detail = await api(srv.port, 'GET', `/api/tasks/runs/${runId}`);
    assert.equal(detail.status, 200);
    assert.match(detail.body.run.steps[0].output, /hello-from-step-one/);
    assert.equal(detail.body.run.steps[1].error, 'task exited with code 9');
    assert.equal(detail.body.run.steps[2].status, 'skipped');
    assert.match(detail.body.run.steps[2].error, /"fail-step"/);
    assert.equal(detail.body.run.coverage, 'full');
    assert.deepEqual(detail.body.checkpoints, []);
    assert.equal(detail.body.checkpointError, null);
    assert.match(detail.body.run.steps[0].outputDigest, /^[0-9a-f]{64}$/);

    // 4. Rollback to step-one: later steps superseded, earlier kept, audited.
    const rb = await api(srv.port, 'POST', `/api/tasks/runs/${runId}/rollback`, {
      stepLabel: 'step-one',
    });
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    assert.deepEqual(rb.body.superseded, ['fail-step', 'never-ran']);
    assert.equal(rb.body.run.steps[0].status, 'ok');
    assert.equal(rb.body.run.steps[1].status, 'superseded');
    // Original results stay in the record (audit chain continuous).
    assert.match(rb.body.run.steps[1].output, /bad option/);
    assert.equal(rb.body.run.supersededFrom, 'step-one');
    assert.equal(rb.body.run.rollbackCount, 1);

    const audit = await api(srv.port, 'GET', '/api/audit?limit=300');
    assert.equal(audit.status, 200);
    const rbEvents = (Array.isArray(audit.body) ? audit.body : []).filter(
      (r: any) => r.action === 'TIMELINE_ROLLBACK',
    );
    assert.equal(rbEvents.length, 1);
    assert.equal(rbEvents[0].entityId, 'never-ran');

    // 5. Rollback errors: already-superseded, then unknown step.
    const rbAgain = await api(srv.port, 'POST', `/api/tasks/runs/${runId}/rollback`, {
      stepLabel: 'fail-step',
    });
    assert.equal(rbAgain.status, 409);
    assert.equal(rbAgain.body.code, 'already-superseded');
    const rbUnknown = await api(srv.port, 'POST', `/api/tasks/runs/${runId}/rollback`, {
      stepLabel: 'nope',
    });
    assert.equal(rbUnknown.status, 409);
    assert.equal(rbUnknown.body.code, 'step-not-found');

    // 6. Rerun from fail-step explicitly: it fails again, linked back.
    // (Rerunning a step runs its declared dependencies; step-one alone
    // has none, so a default rerun from the rollback target succeeds —
    // asserted separately below.)
    const rerun = await api(srv.port, 'POST', `/api/tasks/runs/${runId}/rerun`, {
      stepLabel: 'fail-step',
    });
    assert.equal(rerun.status, 200, JSON.stringify(rerun.body));
    assert.notEqual(rerun.body.run.id, runId);
    assert.equal(rerun.body.run.rerunOf, runId);
    assert.equal(rerun.body.run.rerunFrom, 'fail-step');
    assert.equal(rerun.body.chain.ok, false);

    const rerunDefault = await api(srv.port, 'POST', `/api/tasks/runs/${runId}/rerun`, {});
    assert.equal(rerunDefault.status, 200, JSON.stringify(rerunDefault.body));
    assert.equal(rerunDefault.body.run.rerunFrom, 'step-one');
    assert.equal(rerunDefault.body.chain.ok, true);

    // 7. Checkpoint linkage: a shadow checkpoint with taskId == run label
    //    is linked from the timeline detail (jump target for restore).
    const cfg = await api(srv.port, 'PUT', '/api/shadow-checkpoints/config', {
      workspaceId: 'timeline-ws', workspacePath: srv.projDir,
    });
    assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
    const cp = await api(srv.port, 'POST', '/api/shadow-checkpoints', {
      workspaceId: 'timeline-ws', workspacePath: srv.projDir, taskId: 'never-ran', label: 'pre-run',
    });
    assert.equal(cp.status, 201, JSON.stringify(cp.body));
    const linked = await api(srv.port, 'GET', `/api/tasks/runs/${runId}`);
    assert.equal(linked.status, 200);
    assert.equal(linked.body.checkpoints.length, 1);
    assert.equal(linked.body.checkpoints[0].id, cp.body.checkpoint.id);
    assert.equal(linked.body.checkpoints[0].workspaceId, 'timeline-ws');

    // 8. Unknown run id.
    const missing = await api(srv.port, 'GET', '/api/tasks/runs/taskrun-999');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'timeline-not-found');
  } finally {
    await stopServer(srv);
  }
});

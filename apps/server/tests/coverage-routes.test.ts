/**
 * Coverage HTTP tests — boots the real server (dist) with an isolated
 * DB + data dir:
 *   GET /api/coverage/summary|files|file  → 400/404 shapes before import
 *   POST /api/coverage/import              → parses lcov in the jail (200);
 *                                           403 outside the jail; 422 on
 *                                           garbage; format override works
 *   quality-gate linkage                   → PUT /api/quality with
 *                                           coverage.report; a successful
 *                                           test run parses the report and
 *                                           blocks below the threshold
 *                                           (blockOnFailure on); a missing
 *                                           report is audited, not fatal
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/coverage-routes.test.ts
 * (requires `npm run build` first — the server boots from dist).
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

const LCOV = `TN:
SF:/covrepo/src/a.ts
DA:1,1
DA:2,0
DA:3,5
end_of_record
SF:/covrepo/src/b.ts
DA:1,0
DA:2,0
end_of_record
`;

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
  report: string;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-coverage-http-'));
  const port = await freePort();
  const report = path.join(dir, 'reports', 'lcov.info');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, LCOV, 'utf8');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_COVERAGE_ROOTS: dir,
    FACTORY_SECRETS_DIR: path.join(dir, 'secrets'),
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 20_000;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error('server exited during startup');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (exited) throw new Error('server exited during startup');
  return { port, proc, dir, report };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.dir, { recursive: true, force: true });
}

async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('GET shapes before any import', async () => {
  const s = await startServer();
  try {
    const noId = await api(s.port, 'GET', '/api/coverage/summary');
    assert.equal(noId.status, 400);
    const sum = await api(s.port, 'GET', '/api/coverage/summary?projectId=proj-x');
    assert.equal(sum.status, 200);
    assert.equal(sum.body.latest, null);
    const files = await api(s.port, 'GET', '/api/coverage/files?projectId=proj-x');
    assert.deepEqual(files.body.files, []);
    const file = await api(s.port, 'GET', '/api/coverage/file?projectId=proj-x&path=/nope.ts');
    assert.equal(file.status, 404);
  } finally {
    await stopServer(s);
  }
});

test('POST /api/coverage/import: parses lcov inside the jail', async () => {
  const s = await startServer();
  try {
    const imp = await api(s.port, 'POST', '/api/coverage/import', {
      projectId: 'proj-x',
      reportPath: s.report,
    });
    assert.equal(imp.status, 200);
    assert.equal(imp.body.format, 'lcov');
    assert.ok(Math.abs(imp.body.summary.coverage - 0.4) < 1e-9);
    const files = await api(s.port, 'GET', '/api/coverage/files?projectId=proj-x');
    assert.equal(files.body.files.length, 2);
    assert.ok(files.body.files[0].path.endsWith('b.ts')); // worst-first
    const file = await api(
      s.port,
      'GET',
      `/api/coverage/file?projectId=proj-x&path=${encodeURIComponent('/covrepo/src/a.ts')}`,
    );
    assert.equal(file.status, 200);
    assert.deepEqual(file.body.lines, { '1': 1, '2': 0, '3': 5 });
    const sum = await api(s.port, 'GET', '/api/coverage/summary?projectId=proj-x');
    assert.equal(sum.body.history.length, 1);
    assert.equal(sum.body.history[0].trigger, 'import');
  } finally {
    await stopServer(s);
  }
});

test('POST /api/coverage/import: 403 outside jail, 422 on garbage', async () => {
  const s = await startServer();
  try {
    const outside = await api(s.port, 'POST', '/api/coverage/import', {
      projectId: 'proj-x',
      reportPath: '/etc/hostname',
    });
    assert.equal(outside.status, 403);
    assert.equal(outside.body.code, 'COVERAGE_PATH_DENIED');
    const bad = path.join(s.dir, 'reports', 'bad.info');
    fs.writeFileSync(bad, 'this is not a coverage report', 'utf8');
    const garbage = await api(s.port, 'POST', '/api/coverage/import', {
      projectId: 'proj-x',
      reportPath: bad,
    });
    assert.equal(garbage.status, 422);
    assert.equal(garbage.body.code, 'COVERAGE_IMPORT_FAILED');
    const wrongFormat = await api(s.port, 'POST', '/api/coverage/import', {
      projectId: 'proj-x',
      reportPath: s.report,
      format: ' Cobertura ',
    });
    assert.equal(wrongFormat.status, 400);
  } finally {
    await stopServer(s);
  }
});

test('PUT /api/quality: coverage config validates', async () => {
  const s = await startServer();
  try {
    const bad = await api(s.port, 'PUT', '/api/quality', {
      projectId: 'proj-q',
      coverage: { report: 42 },
    });
    assert.equal(bad.status, 400);
    const bad2 = await api(s.port, 'PUT', '/api/quality', {
      projectId: 'proj-q',
      coverage: { report: 'x.info', failOnDropBelow: 1.5 },
    });
    assert.equal(bad2.status, 400);
    const ok = await api(s.port, 'PUT', '/api/quality', {
      projectId: 'proj-q',
      testCmd: 'true',
      coverage: { report: 'reports/lcov.info', failOnDropBelow: 0.8 },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.config.coverage.report, 'reports/lcov.info');
    assert.equal(ok.body.config.coverage.failOnDropBelow, 0.8);
    const get = await api(s.port, 'GET', '/api/quality?projectId=proj-q');
    assert.deepEqual(get.body.config.coverage, { report: 'reports/lcov.info', failOnDropBelow: 0.8 });
  } finally {
    await stopServer(s);
  }
});

test('quality gate linkage: successful test run parses report and blocks below threshold', async () => {
  const s = await startServer();
  try {
    // The test command rewrites the report (a worse one), then exits 0.
    const gateReport = path.join(s.dir, 'reports', 'gate.info');
    const thin = LCOV.replace('DA:1,1', 'DA:1,0').replace('DA:3,5', 'DA:3,0');
    fs.writeFileSync(gateReport, thin, 'utf8');
    await api(s.port, 'PUT', '/api/quality', {
      projectId: 'proj-g',
      testCmd: 'true',
      timeoutMs: 5000,
      blockOnFailure: true,
      coverage: { report: gateReport, failOnDropBelow: 0.5 },
    });
    const run = await api(s.port, 'POST', '/api/quality/run', { projectId: 'proj-g', kind: 'test' });
    assert.equal(run.status, 200);
    assert.equal(run.body.ok, true); // the tests themselves passed
    assert.ok(run.body.coverage, 'coverage payload present');
    assert.equal(run.body.coverage.format, 'lcov');
    assert.equal(run.body.coverage.coverage, 0); // thin report: 0/5 lines
    assert.equal(run.body.coverage.blocked, true);
    assert.equal(run.body.blocked, true); // rides the existing blockOnFailure flag
    const sum = await api(s.port, 'GET', '/api/coverage/summary?projectId=proj-g');
    assert.equal(sum.body.history.length, 1);
    assert.equal(sum.body.history[0].trigger, 'gate');
    // Audit trail records the parse and the block (bare array, newest first).
    const audit = await api(s.port, 'GET', '/api/audit?limit=60');
    const entries = Array.isArray(audit.body) ? audit.body : [];
    const mine = entries.filter((e: any) => e.entityId === 'proj-g');
    const actions = mine.map((e: any) => e.action);
    assert.ok(actions.includes('QUALITY_GATE_COVERAGE_PARSED'), `expected PARSED, got ${JSON.stringify(actions)}`);
    assert.ok(actions.includes('QUALITY_GATE_COVERAGE_BLOCKED'), `expected BLOCKED, got ${JSON.stringify(actions)}`);
  } finally {
    await stopServer(s);
  }
});

test('quality gate linkage: missing report is audited, never fails a passed gate', async () => {
  const s = await startServer();
  try {
    await api(s.port, 'PUT', '/api/quality', {
      projectId: 'proj-m',
      testCmd: 'true',
      timeoutMs: 5000,
      blockOnFailure: true,
      coverage: { report: path.join(s.dir, 'reports', 'absent.info'), failOnDropBelow: 0.5 },
    });
    const run = await api(s.port, 'POST', '/api/quality/run', { projectId: 'proj-m', kind: 'test' });
    assert.equal(run.status, 200);
    assert.equal(run.body.ok, true);
    assert.equal(run.body.blocked, false); // broken report != gate failure
    assert.ok(run.body.coverage?.error, 'coverage error is disclosed');
  } finally {
    await stopServer(s);
  }
});

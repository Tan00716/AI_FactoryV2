/**
 * Change impact — HTTP integration tests (second-round ⑥) — boots the
 * real server (dist) with an isolated DB + data dir and a fixture git
 * repo:
 *   POST /api/impact/analyze {root, files:['src/lib.ts']} → the removed
 *        export is breaking, dependents found in hop layers (1 and 2)
 *   POST /api/impact/analyze with root outside the codeindex jail → 403
 *   POST /api/impact/analyze without files/prId → 400
 *   PR mode: PR record + branch diff → source 'pr', breaking ≥ 1
 *   Quality gate linkage: impact.failOnBreaking on + breaking change
 *        in the working tree → run blocked=true + IMPACT_GATE_BLOCKED
 *        audit; opt-in off → not blocked.
 *
 * Env: the fixture root is both FACTORY_CODEINDEX_ROOTS (index jail)
 * and FACTORY_INSPECT_ROOTS (the root the gate linkage analyzes).
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/impact-routes.test.ts
 * (requires `npm run build` first — the server boots from dist).
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
  proj: string;
  // R20 closeout: the server state dir (DB + data) lives apart from the
  // fixture project. controlPlaneDirs() treats dirname(DB_PATH) as a
  // control dir, and the #6(u) walker fail-closes a root inside one —
  // nesting the fixture under the DB dir (as before) makes codeindex
  // index zero files and impact analysis find no dependents.
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
      srv.close(() => resolve(addr.port));
    });
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Impact Test',
      GIT_AUTHOR_EMAIL: 'impact@example.test',
      GIT_COMMITTER_NAME: 'Impact Test',
      GIT_COMMITTER_EMAIL: 'impact@example.test',
    },
  });
}

const LIB_V1 = [
  'export function computeTotal(items: number[]): number {',
  '  return items.reduce((a, b) => a + b, 0);',
  '}',
  'export const VERSION = "1.0.0";',
  '',
].join('\n');
const LIB_V2 = ['export const VERSION = "1.0.0";', ''].join('\n'); // computeTotal removed

function buildFixture(dir: string): string {
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'lib.ts'), LIB_V1);
  fs.writeFileSync(
    path.join(proj, 'src', 'a.ts'),
    [
      'import { computeTotal } from "./lib";',
      'export function runA(items: number[]): number {',
      '  return computeTotal(items) * 2;',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(proj, 'src', 'c.ts'),
    [
      'import { runA } from "./a";',
      'export function runC(items: number[]): number {',
      '  return runA(items) + 1;',
      '}',
      '',
    ].join('\n'),
  );
  git(proj, ['init', '-q', '-b', 'main']);
  git(proj, ['add', '-A']);
  git(proj, ['commit', '-q', '-m', 'initial: lib + dependents']);
  return proj;
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-impact-http-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-impact-state-'));
  const proj = buildFixture(dir);
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(stateDir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(stateDir, 'data'),
    FACTORY_CODEINDEX_ROOTS: proj,
    FACTORY_INSPECT_ROOTS: proj,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
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
  return { port, proc, dir, proj, stateDir };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.dir, { recursive: true, force: true });
  fs.rmSync(s.stateDir, { recursive: true, force: true });
}

async function api(s: Running, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${s.port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as never) : null };
}

interface ReportBody {
  report: {
    source: string;
    changedFiles: string[];
    affectedFiles: string[];
    layers: { hop: number; files: string[] }[];
    breakingCount: number;
    nonBreakingCount: number;
    contracts: {
      file: string;
      changes: { name: string; change: string; breaking: boolean }[];
    }[];
    notes: string[];
  };
}

test('impact analyze (files mode) + jail + validation + PR mode + gate linkage', async () => {
  const s = await startServer();
  try {
    // Working tree: remove computeTotal from src/lib.ts.
    fs.writeFileSync(path.join(s.proj, 'src', 'lib.ts'), LIB_V2);

    const res = (await api(s, 'POST', '/api/impact/analyze', {
      root: s.proj,
      files: ['src/lib.ts'],
    })) as { status: number; body: ReportBody };
    assert.equal(res.status, 200, JSON.stringify(res.body, null, 2));
    const rep = res.body.report;
    assert.equal(rep.source, 'files');
    assert.deepEqual(rep.changedFiles, ['src/lib.ts']);
    assert.ok(rep.breakingCount >= 1, 'removed export is breaking');
    const libContract = rep.contracts.find((c) => c.file === 'src/lib.ts');
    const removed = libContract?.changes.find((c) => c.name === 'computeTotal');
    assert.equal(removed?.change, 'removed');
    assert.equal(removed?.breaking, true);
    assert.deepEqual(rep.affectedFiles, ['src/a.ts', 'src/c.ts']);
    assert.deepEqual(rep.layers.map((l) => l.files), [['src/a.ts'], ['src/c.ts']]);
    assert.ok(rep.notes.length >= 3, 'honest-boundary notes present');

    // Jail: root outside the allowlist → 403.
    const jailed = await api(s, 'POST', '/api/impact/analyze', {
      root: '/etc',
      files: ['passwd'],
    });
    assert.equal(jailed.status, 403);

    // Validation: no files, no prId → 400.
    const bad = await api(s, 'POST', '/api/impact/analyze', { root: s.proj });
    assert.equal(bad.status, 400);

    // Gate linkage: opt-in on → the same breaking working tree blocks.
    const put = await api(s, 'PUT', '/api/quality', {
      projectId: 'imp-proj',
      lintCmd: 'true',
      testCmd: '',
      timeoutMs: 30000,
      runOnEdit: false,
      blockOnFailure: false,
      impact: { failOnBreaking: true },
    });
    assert.equal(put.status, 200);
    const runBlocked = (await api(s, 'POST', '/api/quality/run', {
      projectId: 'imp-proj',
      kind: 'lint',
    })) as { status: number; body: Record<string, never> };
    assert.equal(runBlocked.status, 200);
    const impactBlocked = (runBlocked.body as unknown as {
      blocked: boolean;
      impact?: { breaking?: number; blocked?: boolean };
    });
    assert.equal(impactBlocked.impact?.blocked, true, JSON.stringify(runBlocked.body, null, 2));
    assert.equal(impactBlocked.blocked, true);
    assert.ok((impactBlocked.impact?.breaking ?? 0) >= 1);

    // Audit trail carries IMPACT_GATE_BLOCKED.
    const auditRes = (await api(s, 'GET', '/api/audit?limit=200')) as {
      status: number;
      body: { entries?: { action: string }[] } | { action: string }[];
    };
    const entries = Array.isArray(auditRes.body) ? auditRes.body : (auditRes.body.entries ?? []);
    const actions = entries.map((e) => e.action);
    assert.ok(actions.includes('IMPACT_GATE_BLOCKED'), `actions: ${actions.slice(-12).join(',')}`);
    assert.ok(actions.includes('IMPACT_ANALYZED'));

    // Opt-in off → never blocks.
    const putOff = await api(s, 'PUT', '/api/quality', {
      projectId: 'imp-proj',
      lintCmd: 'true',
      testCmd: '',
      timeoutMs: 30000,
      runOnEdit: false,
      blockOnFailure: false,
      impact: { failOnBreaking: false },
    });
    assert.equal(putOff.status, 200);
    const runFree = (await api(s, 'POST', '/api/quality/run', {
      projectId: 'imp-proj',
      kind: 'lint',
    })) as { status: number; body: { blocked: boolean; impact?: unknown } };
    assert.equal(runFree.status, 200);
    assert.equal(runFree.body.blocked, false);
    assert.equal(runFree.body.impact, undefined, 'no impact payload when not opted in');

    // PR mode: commit the removal on a feature branch, back on main.
    git(s.proj, ['checkout', '-q', '-b', 'feature']);
    git(s.proj, ['add', '-A']);
    git(s.proj, ['commit', '-q', '-m', 'remove computeTotal']);
    git(s.proj, ['checkout', '-q', 'main']);
    const pr = (await api(s, 'POST', '/api/git/pr', {
      repo: s.proj,
      taskId: 'impact-task',
      sourceBranch: 'feature',
      targetBranch: 'main',
      title: 'impact test pr',
    })) as { status: number; body: { id: string } };
    assert.equal(pr.status, 201, JSON.stringify(pr.body, null, 2));
    const prRes = (await api(s, 'POST', '/api/impact/analyze', {
      prId: pr.body.id,
      repo: s.proj,
    })) as { status: number; body: ReportBody };
    assert.equal(prRes.status, 200, JSON.stringify(prRes.body, null, 2));
    assert.equal(prRes.body.report.source, 'pr');
    assert.ok(prRes.body.report.changedFiles.includes('src/lib.ts'));
    assert.ok(prRes.body.report.breakingCount >= 1);
    // Unknown PR → 404.
    const noPr = await api(s, 'POST', '/api/impact/analyze', { prId: 'nope', repo: s.proj });
    assert.equal(noPr.status, 404);
  } finally {
    await stopServer(s);
  }
});

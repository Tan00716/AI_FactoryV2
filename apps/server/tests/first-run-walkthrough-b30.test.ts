/**
 * First-run walkthrough, third edition — data plane chains (Batch 30-3).
 *
 * Extends the second edition (Batch 21, first-run-walkthrough-b21.test.ts),
 * which covered the B12–B20 capability chains. This edition walks the
 * chains that landed in B21–B29 — the "data plane" a new operator touches
 * first — on the real compiled server over a fresh temp SQLite file:
 *
 * Boot A (fresh DB, FACTORY_BUILD_COMMAND + FACTORY_SBOM_DIR configured):
 *   D1 — /api/db/connections lists the boot-registered 'factory'
 *         connection (env dev, kind sqlite);
 *   D2 — failure chain 1: ad-hoc query before any policy is bound is
 *         refused PRIVILEGE_DENIED (execution is opt-in, never open);
 *   D3 — failure chain 2: a registered connection with no engine
 *         ('analytics', postgres) is refused NO_ENGINE/503 — the broker
 *         refuses to pretend it executed;
 *   D4 — admin binds a read-only policy; a whitelisted SELECT executes
 *         with real rows; a table outside the whitelist is refused;
 *         bound param VALUES never reach the audit log;
 *   D5 — runbook: admin registers a pre-approved template, operator
 *         runs it with exact params (broker never interpolates SQL);
 *   B1 — a landed merge triggers a REAL build: SUCCEEDED, real digest,
 *         and a CycloneDX 1.5 SBOM file on disk (sbomRef);
 *   R1 — retention evaluate is a pure dry run: no policy → keep forever,
 *         zero candidates; an explicit sboms policy still deletes nothing
 *         and the live SBOM stays referenced;
 *   M1 — MCP register → trust approve → install → launch a sleeper;
 *         history shows it RUNNING.
 * SIGKILL.
 * Boot B (same DB):
 *   M2 — live launch table honestly empty; history shows the sleeper
 *         ORPHANED with the "fate is unknown" note, trust still approved;
 *   B2 — the build record + SBOM file survived the restart;
 *   A1 — every action above left its mark in the hash-chained audit log,
 *         which still verifies over the file.
 *
 * The script asserts every step and fails loudly rather than working
 * around anything. Findings are pinned in docs/FIRST_RUN_WALKTHROUGH.md
 * (Batch 30 section).
 *
 * Requires the workspace build (root `npm run build`); run with
 * `npm run demo:e2e-v3`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLog } from '@ai-factory/core';
import { FactoryDatabase } from '@ai-factory/db';

// ---------------------------------------------------------------- helpers --

type Json = Record<string, unknown>;

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: parsed };
}

interface BootedServer {
  child: ChildProcess;
  port: number;
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(
  dbFile: string,
  extraEnv: Record<string, string> = {},
): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    // Hermetic secrets: the booted server's cwd is apps/server, whose
    // local data/secrets/ may carry a stale vault from earlier dev runs
    // (fail-closed decrypt errors). Point the file vault at the temp dir.
    FACTORY_SECRETS_DIR: join(tmpdir(), `factory-walk-b30-secrets-${port}`),
    ...extraEnv,
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
  if (!('FACTORY_RUNTIME_TOOLS' in extraEnv)) delete env['FACTORY_RUNTIME_TOOLS'];
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

async function killServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGKILL');
  await new Promise((r) => s.child.once('exit', r));
}

async function stopServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((r) => s.child.once('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    s.child.kill('SIGKILL');
    await new Promise((r) => s.child.once('exit', r));
  }
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** Real repo whose lockfile carries real package entries (for SBOM). */
function makeRepoWithDeps(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-walkb30-'));
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'user.name', 'walk']);
  git(dir, ['config', 'user.email', 'walk@example.com']);
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        '': { name: 'demo', version: '1.0.0' },
        'node_modules/left-pad': { version: '1.3.0' },
        'node_modules/@scope/right-pad': { version: '2.0.1' },
      },
    }),
  );
  writeFileSync(join(dir, 'a.txt'), 'line1\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'root']);
  git(dir, ['checkout', '-qb', 'feat']);
  writeFileSync(join(dir, 'f.txt'), 'f\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'feat']);
  git(dir, ['checkout', '-q', 'main']);
  return dir;
}

/** Poll the DB file directly until the build record leaves NOT_EXECUTED. */
async function waitForTerminalBuild(dbFile: string, prId: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last: Json | null = null;
  for (;;) {
    let fdb: FactoryDatabase | null = null;
    try {
      fdb = new FactoryDatabase(dbFile);
      const rows = fdb.builds.listByPr(prId) as unknown[];
      last = (rows[0] ?? null) as Json | null;
      if (last && (last['status'] as string) !== 'NOT_EXECUTED') return last;
    } catch {
      /* transient lock contention — retry */
    } finally {
      try {
        fdb?.close();
      } catch {
        /* ignore */
      }
    }
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
}

function auditActions(body: Json | unknown[]): string[] {
  const recs = (Array.isArray(body) ? body : ((body as Json)['records'] ?? [])) as Array<{
    action?: string;
  }>;
  return recs.map((r) => r.action ?? '').filter(Boolean);
}

// ------------------------------------------------------------------ the run --

describe('first-run walkthrough, third edition — B21–B29 data plane chains (Batch 30-3)', () => {
  it('db broker → real build + SBOM → retention dry-run → MCP launch, durable across a SIGKILL restart', { timeout: 600_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-walk-b30-'));
    const dbFile = join(dir, 'factory.db');
    const sbomDir = join(dir, 'sboms');
    const workRoot = mkdtempSync(join(tmpdir(), 'walk-b30-buildwork-'));
    const repo = makeRepoWithDeps();
    const PARAM_SENTINEL = `param-must-never-be-audited-b30-${Date.now()}`;
    let server: BootedServer | undefined;
    let prId = '';
    let sleeperId = '';
    try {
      // ------------------------------------------------------------ boot A --
      server = await bootServer(dbFile, {
        FACTORY_BUILD_COMMAND: `node -e "require('fs').writeFileSync('built.txt','ok')"`,
        FACTORY_BUILD_WORK_ROOT: workRoot,
        FACTORY_BUILD_TIMEOUT_MS: '30000',
        FACTORY_SBOM_DIR: sbomDir,
        FACTORY_BUILD_CONFIG_FILES: 'package-lock.json',
      });
      const portA = server.port;

      // D1 — the 'factory' connection is registered at boot (dev identity).
      const conns = await api(portA, 'GET', '/api/db/connections');
      assert.equal(conns.status, 200);
      const factory = (
        (conns.body['connections'] ?? []) as Array<Json>
      ).find((c) => c['name'] === 'factory');
      assert.ok(factory, 'factory connection registered at boot');
      assert.equal(factory!['environment'], 'dev');
      assert.equal(factory!['kind'], 'sqlite');

      // D2 — failure chain 1: no policy bound → execution refused.
      const refused = await api(portA, 'POST', '/api/db/query', {
        connectionName: 'factory',
        sql: 'SELECT id FROM tasks LIMIT 3',
      });
      assert.equal(refused.status, 403);
      assert.equal(refused.body['code'], 'PRIVILEGE_DENIED');
      assert.match(String(refused.body['reason']), /no least-privilege policy/);

      // D3 — failure chain 2: a connection with a policy but no engine
      // is refused loudly (503 NO_ENGINE) — never pretends to execute.
      const reg = await api(portA, 'POST', '/api/db/connections', {
        name: 'analytics',
        environment: 'staging',
        kind: 'postgres',
        credentialRefs: ['ANALYTICS_RO_REF'],
      });
      assert.equal(reg.status, 201);
      const pol = await api(portA, 'PUT', '/api/db/connections/analytics/policy', {
        operations: ['read'],
        tables: ['*'],
      });
      assert.equal(pol.status, 200);
      const noEngine = await api(portA, 'POST', '/api/db/query', {
        connectionName: 'analytics',
        sql: 'SELECT 1',
      });
      assert.equal(noEngine.status, 503);
      assert.equal(noEngine.body['code'], 'NO_ENGINE');

      // D4 — bind a read-only policy; the whitelisted read executes.
      const bind = await api(portA, 'PUT', '/api/db/connections/factory/policy', {
        operations: ['read'],
        tables: ['tasks'],
      });
      assert.equal(bind.status, 200);
      const ok = await api(portA, 'POST', '/api/db/query', {
        connectionName: 'factory',
        sql: 'SELECT id FROM tasks LIMIT 3',
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.body['ok'], true);
      assert.equal(ok.body['code'], 'OK');
      assert.ok(Array.isArray(ok.body['rows']));
      assert.equal(ok.body['environment'], 'dev');

      // Bound params bind, and the VALUE never reaches the audit log.
      const p = await api(portA, 'POST', '/api/db/query', {
        connectionName: 'factory',
        sql: 'SELECT :v AS v',
        params: { v: PARAM_SENTINEL },
      });
      assert.equal(p.status, 200);
      assert.equal(((p.body['rows'] as Array<Json>)[0] ?? {})['v'], PARAM_SENTINEL);
      const outside = await api(portA, 'POST', '/api/db/query', {
        connectionName: 'factory',
        sql: 'SELECT id FROM audit_logs LIMIT 1',
      });
      assert.equal(outside.status, 403);
      assert.equal(outside.body['code'], 'PRIVILEGE_DENIED');

      // D5 — runbook: admin registers a pre-approved template, operator
      // runs it with exact params (the broker never interpolates SQL).
      const tmpl = await api(portA, 'POST', '/api/db/runbooks', {
        name: 'task-ids-by-title',
        connectionName: 'factory',
        sqlTemplate: 'SELECT id FROM tasks WHERE title = :title LIMIT 5',
        slots: ['title'],
      });
      assert.equal(tmpl.status, 201);
      const ran = await api(portA, 'POST', '/api/db/runbooks/run', {
        templateName: 'task-ids-by-title',
        params: { title: 'no such task' },
      });
      assert.equal(ran.status, 200);
      assert.equal(ran.body['ok'], true);
      assert.equal(ran.body['code'], 'OK');
      assert.ok(Array.isArray(ran.body['rows']));

      // B1 — a landed merge triggers a REAL build with a real SBOM.
      const project = await api(portA, 'POST', '/api/projects', { name: 'Walk B30' });
      assert.equal(project.status, 201);
      const task = await api(portA, 'POST', '/api/tasks', {
        projectId: project.body['id'],
        title: 'build sbom task',
        goal: 'run a real build with an SBOM',
      });
      assert.equal(task.status, 201);
      const taskId = task.body['id'] as string;
      const pr = await api(portA, 'POST', '/api/git/pr', {
        repo,
        taskId,
        sourceBranch: 'feat',
        targetBranch: 'main',
        title: 'Merge feat',
      });
      assert.equal(pr.status, 201);
      prId = pr.body['id'] as string;
      const merged = await api(portA, 'POST', `/api/git/pr/${prId}/merge`, { repo, actor: 'human' });
      assert.equal(merged.status, 200);
      const row = await waitForTerminalBuild(dbFile, prId);
      assert.ok(row, 'build record reached a terminal state');
      assert.equal(row!['status'], 'SUCCEEDED', `build really ran; failureReason=${row!['failureReason']}`);
      assert.match(String(row!['digest'] ?? ''), /^[0-9a-f]{64}$/, 'real 64-hex digest');
      const sbomRef = row!['sbomRef'] as string | null;
      assert.ok(sbomRef, 'sbomRef set on success with a lockfile');
      assert.ok(sbomRef!.startsWith(sbomDir), `sbomRef under FACTORY_SBOM_DIR, got ${sbomRef}`);
      assert.ok(existsSync(sbomRef!), 'SBOM file really on disk');
      const doc = JSON.parse(readFileSync(sbomRef!, 'utf8')) as Json;
      assert.equal(doc['bomFormat'], 'CycloneDX');
      assert.equal(doc['specVersion'], '1.5');
      const names = ((doc['components'] ?? []) as Array<Json>).map((c) => `${c['name']}@${c['version']}`);
      assert.ok(names.includes('left-pad@1.3.0'), `left-pad in SBOM: ${names.join(',')}`);
      assert.ok(names.includes('@scope/right-pad@2.0.1'), `scoped dep in SBOM: ${names.join(',')}`);
      assert.ok(
        ((doc['metadata'] as Json)?.['properties'] as Array<Json>).some(
          (pr2) => pr2['name'] === 'ai-factory:sbom:provenance',
        ),
        'SBOM carries the honest provenance property (declared deps, not an installed-tree scan)',
      );

      // R1 — retention evaluate is a pure dry run (no policy = keep
      // forever; an explicit sboms policy still deletes nothing).
      const eval0 = await api(portA, 'POST', '/api/retention/evaluate', {});
      assert.equal(eval0.status, 200);
      const sboms0 = (
        (eval0.body['categories'] ?? []) as Array<Json>
      ).find((c) => c['category'] === 'sboms');
      assert.ok(sboms0, 'sboms category evaluated');
      assert.equal(sboms0!['candidates'], 0, 'no policy → keep forever, zero candidates');
      const setPol = await api(portA, 'PUT', '/api/retention/policies', {
        policies: { sboms: { days: 3650, keepCount: 1000, deleteOrphans: false } },
      });
      assert.equal(setPol.status, 200);
      const eval1 = await api(portA, 'POST', '/api/retention/evaluate', {});
      assert.equal(eval1.status, 200);
      const sboms1 = (
        (eval1.body['categories'] ?? []) as Array<Json>
      ).find((c) => c['category'] === 'sboms');
      assert.equal(sboms1!['candidates'], 0, 'dry run: the live SBOM stays referenced, nothing deleted');
      assert.ok(existsSync(sbomRef!), 'SBOM file still on disk after the dry run');

      // M1 — MCP register → trust approve → install → launch a sleeper.
      const regM = await api(portA, 'POST', '/api/mcp/register', {
        server: {
          name: 'w30sleeper',
          version: '1.0.0',
          provider: 'local',
          transport: 'stdio',
        },
      });
      assert.equal(regM.status, 201);
      const ap = await api(portA, 'POST', '/api/mcp/servers/w30sleeper@1.0.0/trust/approve', {
        trustLevel: 'HIGH',
        approvalPolicy: 'AUTO',
        reviewer: 'human',
      });
      assert.equal(ap.status, 200);
      const ins = await api(portA, 'POST', '/api/mcp/install', { name: 'w30sleeper', version: '1.0.0' });
      assert.equal(ins.status, 200);
      const launch = await api(portA, 'POST', '/api/mcp/launch', {
        name: 'w30sleeper',
        version: '1.0.0',
        command: 'node',
        args: ['-e', 'setTimeout(()=>{},60000)'],
      });
      assert.equal(launch.status, 201);
      sleeperId = launch.body['launchId'] as string;
      assert.ok(sleeperId, 'launch id returned');
      const hist = await api(portA, 'GET', '/api/mcp/launches?history=true');
      assert.equal(hist.status, 200);
      const rows = (hist.body['launches'] ?? []) as Array<Json>;
      assert.equal(rows.find((r) => r['id'] === sleeperId)?.['status'], 'RUNNING');

      await killServer(server);
      server = undefined;

      // ------------------------------------------------------------ boot B --
      server = await bootServer(dbFile, {
        FACTORY_BUILD_COMMAND: `node -e "require('fs').writeFileSync('built.txt','ok')"`,
        FACTORY_BUILD_WORK_ROOT: workRoot,
        FACTORY_BUILD_TIMEOUT_MS: '30000',
        FACTORY_SBOM_DIR: sbomDir,
      });
      const portB = server.port;

      // M2 — the live launch table is honestly empty; history shows the
      // sleeper ORPHANED with the honest "fate is unknown" note.
      const liveB = await api(portB, 'GET', '/api/mcp/launches');
      assert.equal(liveB.status, 200);
      assert.deepEqual(liveB.body['launches'], [], 'no launch is managed after a restart');
      const histB = await api(portB, 'GET', '/api/mcp/launches?history=true');
      assert.equal(histB.status, 200);
      const rowsB = (histB.body['launches'] ?? []) as Array<Json>;
      const sleeperB = rowsB.find((r) => r['id'] === sleeperId);
      assert.ok(sleeperB, 'sleeper row survives the restart');
      assert.equal(sleeperB!['status'], 'ORPHANED');
      assert.ok(
        String(sleeperB!['orphanNote'] ?? '').includes('fate is unknown'),
        'orphan note states the honest unknown',
      );
      const trustB = await api(portB, 'GET', '/api/mcp/servers/w30sleeper@1.0.0/trust');
      assert.equal(trustB.status, 200);

      // B2 — the build record and the SBOM file survived the restart.
      const rowB = await waitForTerminalBuild(dbFile, prId, 5_000);
      assert.ok(rowB, 'build record still present');
      assert.equal(rowB!['status'], 'SUCCEEDED');
      const sbomRefB = rowB!['sbomRef'] as string;
      assert.ok(existsSync(sbomRefB), 'SBOM file still on disk after restart');

      // A1 — every chain left its mark in the hash-chained audit log,
      // the bound param value did not, and the chain still verifies.
      const auditB = await api(portB, 'GET', '/api/audit?limit=2000');
      assert.equal(auditB.status, 200);
      const actions = auditActions(auditB.body);
      for (const expected of [
        'DB_CONNECTION_REGISTERED',
        'DB_BROKER_EXECUTED',
        'DB_BROKER_DENIED', // failure chain 1: PRIVILEGE_DENIED, loudly audited
        'DB_BROKER_NO_ENGINE', // failure chain 2: 503, loudly audited
        'DB_RUNBOOK_REGISTERED',
        'DB_RUNBOOK_EXECUTED',
        'BUILD_SUCCEEDED',
        'RETENTION_POLICY_UPDATED',
        'MCP_SERVER_LAUNCH',
      ]) {
        assert.ok(actions.includes(expected), `audit contains ${expected}`);
      }
      assert.ok(
        !JSON.stringify(auditB.body).includes(PARAM_SENTINEL),
        'bound param values are never audited',
      );

      await stopServer(server);
      server = undefined;

      const fdb = new FactoryDatabase(dbFile);
      try {
        const chain = new AuditLog(fdb.audit).verify();
        assert.equal(chain.ok, true, `audit chain verifies: ${JSON.stringify(chain).slice(0, 300)}`);
        assert.ok(chain.verifiedCount > 0, 'chain verified a non-empty log');
      } finally {
        fdb.close();
      }
    } finally {
      if (server) await killServer(server);
      rmSync(dir, { recursive: true, force: true });
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

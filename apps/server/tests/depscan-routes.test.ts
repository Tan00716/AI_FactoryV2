/**
 * Dependency advisor — HTTP integration tests (R4-B10).
 *
 * Boots the real server (dist) with an isolated DB + data dir, then:
 *   GET  /api/depscan/snapshot → bundled snapshot metadata (offline)
 *   POST /api/depscan/advise   → full plan against the REAL bundled
 *                                 snapshot + the REAL CVE blacklist:
 *                                 axios 0.21.1 → major + CVE-2020-28168,
 *                                 lodash 4.17.20 → patch,
 *                                 typescript 5.0.4 → minor,
 *                                 ghost-pkg → unknown
 *   POST /api/depscan/advise   → missing projectId → 400
 *   POST /api/depscan/advise   → jail escape attempt → 400
 *   POST /api/depscan/advise   → source:'live' → 403 (default egress deny)
 *                                 or real fetch — either way not 200 without
 *                                 an explicit allowlist entry; we assert the
 *                                 gate engages (403) in the default config.
 *
 * Pure offline for the snapshot path; no registry network is touched.
 *
 * Run: npm run build && node scripts/run-tests-tmp.mjs --test apps/server/tests/depscan-routes.test.ts
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
  dataDir: string;
  projectsRoot: string;
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

async function startServer(opts: { egressDenyAll?: boolean } = {}): Promise<Running> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-depscan-data-'));
  const dataSub = path.join(dataDir, 'data');
  fs.mkdirSync(dataSub, { recursive: true });
  if (opts.egressDenyAll) {
    // Deterministic gate: default-deny with no allow rules, written before boot.
    fs.writeFileSync(
      path.join(dataSub, 'egress.json'),
      JSON.stringify({
        enabled: true,
        defaultPolicy: 'deny',
        rules: [],
        updatedAt: new Date(0).toISOString(),
        updatedBy: 'test',
      }),
    );
  }
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-depscan-projroot-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dataDir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dataDir, 'data'),
    FACTORY_PROJECTS_ROOT: projectsRoot,
    FACTORY_INSPECT_ROOTS: projectsRoot,
    FACTORY_SECRETS_DIR: path.join(dataDir, 'secrets'),
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const deadline = Date.now() + 30_000;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited during startup: ${stderr.slice(0, 400)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (exited) throw new Error(`server exited during startup: ${stderr.slice(0, 400)}`);
  return { port, proc, dataDir, projectsRoot };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.dataDir, { recursive: true, force: true });
  fs.rmSync(s.projectsRoot, { recursive: true, force: true });
}

async function api(s: Running, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${s.port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function makeProject(s: Running): string {
  const projDir = path.join(s.projectsRoot, 'depscan-proj');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'package.json'),
    JSON.stringify({
      name: 'depscan-proj',
      version: '1.0.0',
      dependencies: {
        axios: '^0.21.1',
        lodash: '^4.17.20',
        typescript: '^5.0.4',
        'ghost-pkg': '^1.0.0',
      },
    }),
  );
  fs.writeFileSync(
    path.join(projDir, 'package-lock.json'),
    JSON.stringify({
      name: 'depscan-proj',
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/axios': { version: '0.21.1' },
        'node_modules/lodash': { version: '4.17.20' },
        'node_modules/typescript': { version: '5.0.4' },
        'node_modules/ghost-pkg': { version: '1.0.0' },
      },
    }),
  );
  return projDir;
}

test('depscan snapshot metadata is honest and offline', async () => {
  const s = await startServer();
  try {
    const r = await api(s, 'GET', '/api/depscan/snapshot');
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.snapshotDate, '2026-10-22');
    assert.ok((r.body.packageCount as number) >= 15, 'snapshot should cover the CVE set');
    assert.ok(r.body.honestBoundary, 'honest boundary must be disclosed');
  } finally {
    await stopServer(s);
  }
});

test('depscan advise: real snapshot + real CVE blacklist, fully offline', async () => {
  const s = await startServer();
  try {
    const dir = makeProject(s);
    const r = await api(s, 'POST', '/api/depscan/advise', { projectId: 'p1', dir });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
    const plan = r.body.plan;
    assert.ok(plan.registrySource.startsWith('bundled-snapshot'), plan.registrySource);
    const byName = new Map(plan.advisories.map((a: any) => [a.name, a]));

    const axios = byName.get('axios');
    assert.equal(axios.grade, 'major');
    assert.equal(axios.latest, '1.8.4');
    assert.equal(axios.reviewFirst, true);
    assert.ok(
      axios.cves.some((c: any) => c.id === 'CVE-2020-28168'),
      'axios 0.21.1 must hit the real blacklist entry',
    );
    assert.ok(axios.changelogUrl, 'changelog link present');

    assert.equal(byName.get('lodash').grade, 'patch');
    assert.equal(byName.get('lodash').latest, '4.17.21');
    assert.ok(
      byName.get('lodash').cves.some((c: any) => c.id === 'CVE-2020-8203'),
      'lodash 4.17.20 must hit the real blacklist entry',
    );
    assert.equal(byName.get('lodash').reviewFirst, true);
    assert.equal(byName.get('typescript').grade, 'minor');
    assert.equal(byName.get('typescript').latest, '5.8.3');
    assert.equal(byName.get('ghost-pkg').grade, 'unknown');

    assert.deepEqual(plan.summary, {
      total: 4, upToDate: 0, patch: 1, minor: 1, major: 1, unknown: 1, cveAffected: 2,
    });
    assert.ok(plan.commands.some((c: string) => c === 'npm install axios@1.8.4'));
  } finally {
    await stopServer(s);
  }
});

test('depscan advise: validation + jail + live gate (default-deny egress)', async () => {
  const s = await startServer({ egressDenyAll: true });
  try {
    const dir = makeProject(s);

    const noProject = await api(s, 'POST', '/api/depscan/advise', { dir });
    assert.equal(noProject.status, 400);
    assert.equal(noProject.body.code, 'DEPSCAN_NO_PROJECT');

    const escape = await api(s, 'POST', '/api/depscan/advise', {
      projectId: 'p1',
      dir: '/etc',
    });
    assert.equal(escape.status, 400);
    assert.equal(escape.body.code, 'DEPSCAN_BAD_DIR');

    // Default egress config denies registry.npmjs.org → the gate engages.
    const live = await api(s, 'POST', '/api/depscan/advise', {
      projectId: 'p1',
      dir,
      source: 'live',
    });
    assert.equal(live.status, 403, JSON.stringify(live.body).slice(0, 300));
    assert.equal(live.body.code, 'DEPSCAN_EGRESS_BLOCKED');
  } finally {
    await stopServer(s);
  }
});

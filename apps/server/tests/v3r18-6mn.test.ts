/**
 * V3.0 audit round 18, item #6 sub-items (m) + (n) — live server probes.
 *
 * (m) (k) gap-fill, five operator code-execution paths: flaky runs,
 * debugger debuggee, remote exec, mutation runner, recipes verify.
 * Each path now runs inside the exec bwrap sandbox (same shape as
 * /api/exec) and strips the control-plane pointer vars from the child
 * env; remote also gains a read jail for GET /file and the control-dir
 * argv guard on exec.
 * (n) (k) degenerate case: a run whose cwd IS a control-plane directory
 * (CONTROL_DATA_DIR / FACTORY_SECRETS_DIR / AI_FACTORY_DATA_DIR) is
 * refused with CWD_IS_CONTROL_DIR instead of binding the vault as the
 * working directory.
 *
 * All six tests boot the real server (dist) with a dummy admin token and
 * authenticate with it. The sandbox is NOT disabled here (unlike
 * v3r17-6hk.test.ts): on this bwrap-less machine the five (m) paths
 * refuse with 403 SANDBOX_UNAVAILABLE, so each test asserts the
 * dual branch — refusal (this machine) OR a clean run (a bwrap machine:
 * the probe output shows NO_POINTER_VAR and no VAULT_READ_OK). The (n)
 * refusal happens before the probe, so it is asserted directly (403
 * CWD_IS_CONTROL_DIR) on any machine. The pointer strip itself (with
 * the sandbox disabled) is covered by the probe scripts in
 * ~/v3r18-6mn-shots/, following the R17 division of labor.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/v3r18-6mn.test.ts
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
const REPO_ROOT = path.resolve(here, '..', '..', '..');

const TOKEN_VALUE = 'test-value-for-factory_api_token-1234567890';
const VAULT_MARKER = 'v3r18-mn-vault-marker-7f3a9c1e';
const FLAKY_FIXTURE_REL = 'apps/server/tests/fixtures/v3r18-flaky-probe.fixture.cjs';

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
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

async function startServer(dir: string, extraEnv: NodeJS.ProcessEnv): Promise<Running> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    // The (k) README lesson: DB_PATH must NOT sit directly at the temp
    // root (the whole temp dir would become a control dir and the
    // project-inside-it would trip the control-dir guard).
    DB_PATH: path.join(dir, 'data', 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
    FACTORY_INSPECT_ROOTS: dir,
    FACTORY_ALLOW_OPEN_LOCAL: '1',
    // NOTE: no FACTORY_EXEC_SANDBOX opt-out — the sandbox stays enabled
    // (the default). The tests assert the dual branch (refusal on this
    // bwrap-less machine, clean run on a bwrap machine), never a bare 403.
    ...extraEnv,
  };
  for (const k of ['FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    if (extraEnv[k] === undefined) delete env[k];
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
  return { port, proc, dir };
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
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN_VALUE}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Force a real vault into existence through the broker API, so the probe target is real. */
async function createVault(port: number, secretsDir: string): Promise<void> {
  const put = await api(port, 'PUT', '/api/secrets/v3r18-probe-secret', {
    value: VAULT_MARKER,
    purpose: 'v3r18-6mn vault probe',
  });
  assert.equal(put.status, 200, `PUT /api/secrets failed: ${JSON.stringify(put.body)}`);
  assert.ok(fs.existsSync(path.join(secretsDir, 'vault.json')), 'vault.json must exist for the probe to be meaningful');
  assert.ok(fs.existsSync(path.join(secretsDir, 'vault.key')), 'vault.key must exist for the probe to be meaningful');
}

/**
 * The vault-read probe script (debugger program + recipes verify command).
 * Prints POINTER=<dir|undefined>, then NO_POINTER_VAR, VAULT_READ_OK or
 * VAULT_READ_FAILED, then marker-done. The vault.json content is
 * encrypted, so the probe asserts on the VAULT_READ_OK label (the read
 * happened), not on the plaintext marker.
 */
const PROBE_JS =
  `const fs = require('fs');\n` +
  `const path = require('path');\n` +
  `const dir = process.env.FACTORY_SECRETS_DIR;\n` +
  `console.log('POINTER=' + dir);\n` +
  `if (!dir) { console.log('NO_POINTER_VAR'); } else {\n` +
  `  try {\n` +
  `    const data = fs.readFileSync(path.join(dir, 'vault.json'), 'utf8');\n` +
  `    console.log('VAULT_READ_OK:' + data.slice(0, 40));\n` +
  `  } catch (e) { console.log('VAULT_READ_FAILED:' + e.code); }\n` +
  `}\n` +
  `console.log('marker-done');\n`;

/** Create a local remote connection and probe it online; returns its id. */
async function createLocalConnection(port: number, remoteRoot: string, name?: string): Promise<string> {
  const created = await api(port, 'POST', '/api/remote/connections', {
    name: name ?? `v3r18-local-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'local',
    remoteRoot,
  });
  assert.equal(created.status, 201, `create local connection failed: ${JSON.stringify(created.body)}`);
  const id = created.body.connection.id as string;
  assert.ok(id);
  const probed = await api(port, 'POST', `/api/remote/connections/${id}/probe`);
  assert.equal(probed.status, 200, `probe failed: ${JSON.stringify(probed.body)}`);
  assert.equal(probed.body.probe.online, true, `local connection not online: ${JSON.stringify(probed.body)}`);
  return id;
}

// ---------------------------------------------------------------------------
// (m) flaky runs
// ---------------------------------------------------------------------------

test('V3R18 #6(m): flaky runs refuse without bwrap; the probe test name shows no vault read when sandboxed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r18-6mn-'));
  const secretsDir = path.join(dir, 'secrets');
  const srv = await startServer(dir, { FACTORY_API_TOKEN: TOKEN_VALUE, FACTORY_SECRETS_DIR: secretsDir });
  try {
    await createVault(srv.port, secretsDir);
    const r = await api(srv.port, 'POST', '/api/flaky/runs', {
      projectId: 'v3r18-mn-flaky',
      files: [FLAKY_FIXTURE_REL],
    });
    if (r.status === 403) {
      // This machine has no bwrap: the fail-closed refusal branch.
      assert.equal(r.body.code, 'SANDBOX_UNAVAILABLE');
      return;
    }
    // A bwrap machine: the run executes sandboxed, and the probe test
    // name (the only probe output the flaky API returns) must show the
    // child could not even name the vault directory.
    assert.equal(r.status, 200, `flaky runs failed: ${JSON.stringify(r.body)}`);
    const got = await api(srv.port, 'GET', '/api/flaky?projectId=v3r18-mn-flaky');
    assert.equal(got.status, 200);
    const names = ((got.body.tests ?? []) as Array<{ name?: string; key?: string }>).map(
      (t) => t.name ?? t.key ?? '',
    );
    assert.ok(
      names.some((n) => n.includes('vault-probe-NO_POINTER_VAR')),
      `expected a NO_POINTER_VAR probe test, got: ${JSON.stringify(names)}`,
    );
    assert.ok(!names.some((n) => n.includes('VAULT_READ_OK')), 'flaky probe read the vault');
  } finally {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (m) debugger debuggee
// ---------------------------------------------------------------------------

test('V3R18 #6(m): debug sessions refuse without bwrap; the debuggee output shows no vault read when sandboxed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r18-6mn-'));
  const secretsDir = path.join(dir, 'secrets');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'probe.js'), PROBE_JS, 'utf8');
  const srv = await startServer(dir, { FACTORY_API_TOKEN: TOKEN_VALUE, FACTORY_SECRETS_DIR: secretsDir });
  try {
    await createVault(srv.port, secretsDir);
    const r = await api(srv.port, 'POST', '/api/debug/sessions', {
      projectId: 'v3r18-mn-debug',
      targetDir: proj,
      config: { name: 'probe', type: 'node', request: 'launch', program: 'probe.js', cwd: '.' },
    });
    if (r.status === 403) {
      // This machine has no bwrap: the fail-closed refusal branch.
      assert.equal(r.body.code, 'SANDBOX_UNAVAILABLE');
      return;
    }
    // A bwrap machine: the session starts and the debuggee runs sandboxed.
    assert.equal(r.status, 201, `debug session failed: ${JSON.stringify(r.body)}`);
    const sessionId = r.body.sessionId as string;
    assert.ok(sessionId);
    const deadline = Date.now() + 15_000;
    let output = '';
    for (;;) {
      const out = await api(srv.port, 'GET', `/api/debug/sessions/${sessionId}/output?since=0`);
      assert.equal(out.status, 200);
      output = ((out.body.lines ?? []) as Array<{ output?: string }>).map((l) => l.output ?? '').join('');
      if (output.includes('marker-done') || Date.now() > deadline) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    assert.ok(output.includes('marker-done'), `debuggee output never arrived: ${JSON.stringify(output)}`);
    assert.ok(output.includes('NO_POINTER_VAR'), `expected NO_POINTER_VAR in debuggee output: ${JSON.stringify(output)}`);
    assert.ok(output.includes('POINTER=undefined'), `expected POINTER=undefined: ${JSON.stringify(output)}`);
    assert.ok(!output.includes('VAULT_READ_OK'), 'debuggee read the vault');
  } finally {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (m) remote exec + GET file (one fixture, two its)
// ---------------------------------------------------------------------------

test('V3R18 #6(m): remote local exec refuses without bwrap, and printenv shows no vault pointer when sandboxed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r18-6mn-'));
  const secretsDir = path.join(dir, 'secrets');
  const root = path.join(dir, 'root');
  fs.mkdirSync(root, { recursive: true });
  const srv = await startServer(dir, { FACTORY_API_TOKEN: TOKEN_VALUE, FACTORY_SECRETS_DIR: secretsDir });
  try {
    await createVault(srv.port, secretsDir);
    const connId = await createLocalConnection(srv.port, root);
    // `printenv` (no args) prints the whole child env and always exits 0
    // (unlike `printenv VAR`, which exits 1 when the var is unset).
    const r = await api(srv.port, 'POST', `/api/remote/connections/${connId}/exec`, { command: 'printenv' });
    if (r.status === 403) {
      // This machine has no bwrap: the fail-closed refusal branch.
      assert.equal(r.body.error, 'SANDBOX_UNAVAILABLE');
      return;
    }
    // A bwrap machine: the exec runs sandboxed; the pointer vars are
    // stripped at the transport choke point, so the vault location and
    // the DB path must not appear anywhere in the child env.
    assert.equal(r.status, 200, `remote exec failed: ${JSON.stringify(r.body)}`);
    const stdout = String(r.body.stdout ?? '');
    assert.ok(!stdout.includes(secretsDir), 'remote exec env leaked the vault location');
    assert.ok(!stdout.includes(path.join(dir, 'data', 'factory.db')), 'remote exec env leaked the DB path');
  } finally {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V3R18 #6(m): remote local file reads are jailed to the workspace or an allowlisted root', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r18-6mn-'));
  const secretsDir = path.join(dir, 'secrets');
  const srv = await startServer(dir, { FACTORY_API_TOKEN: TOKEN_VALUE, FACTORY_SECRETS_DIR: secretsDir });
  try {
    await createVault(srv.port, secretsDir);
    // A local connection rooted at the vault dir: reading vault.json
    // must be refused (the jail does not depend on bwrap, so this
    // assertion holds on any machine).
    const vaultConn = await createLocalConnection(srv.port, secretsDir);
    const r = await api(srv.port, 'GET', `/api/remote/connections/${vaultConn}/file?path=vault.json`);
    assert.equal(r.status, 400, `vault read was not jailed: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'INVALID_PATH');
    // Negative control: a connection rooted at the workspace (the
    // server cwd) can still read a workspace file.
    const wsConn = await createLocalConnection(srv.port, REPO_ROOT);
    const ok = await api(srv.port, 'GET', `/api/remote/connections/${wsConn}/file?path=package.json`);
    assert.equal(ok.status, 200, `workspace read was jailed: ${JSON.stringify(ok.body)}`);
    assert.ok(String(ok.body.content ?? '').includes('"name"'));
  } finally {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (m) mutation runner
// ---------------------------------------------------------------------------

/**
 * The mutant test file (ESM). At import time it reads the vault pointer
 * var and writes the probe outcome to <targetDir>/probe-out.txt — the
 * indirect write-to-disk exfiltration channel (R18 N2). The write is
 * wrapped so a sandboxed run (target dir not visible inside the sandbox)
 * does not fail the test file: no file is then written, which is itself
 * the no-leak outcome.
 */
function mutationTestJs(outFile: string): string {
  return (
    `import { test } from 'node:test';\n` +
    `import assert from 'node:assert/strict';\n` +
    `import fs from 'node:fs';\n` +
    `import path from 'node:path';\n` +
    `import { add } from './calc.js';\n` +
    `const dir = process.env.FACTORY_SECRETS_DIR;\n` +
    `let probe = 'NO_POINTER_VAR';\n` +
    `if (dir) {\n` +
    `  try {\n` +
    `    const data = fs.readFileSync(path.join(dir, 'vault.json'), 'utf8');\n` +
    `    probe = 'VAULT_READ_OK:' + data.slice(0, 40);\n` +
    `  } catch (e) { probe = 'VAULT_READ_FAILED:' + e.code; }\n` +
    `}\n` +
    `try { fs.writeFileSync(${JSON.stringify(outFile)}, probe); } catch { /* sandboxed: target dir not visible, nothing leaks */ }\n` +
    `test('add', () => { assert.equal(add(1, 2), 3); });\n`
  );
}

test('V3R18 #6(m): mutation runs refuse without bwrap, and the mutant test cannot exfiltrate the vault to the target dir when sandboxed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r18-6mn-'));
  const secretsDir = path.join(dir, 'secrets');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'calc.js'), 'export function add(a, b) { return a + b; }\n', 'utf8');
  const outFile = path.join(proj, 'probe-out.txt');
  fs.writeFileSync(path.join(proj, 'calc.test.mjs'), mutationTestJs(outFile), 'utf8');
  const srv = await startServer(dir, { FACTORY_API_TOKEN: TOKEN_VALUE, FACTORY_SECRETS_DIR: secretsDir });
  try {
    await createVault(srv.port, secretsDir);
    const r = await api(srv.port, 'POST', '/api/mutation/run', {
      projectId: 'v3r18-mn-mutation',
      targetDir: proj,
      files: ['calc.js'],
      testFiles: ['calc.test.mjs'],
      maxMutants: 1,
    });
    if (r.status === 403) {
      // This machine has no bwrap: the fail-closed pre-check refusal.
      assert.equal(r.body.code, 'SANDBOX_UNAVAILABLE');
      assert.ok(!fs.existsSync(outFile), 'probe-out was written despite the refusal');
      return;
    }
    // A bwrap machine: the run executes sandboxed; the mutant test may
    // not write any vault content to the target dir.
    assert.equal(r.status, 202, `mutation run failed: ${JSON.stringify(r.body)}`);
    const runId = r.body.runId as string;
    assert.ok(runId);
    const deadline = Date.now() + 60_000;
    let status = '';
    for (;;) {
      const got = await api(srv.port, 'GET', `/api/mutation/runs/${runId}`);
      assert.equal(got.status, 200);
      status = String(got.body.status ?? '');
      if (status === 'done' || status === 'failed' || Date.now() > deadline) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    assert.ok(status === 'done' || status === 'failed', `mutation run never finished: ${status}`);
    if (fs.existsSync(outFile)) {
      const content = fs.readFileSync(outFile, 'utf8');
      assert.ok(!content.includes('VAULT_READ_OK'), 'mutant test exfiltrated the vault to the target dir');
      assert.ok(!content.includes(VAULT_MARKER), 'mutant test exfiltrated the vault value');
    }
  } finally {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (m) recipes verify
// ---------------------------------------------------------------------------

test('V3R18 #6(m): recipe verify refuses without bwrap, and the verify output shows no vault read when sandboxed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r18-6mn-'));
  const secretsDir = path.join(dir, 'secrets');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2) + '\n',
    'utf8',
  );
  fs.writeFileSync(path.join(proj, 'probe.js'), PROBE_JS, 'utf8');
  const srv = await startServer(dir, {
    FACTORY_API_TOKEN: TOKEN_VALUE,
    FACTORY_SECRETS_DIR: secretsDir,
    FACTORY_RECIPE_ROOTS: dir,
  });
  try {
    await createVault(srv.port, secretsDir);
    // Custom recipe: one replace op + a verify step that runs the probe.
    let r = await api(srv.port, 'POST', '/api/recipes', {
      recipeJson: JSON.stringify({
        name: 'v3r18-probe',
        version: '1.0.0',
        description: 'V3R18 (m) probe',
        match: { files: ['package.json'] },
        transform: [{ op: 'replace', file: 'package.json', search: '"1.0.0"', replace: '"1.0.1"' }],
        verify: { test: 'node probe.js' },
      }),
    });
    assert.equal(r.status, 201, `add custom recipe failed: ${JSON.stringify(r.body)}`);
    // A real task id (approvals are task-bound by schema).
    r = await api(srv.port, 'GET', '/api/tasks?projectId=proj-myapp');
    assert.equal(r.status, 200);
    const tasks = r.body as unknown as Array<{ id: string }>;
    assert.ok(tasks.length > 0, 'seeded tasks missing');
    const taskId = tasks[0].id;
    r = await api(srv.port, 'POST', '/api/recipes/plan', {
      recipeName: 'v3r18-probe',
      projectPath: proj,
      taskId,
    });
    assert.equal(r.status, 201, `plan failed: ${JSON.stringify(r.body)}`);
    const runId = (r.body['run'] as { id: string }).id;
    assert.ok(runId);
    r = await api(srv.port, 'POST', `/api/recipes/runs/${runId}/request-approval`, {});
    assert.equal(r.status, 201, `request-approval failed: ${JSON.stringify(r.body)}`);
    const approvalId = r.body['approvalId'] as string;
    assert.ok(approvalId);
    r = await api(srv.port, 'POST', `/api/approvals/${approvalId}/decision`, {
      approved: true,
      decided_by: 'human',
    });
    assert.equal(r.status, 200, `approve failed: ${JSON.stringify(r.body)}`);
    r = await api(srv.port, 'POST', `/api/recipes/runs/${runId}/execute`, { approvalId });
    assert.equal(r.status, 200, `execute failed: ${JSON.stringify(r.body)}`);
    const run = r.body['run'] as { status: string; verifyResults: Array<{ ok: boolean; output: string }> };
    assert.ok(Array.isArray(run.verifyResults) && run.verifyResults.length === 1, 'expected exactly one verify step');
    const v = run.verifyResults[0];
    if (run.status === 'failed') {
      // This machine has no bwrap: the verify step fails with the
      // fail-closed refusal (the transform was still applied; the run
      // is left failed for inspection, by design).
      assert.ok(
        String(v.output ?? '').includes('SANDBOX_UNAVAILABLE'),
        `failed run without SANDBOX_UNAVAILABLE: ${JSON.stringify(v)}`,
      );
    } else {
      // A bwrap machine: the verify runs sandboxed and passes; the
      // probe output must show the child could not name the vault dir.
      assert.equal(run.status, 'done');
      assert.equal(v.ok, true);
      assert.ok(
        String(v.output ?? '').includes('NO_POINTER_VAR'),
        `verify output lacks NO_POINTER_VAR: ${JSON.stringify(v.output)}`,
      );
    }
    assert.ok(!String(v.output ?? '').includes('VAULT_READ_OK'), 'recipe verify read the vault');
  } finally {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (n) degenerate equal-cwd case
// ---------------------------------------------------------------------------

test('V3R18 #6(n): a run whose cwd IS a control-plane dir is refused with CWD_IS_CONTROL_DIR, and a normal cwd is not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r18-6mn-'));
  const secretsDir = path.join(dir, 'secrets');
  const dataDir = path.join(dir, 'data');
  const adataDir = path.join(dir, 'adata');
  // The server's DB lives in <dir>/data (CONTROL_DATA_DIR) and its data
  // dir is <dir>/adata (AI_FACTORY_DATA_DIR); the vault is in <dir>/secrets.
  const srv = await startServer(dir, {
    FACTORY_API_TOKEN: TOKEN_VALUE,
    FACTORY_SECRETS_DIR: secretsDir,
    AI_FACTORY_DATA_DIR: adataDir,
  });
  try {
    await createVault(srv.port, secretsDir);
    // A probe program in each control dir (the debug route jails the
    // program to the target dir, so it must exist there).
    for (const d of [secretsDir, dataDir, adataDir]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'probe.js'), PROBE_JS, 'utf8');
    }
    for (const [label, targetDir] of [
      ['FACTORY_SECRETS_DIR', secretsDir],
      ['CONTROL_DATA_DIR', dataDir],
      ['AI_FACTORY_DATA_DIR', adataDir],
    ] as const) {
      const r = await api(srv.port, 'POST', '/api/debug/sessions', {
        projectId: 'v3r18-mn-n',
        targetDir,
        config: { name: 'probe', type: 'node', request: 'launch', program: 'probe.js', cwd: '.' },
      });
      assert.equal(r.status, 403, `${label}: expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(
        r.body.code,
        'CWD_IS_CONTROL_DIR',
        `${label}: expected CWD_IS_CONTROL_DIR, got ${JSON.stringify(r.body)}`,
      );
    }
    // Negative control: a normal cwd is NOT refused as a control dir —
    // it gets the ordinary bwrap refusal (this machine) or starts
    // (a bwrap machine).
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'probe.js'), PROBE_JS, 'utf8');
    const r = await api(srv.port, 'POST', '/api/debug/sessions', {
      projectId: 'v3r18-mn-n',
      targetDir: proj,
      config: { name: 'probe', type: 'node', request: 'launch', program: 'probe.js', cwd: '.' },
    });
    if (r.status === 403) {
      assert.equal(
        r.body.code,
        'SANDBOX_UNAVAILABLE',
        `normal cwd refused with the wrong code: ${JSON.stringify(r.body)}`,
      );
    } else {
      assert.equal(r.status, 201);
    }
  } finally {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

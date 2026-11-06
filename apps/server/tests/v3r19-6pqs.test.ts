/**
 * V3.0 audit round 19, item #6 sub-items (p) + (q) + (s) — live server probes.
 *
 * (p) realpath normalization (R19 N1 + N2): the credential-leak family's
 * path checks were lexical (path.resolve + string prefix) and blind to a
 * symlink component. A cwd that is a symlink to a control dir, and a
 * remote file path through a symlink that escapes the jail, must now be
 * refused exactly like the direct path would be.
 * (q) remote file-surface jail completion (R19 N3 + N4): GET /files list
 * and POST /file write get the same jail GET /file has had since R18 (m).
 * (s) A5 guard expansion (R19 N5): commandHitsControlDir now also guards
 * a custom AI_FACTORY_DATA_DIR (same treatment as FACTORY_SECRETS_DIR).
 *
 * All five tests boot the real server (dist) with a dummy admin token and
 * authenticate with it. The (p) N1 refusal (CWD_IS_CONTROL_DIR) happens
 * before the bwrap probe, so it is asserted directly on any machine; the
 * jail refusals (400 INVALID_PATH) do not depend on bwrap either, so
 * they are asserted directly too. The negative controls follow the
 * R18 dual-branch pattern (refusal on this bwrap-less machine, clean
 * run on a bwrap machine) where a sandbox is involved.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/v3r19-6pqs.test.ts
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

const TOKEN_VALUE = 'test-value-for-factory_api_token-1234567890';
const VAULT_MARKER = 'v3r19-pqs-vault-marker-4d8e2b7a';

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
  const put = await api(port, 'PUT', '/api/secrets/v3r19-probe-secret', {
    value: VAULT_MARKER,
    purpose: 'v3r19-6pqs vault probe',
  });
  assert.equal(put.status, 200, `PUT /api/secrets failed: ${JSON.stringify(put.body)}`);
  assert.ok(fs.existsSync(path.join(secretsDir, 'vault.json')), 'vault.json must exist for the probe to be meaningful');
  assert.ok(fs.existsSync(path.join(secretsDir, 'vault.key')), 'vault.key must exist for the probe to be meaningful');
}

/** Create a local remote connection and probe it online; returns its id. */
async function createLocalConnection(port: number, remoteRoot: string, name?: string): Promise<string> {
  const created = await api(port, 'POST', '/api/remote/connections', {
    name: name ?? `v3r19-local-${Math.random().toString(36).slice(2, 10)}`,
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

const PROBE_JS =
  `console.log('probe-ok');\n`;

// ---------------------------------------------------------------------------
// (p) N1: symlink cwd to a control dir
// ---------------------------------------------------------------------------

test('V3R19 #6(p) N1: a debuggee cwd that is a symlink to the vault dir is refused with CWD_IS_CONTROL_DIR', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r19-6pqs-'));
  // The vault lives INSIDE the debug target dir here (like the R18 (n)
  // test): the debug route jails the launch cwd to the target root, so
  // a symlink to a vault outside the root is refused one layer earlier
  // by jailFile itself — the (n) refusal layer is only reachable when
  // the symlink target is inside the root, which is exactly the case
  // this test pins.
  const proj = path.join(dir, 'proj');
  const secretsDir = path.join(proj, 'secrets');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'probe.js'), PROBE_JS, 'utf8');
  // Symlink inside the target root, pointing at the vault dir (which
  // is also inside the root): lexically inside, really the vault dir.
  fs.symlinkSync(secretsDir, path.join(proj, 'evil'), 'dir');
  const srv = await startServer(dir, { FACTORY_API_TOKEN: TOKEN_VALUE, FACTORY_SECRETS_DIR: secretsDir });
  try {
    await createVault(srv.port, secretsDir);
    const r = await api(srv.port, 'POST', '/api/debug/sessions', {
      projectId: 'v3r19-pqs-n1',
      targetDir: proj,
      config: { name: 'probe', type: 'node', request: 'launch', program: 'probe.js', cwd: 'evil' },
    });
    // The (n) refusal is checked before the bwrap probe, so this code
    // is deterministic on any machine — unlike the pre-fix behaviour,
    // where the lexical checks were blind and the session fell through
    // to SANDBOX_UNAVAILABLE on this machine (and to a bound vault on
    // a bwrap machine; see probe-p.mjs).
    assert.equal(r.status, 403, `symlink cwd was not refused: ${JSON.stringify(r.body)}`);
    assert.equal(
      r.body.code,
      'CWD_IS_CONTROL_DIR',
      `symlink cwd refused with the wrong code: ${JSON.stringify(r.body)}`,
    );
    // Negative control: a normal cwd is NOT refused as a control dir —
    // it gets the ordinary bwrap refusal (this machine) or starts
    // (a bwrap machine).
    const ok = await api(srv.port, 'POST', '/api/debug/sessions', {
      projectId: 'v3r19-pqs-n1',
      targetDir: proj,
      config: { name: 'probe', type: 'node', request: 'launch', program: 'probe.js', cwd: '.' },
    });
    if (ok.status === 403) {
      assert.equal(
        ok.body.code,
        'SANDBOX_UNAVAILABLE',
        `normal cwd refused with the wrong code: ${JSON.stringify(ok.body)}`,
      );
    } else {
      assert.equal(ok.status, 201);
    }
  } finally {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (p) N2: remote GET file through a symlink that escapes the jail
// ---------------------------------------------------------------------------

test('V3R19 #6(p) N2: a viewer GET file through a symlink that escapes the remote file jail is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r19-6pqs-'));
  const secretsDir = path.join(dir, 'secrets');
  const allowed = path.join(dir, 'allowed');
  fs.mkdirSync(allowed, { recursive: true });
  fs.writeFileSync(path.join(allowed, 'ok.txt'), 'allowed-root file\n', 'utf8');
  // Symlink inside the allowlisted root, pointing at the vault dir.
  fs.symlinkSync(secretsDir, path.join(allowed, 'evil'), 'dir');
  const srv = await startServer(dir, {
    FACTORY_API_TOKEN: TOKEN_VALUE,
    FACTORY_SECRETS_DIR: secretsDir,
    FACTORY_REMOTE_ALLOWED_ROOTS: allowed,
  });
  try {
    await createVault(srv.port, secretsDir);
    const connId = await createLocalConnection(srv.port, allowed);
    // Pre-fix this read 200 with the vault bytes (lexical path inside
    // the allowed root); post-fix the jail decides on the canonical
    // path and refuses. The jail does not depend on bwrap, so this
    // assertion holds on any machine.
    const r = await api(srv.port, 'GET', `/api/remote/connections/${connId}/file?path=evil/vault.json`);
    assert.equal(r.status, 400, `symlink vault read was not jailed: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'INVALID_PATH');
    // Negative control: a file that really lives under the allowed
    // root is still readable.
    const ok = await api(srv.port, 'GET', `/api/remote/connections/${connId}/file?path=ok.txt`);
    assert.equal(ok.status, 200, `allowed-root read was jailed: ${JSON.stringify(ok.body)}`);
    assert.ok(String(ok.body.content ?? '').includes('allowed-root file'));
  } finally {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (q) N3: remote GET /files list through the jail
// ---------------------------------------------------------------------------

test('V3R19 #6(q) N3: a viewer GET /files list through a symlink that escapes the remote file jail is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r19-6pqs-'));
  const secretsDir = path.join(dir, 'secrets');
  const allowed = path.join(dir, 'allowed');
  fs.mkdirSync(allowed, { recursive: true });
  fs.writeFileSync(path.join(allowed, 'ok.txt'), 'allowed-root file\n', 'utf8');
  fs.symlinkSync(secretsDir, path.join(allowed, 'evil'), 'dir');
  const srv = await startServer(dir, {
    FACTORY_API_TOKEN: TOKEN_VALUE,
    FACTORY_SECRETS_DIR: secretsDir,
    FACTORY_REMOTE_ALLOWED_ROOTS: allowed,
  });
  try {
    await createVault(srv.port, secretsDir);
    const connId = await createLocalConnection(srv.port, allowed);
    // Pre-fix list had no jail at all: this 200 with
    // ["vault.json", "vault.key"]. Post-fix the same jail as GET /file
    // applies. The jail does not depend on bwrap.
    const r = await api(srv.port, 'GET', `/api/remote/connections/${connId}/files?path=evil`);
    assert.equal(r.status, 400, `symlink list was not jailed: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'INVALID_PATH');
    // Negative control: listing the allowed root itself still works.
    const ok = await api(srv.port, 'GET', `/api/remote/connections/${connId}/files?path=.`);
    assert.equal(ok.status, 200, `allowed-root list was jailed: ${JSON.stringify(ok.body)}`);
    const names = ((ok.body.entries ?? []) as string[]).map((e) => String(e));
    assert.ok(names.some((n) => n === 'ok.txt'), `ok.txt missing from list: ${JSON.stringify(names)}`);
  } finally {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (q) N4: remote POST /file write through the jail
// ---------------------------------------------------------------------------

test('V3R19 #6(q) N4: an operator POST /file write through a symlink that escapes the remote file jail is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r19-6pqs-'));
  const secretsDir = path.join(dir, 'secrets');
  const allowed = path.join(dir, 'allowed');
  fs.mkdirSync(allowed, { recursive: true });
  fs.symlinkSync(secretsDir, path.join(allowed, 'evil'), 'dir');
  const srv = await startServer(dir, {
    FACTORY_API_TOKEN: TOKEN_VALUE,
    FACTORY_SECRETS_DIR: secretsDir,
    FACTORY_REMOTE_ALLOWED_ROOTS: allowed,
  });
  try {
    await createVault(srv.port, secretsDir);
    const connId = await createLocalConnection(srv.port, allowed);
    // Pre-fix the write had no jail: it landed in the vault dir.
    // Post-fix the same jail as GET /file applies, before any mkdir.
    const r = await api(srv.port, 'POST', `/api/remote/connections/${connId}/file`, {
      path: 'evil/pwned.txt',
      content: 'pwned',
    });
    assert.equal(r.status, 400, `symlink write was not jailed: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'INVALID_PATH');
    assert.ok(!fs.existsSync(path.join(secretsDir, 'pwned.txt')), 'jailed write still landed in the vault dir');
    // Negative control: a write that really lands under the allowed
    // root still works (including a brand-new file).
    const ok = await api(srv.port, 'POST', `/api/remote/connections/${connId}/file`, {
      path: 'ok2.txt',
      content: 'hello',
    });
    assert.equal(ok.status, 200, `allowed-root write was jailed: ${JSON.stringify(ok.body)}`);
    const back = await api(srv.port, 'GET', `/api/remote/connections/${connId}/file?path=ok2.txt`);
    assert.equal(back.status, 200);
    assert.equal(String(back.body.content ?? ''), 'hello');
  } finally {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (s) N5: custom AI_FACTORY_DATA_DIR in the argv guard
// ---------------------------------------------------------------------------

test('V3R19 #6(s) N5: a command naming a custom AI_FACTORY_DATA_DIR is refused by the argv guard with the sandbox disabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-v3r19-6pqs-'));
  const secretsDir = path.join(dir, 'secrets');
  const customData = path.join(dir, 'custom-data');
  fs.mkdirSync(customData, { recursive: true });
  fs.writeFileSync(path.join(customData, 'notes.txt'), 'user data, not credentials\n', 'utf8');
  // The sandbox is OFF here on purpose: the (s) gap only bit in
  // disabled/danger modes, and the argv guard is mode-independent, so
  // the refusal must land with the sandbox disabled too.
  const srv = await startServer(dir, {
    FACTORY_API_TOKEN: TOKEN_VALUE,
    FACTORY_SECRETS_DIR: secretsDir,
    AI_FACTORY_DATA_DIR: customData,
    FACTORY_EXEC_SANDBOX: '0',
  });
  try {
    await createVault(srv.port, secretsDir);
    const r = await api(srv.port, 'POST', '/api/exec', {
      command: `cat ${path.join(customData, 'notes.txt')}`,
    });
    assert.equal(r.status, 403, `custom data-dir command was not refused: ${JSON.stringify(r.body)}`);
    assert.ok(
      String(r.body.error ?? '').includes('control-plane data directory'),
      `refusal names the wrong surface: ${JSON.stringify(r.body)}`,
    );
  } finally {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

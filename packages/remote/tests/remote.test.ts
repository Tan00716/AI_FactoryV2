/**
 * @ai-factory/remote package tests (R7-#1).
 *
 * Run: npm run build -w @ai-factory/remote && node --test packages/remote/dist/tests/*.test.js
 * No real sshd/docker/wsl needed: ssh is faked by a shim script on PATH
 * (FAKE_SSH_MODE=ok|fail); local transport uses a real temp directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RemoteConnectionStore,
  RemoteError,
  listDir,
  probe,
  readFile,
  resolveRemotePath,
  shellQuote,
  startForward,
  stopForward,
  listForwards,
  validateConnectionInput,
  writeFile,
  type RemoteConnection,
} from '../src/index';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remote-test-'));
}

function sshConn(root: string): RemoteConnection {
  return {
    id: 'c-ssh',
    name: 'fake-ssh',
    kind: 'ssh',
    host: 'example.invalid',
    port: 22,
    username: 'dev',
    keyPath: null,
    containerName: null,
    distro: null,
    remoteRoot: root,
    status: 'unknown',
    lastProbeAt: null,
    lastProbeMs: null,
    lastError: null,
    createdAt: '',
    updatedAt: '',
  };
}

function localConn(root: string): RemoteConnection {
  return { ...sshConn(root), id: 'c-local', name: 'local', kind: 'local', host: null, port: null, username: null };
}

/** Fake ssh: understands true / ls -1 / cat / cat > from a quoted remote command; -N sleeps. */
function makeShim(): { dir: string; shim: string } {
  const dir = tmpDir();
  const shim = path.join(dir, 'ssh');
  fs.writeFileSync(
    shim,
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.includes('-N')) { setInterval(() => {}, 3600_000); } else {
if (process.env.FAKE_SSH_MODE === 'fail') { console.error('fake ssh failure'); process.exit(1); }
const cmd = argv[argv.length - 1] || '';
function unquote(s) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === "'") {
        if (s[i + 1] === '\\\\') { cur += "'"; i += 2; continue; }
        q = false;
      } else cur += ch;
    } else if (ch === "'") q = true;
    else if (ch === ' ') { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const toks = unquote(cmd);
if (toks.length === 1 && toks[0] === 'true') process.exit(0);
if (toks[0] === 'ls' && toks[1] === '-1' && toks[2] === '--') {
  for (const n of fs.readdirSync(toks[3])) console.log(n);
  process.exit(0);
}
if (toks[0] === 'cat' && toks[1] === '--') {
  process.stdout.write(fs.readFileSync(toks[2]));
  process.exit(0);
}
if (cmd.startsWith('cat > ')) {
  const p = unquote(cmd.slice(6))[0];
  const data = fs.readFileSync(0);
  fs.mkdirSync(require('node:path').dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  process.exit(0);
}
console.error('fake ssh: unknown command ' + cmd);
process.exit(1);
}
`,
    'utf8',
  );
  fs.chmodSync(shim, 0o755);
  return { dir, shim };
}

function shimEnv(dir: string, mode = 'ok'): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}`, FAKE_SSH_MODE: mode };
}

test('validation accepts all kinds and defaults ssh port 22', () => {
  const ssh = validateConnectionInput({ name: 'a', kind: 'ssh', host: 'h.example', remoteRoot: '/srv' });
  assert.equal(ssh.port, 22);
  assert.equal(ssh.keyPath, null);
  validateConnectionInput({ name: 'b', kind: 'wsl', distro: 'Ubuntu', remoteRoot: '/home/dev' });
  validateConnectionInput({ name: 'c', kind: 'container', containerName: 'dev-1', remoteRoot: '/work' });
  validateConnectionInput({ name: 'd', kind: 'local', remoteRoot: '/tmp/x' });
});

test('validation rejects secrets, bad hosts, bad ports, missing container', () => {
  assert.throws(
    () => validateConnectionInput({ name: 'a', kind: 'ssh', host: 'h', remoteRoot: '/srv', password: 'x' }),
    (e: unknown) => e instanceof RemoteError && e.code === 'SECRET_FIELD_REJECTED',
  );
  assert.throws(
    () => validateConnectionInput({ name: 'a', kind: 'ssh', host: 'bad host', remoteRoot: '/srv' }),
    (e: unknown) => e instanceof RemoteError && e.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => validateConnectionInput({ name: 'a', kind: 'ssh', host: 'h', port: 0, remoteRoot: '/srv' }),
    (e: unknown) => e instanceof RemoteError && e.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => validateConnectionInput({ name: 'a', kind: 'container', remoteRoot: '/work' }),
    (e: unknown) => e instanceof RemoteError && e.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => validateConnectionInput({ name: 'a', kind: 'ssh', host: 'h', remoteRoot: 'relative' }),
    (e: unknown) => e instanceof RemoteError && e.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => validateConnectionInput({ name: 'a', kind: 'ssh', host: 'h', remoteRoot: '/srv', keyPath: 'rel/key' }),
    (e: unknown) => e instanceof RemoteError && e.code === 'INVALID_INPUT',
  );
});

test('resolveRemotePath jails paths to the root', () => {
  assert.equal(resolveRemotePath('/srv', 'a/b.txt'), '/srv/a/b.txt');
  assert.equal(resolveRemotePath('/srv', '.'), '/srv');
  assert.equal(resolveRemotePath('/srv/', 'a/../b'), '/srv/b');
  assert.throws(
    () => resolveRemotePath('/srv', '../etc/passwd'),
    (e: unknown) => e instanceof RemoteError && e.code === 'INVALID_PATH',
  );
  assert.throws(
    () => resolveRemotePath('/srv', '/etc/passwd'),
    (e: unknown) => e instanceof RemoteError && e.code === 'INVALID_PATH',
  );
});

test('shellQuote escapes single quotes', () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  assert.equal(shellQuote('plain'), `'plain'`);
});

test('store: create/list/dup/corrupt/status/remove', () => {
  const dir = tmpDir();
  const store = new RemoteConnectionStore(path.join(dir, 'remote-connections.json'));
  assert.deepEqual(store.list(), []);
  const c = store.create({ name: 'a', kind: 'ssh', host: 'h', remoteRoot: '/srv' });
  assert.equal(c.status, 'unknown');
  assert.equal(store.list().length, 1);
  assert.equal(store.get(c.id)?.name, 'a');
  assert.throws(
    () => store.create({ name: 'a', kind: 'ssh', host: 'h2', remoteRoot: '/srv' }),
    (e: unknown) => e instanceof RemoteError && e.code === 'DUPLICATE_NAME',
  );
  const updated = store.setStatus(c.id, { status: 'online', lastProbeMs: 12 });
  assert.equal(updated.status, 'online');
  assert.equal(updated.lastProbeMs, 12);
  assert.equal(store.remove(c.id), true);
  assert.equal(store.remove(c.id), false);
  fs.writeFileSync(store.filePath, '{corrupt', 'utf8');
  assert.throws(
    () => store.list(),
    (e: unknown) => e instanceof RemoteError && e.code === 'STORE_CORRUPT',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('local transport: probe, list, read, write, jail', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi\n', 'utf8');
  const conn = localConn(dir);
  const p = await probe(conn);
  assert.equal(p.online, true);
  const entries = await listDir(conn, '.');
  assert.ok(entries.includes('hello.txt'));
  assert.ok(entries.includes('sub/'));
  assert.equal(await readFile(conn, 'hello.txt'), 'hi\n');
  await writeFile(conn, 'sub/new.txt', 'written');
  assert.equal(fs.readFileSync(path.join(dir, 'sub', 'new.txt'), 'utf8'), 'written');
  await assert.rejects(
    readFile(conn, '../escape.txt'),
    (e: unknown) => e instanceof RemoteError && e.code === 'INVALID_PATH',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fake-ssh transport: probe, list, read, write round-trip', async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'a.txt'), 'fake-content', 'utf8');
  const { dir: shimDir } = makeShim();
  const env = shimEnv(shimDir);
  const conn = sshConn(root);
  const p = await probe(conn, { env });
  assert.equal(p.online, true);
  assert.ok((await listDir(conn, '.', { env })).includes('a.txt'));
  assert.equal(await readFile(conn, 'a.txt', { env }), 'fake-content');
  await writeFile(conn, 'b.txt', 'via-ssh', { env });
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'via-ssh');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(shimDir, { recursive: true, force: true });
});

test('fake-ssh probe failure reports offline, missing binary reports unavailable', async () => {
  const { dir: shimDir } = makeShim();
  const conn = sshConn('/srv');
  const failed = await probe(conn, { env: shimEnv(shimDir, 'fail') });
  assert.equal(failed.online, false);
  assert.equal(failed.reason, 'command-failed');
  const missing = await probe(conn, { env: { ...process.env, PATH: '/nonexistent-dir-xyz' } });
  assert.equal(missing.online, false);
  assert.equal(missing.reason, 'transport-unavailable');
  fs.rmSync(shimDir, { recursive: true, force: true });
});

test('forward: ssh start/list/stop lifecycle, dup and non-ssh refused', async () => {
  const { dir: shimDir } = makeShim();
  const origPath = process.env['PATH'];
  process.env['PATH'] = `${shimDir}:${origPath ?? ''}`;
  try {
    const conn = sshConn('/srv');
    const rec = await startForward(conn, 18080, 'localhost', 3000);
    assert.equal(rec.alive, true);
    assert.equal(rec.localPort, 18080);
    assert.equal(listForwards(conn.id).length, 1);
    await assert.rejects(
      startForward(conn, 18080, 'localhost', 3000),
      (e: unknown) => e instanceof RemoteError && e.code === 'DUPLICATE_FORWARD',
    );
    assert.equal(stopForward(conn.id, 18080), true);
    assert.equal(stopForward(conn.id, 18080), false);
    const local = localConn('/tmp');
    await assert.rejects(
      startForward(local, 18081, 'localhost', 3000),
      (e: unknown) => e instanceof RemoteError && e.code === 'UNSUPPORTED',
    );
  } finally {
    process.env['PATH'] = origPath;
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

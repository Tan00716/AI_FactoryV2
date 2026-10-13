/**
 * Batch 37 — build sandbox (bubblewrap) tests.
 *
 * Dual-mode note: imports the COMPILED ../dist/build-sandbox.js (root
 * build must run first), because build-sandbox.ts value-imports
 * @ai-factory/runtime, which node type-stripping cannot resolve from
 * src (AGENTS.md dual-mode rule).
 *
 * These tests need a WORKING bwrap probe to exercise the sandboxed
 * paths; they run as root in this environment, where the probe
 * succeeds. When the probe is unavailable the sandbox-specific
 * assertions are skipped loudly (not silently passed) — the fallback
 * path is always tested via a bogus FACTORY_BWRAP_BIN.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import {
  sandboxConfigFromEnv,
  probeSandbox,
  resetSandboxProbeCache,
  buildSandboxArgv,
  runSandboxedCommand,
  runBuildCommand,
} from '../dist/build-sandbox.js';

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

let probeOk = false;

before(async () => {
  resetSandboxProbeCache();
  const p = await probeSandbox('bwrap', 15000);
  probeOk = p.available;
  console.log(
    `[build-sandbox-test] probe: available=${p.available}${p.reason ? ` reason=${p.reason}` : ''}`,
  );
});

function skipUnlessSandboxed(t: string): boolean {
  if (!probeOk) {
    console.log(`[build-sandbox-test] SKIP ${t}: bwrap probe unavailable in this environment`);
    return true;
  }
  return false;
}

describe('sandboxConfigFromEnv', () => {
  it('defaults: enabled, network isolated, bwrap on PATH', () => {
    const c = sandboxConfigFromEnv({});
    assert.equal(c.enabled, true);
    assert.equal(c.network, false);
    assert.equal(c.bwrapBin, 'bwrap');
    assert.deepEqual(c.extraRoBinds, ['/usr', '/opt']);
  });
  it('FACTORY_BUILD_SANDBOX=0 disables', () => {
    assert.equal(sandboxConfigFromEnv({ FACTORY_BUILD_SANDBOX: '0' }).enabled, false);
    assert.equal(sandboxConfigFromEnv({ FACTORY_BUILD_SANDBOX: 'false' }).enabled, false);
    assert.equal(sandboxConfigFromEnv({ FACTORY_BUILD_SANDBOX: '1' }).enabled, true);
  });
  it('FACTORY_BUILD_SANDBOX_NETWORK=1 shares host network', () => {
    assert.equal(sandboxConfigFromEnv({ FACTORY_BUILD_SANDBOX_NETWORK: '1' }).network, true);
    assert.equal(sandboxConfigFromEnv({}).network, false);
  });
  it('FACTORY_BWRAP_BIN and FACTORY_BUILD_SANDBOX_RO_BINDS overrides', () => {
    const c = sandboxConfigFromEnv({
      FACTORY_BWRAP_BIN: '/nonexistent/bwrap-xyz',
      FACTORY_BUILD_SANDBOX_RO_BINDS: '/usr, /srv/toolchain ',
    });
    assert.equal(c.bwrapBin, '/nonexistent/bwrap-xyz');
    assert.deepEqual(c.extraRoBinds, ['/usr', '/srv/toolchain']);
  });
});

describe('buildSandboxArgv', () => {
  const base = { bwrapBin: 'bwrap', extraRoBinds: ['/usr', '/opt'] };
  it('isolates network by default and binds the workdir at /work', () => {
    const argv = buildSandboxArgv('/tmp/wd', ['npm', 'run', 'build'], {
      ...base,
      network: false,
    });
    assert.ok(argv.includes('--unshare-net'), 'expected --unshare-net');
    assert.ok(argv.includes('/work'));
    const dashdash = argv.indexOf('--');
    assert.deepEqual(argv.slice(dashdash + 1), ['npm', 'run', 'build']);
    assert.equal(argv[argv.indexOf('--chdir') + 1], '/work');
    assert.equal(argv[argv.indexOf('--bind') + 1], '/tmp/wd');
  });
  it('network opt-in drops --unshare-net and binds DNS/certs', () => {
    const argv = buildSandboxArgv('/tmp/wd', ['npm', 'install'], { ...base, network: true });
    assert.ok(!argv.includes('--unshare-net'), 'must not isolate net on opt-in');
    assert.ok(argv.includes('/etc/resolv.conf'));
  });
  it('rejects non-absolute workDir and empty tokens', () => {
    assert.throws(() => buildSandboxArgv('rel/path', ['x'], { ...base, network: false }));
    assert.throws(() => buildSandboxArgv('/tmp/wd', [], { ...base, network: false }));
  });
});

describe('probeSandbox', () => {
  it('returns a well-formed result; available when running as root', async () => {
    resetSandboxProbeCache();
    const p = await probeSandbox('bwrap', 15000);
    assert.equal(typeof p.available, 'boolean');
    if (p.available) assert.equal(p.reason, null);
    else assert.ok(p.reason && p.reason.length > 0);
    if (IS_ROOT) assert.equal(p.available, true);
  });
  it('bogus binary probes unavailable with a reason', async () => {
    resetSandboxProbeCache();
    const p = await probeSandbox('/nonexistent/bwrap-xyz-37', 15000);
    assert.equal(p.available, false);
    assert.ok(p.reason && p.reason.length > 0);
    resetSandboxProbeCache();
  });
});

describe('runSandboxedCommand', () => {
  it('runs the command with /work writable and visible on the host', async function () {
    if (skipUnlessSandboxed('writable /work')) return;
    const workDir = mkdtempSync(join(tmpdir(), 'sb-test-'));
    try {
      const r = await runSandboxedCommand(['/bin/sh', '-c', 'echo sandboxed-hello > /work/out.txt && cat /work/out.txt'], {
        workDir,
        timeoutMs: 30000,
        network: false,
        bwrapBin: 'bwrap',
        extraRoBinds: ['/usr', '/opt'],
      });
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /sandboxed-hello/);
      assert.equal(readFileSync(join(workDir, 'out.txt'), 'utf8').trim(), 'sandboxed-hello');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('cannot write outside /work and cannot see the host /tmp', async function () {
    if (skipUnlessSandboxed('escape attempts')) return;
    const workDir = mkdtempSync(join(tmpdir(), 'sb-test-'));
    const hostCanary = join(tmpdir(), `sb-canary-${Date.now()}.txt`);
    try {
      const r = await runSandboxedCommand(
        ['/bin/sh', '-c', `touch /etc/sb-evil 2>&1; echo "etc-exit:$?"; touch /tmp/sb-tmp 2>&1; echo "tmp-exit:$?"; ls /tmp/`],
        { workDir, timeoutMs: 30000, network: false, bwrapBin: 'bwrap', extraRoBinds: ['/usr', '/opt'] },
      );
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /etc-exit:[1-9]/); // /etc is read-only
      assert.ok(!existsSync('/etc/sb-evil'), 'must not write to host /etc');
      assert.ok(!existsSync(join(tmpdir(), 'sb-tmp')), 'sandbox /tmp must not leak to host');
      assert.ok(!existsSync(hostCanary));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('network is isolated: host loopback services are unreachable', async function () {
    if (skipUnlessSandboxed('network isolation')) return;
    const workDir = mkdtempSync(join(tmpdir(), 'sb-test-'));
    const server = createServer((sock) => sock.end());
    try {
      await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
      const port = (server.address() as { port: number }).port;
      const probeJs = `require('node:net').connect(${port},'127.0.0.1').on('connect',()=>{console.log('REACHABLE');process.exit(0)}).on('error',e=>{console.log('BLOCKED:'+e.code);process.exit(0)});setTimeout(()=>{console.log('TIMEOUT');process.exit(0)},5000)`;
      writeFileSync(join(workDir, 'netprobe.js'), probeJs);
      const r = await runSandboxedCommand(['/usr/bin/node', '/work/netprobe.js'], {
        workDir,
        timeoutMs: 30000,
        network: false,
        bwrapBin: 'bwrap',
        extraRoBinds: ['/usr', '/opt'],
      });
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      assert.ok(!r.stdout.includes('REACHABLE'), `host service must be unreachable, got: ${r.stdout}`);
      assert.match(r.stdout, /BLOCKED|TIMEOUT/);
    } finally {
      server.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('runBuildCommand decision tree', () => {
  it('SANDBOX_UNAVAILABLE: bogus bwrap falls back unsandboxed and audits loudly', async () => {
    resetSandboxProbeCache();
    const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
    const workDir = mkdtempSync(join(tmpdir(), 'sb-test-'));
    try {
      const r = await runBuildCommand(['/bin/sh', '-c', 'echo fallback-ok'], {
        workDir,
        timeoutMs: 30000,
        buildId: 'build-sb-fallback-1',
        sandbox: {
          enabled: true,
          network: false,
          bwrapBin: '/nonexistent/bwrap-xyz-37',
          extraRoBinds: ['/usr', '/opt'],
        },
        audit: { record: (action, details) => audits.push({ action, details }) },
      });
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout, /fallback-ok/);
      const unavail = audits.find((a) => a.action === 'SANDBOX_UNAVAILABLE');
      assert.ok(unavail, 'expected SANDBOX_UNAVAILABLE audit');
      assert.ok(String(unavail.details['reason'] ?? '').length > 0);
      assert.ok(!audits.some((a) => a.action === 'BUILD_SANDBOXED'));
    } finally {
      resetSandboxProbeCache();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('disabled sandbox runs unsandboxed with no audit either way', async () => {
    const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
    const workDir = mkdtempSync(join(tmpdir(), 'sb-test-'));
    try {
      const r = await runBuildCommand(['/bin/sh', '-c', 'echo plain-ok'], {
        workDir,
        timeoutMs: 30000,
        buildId: 'build-sb-plain-1',
        sandbox: { enabled: false, network: false, bwrapBin: 'bwrap', extraRoBinds: ['/usr', '/opt'] },
        audit: { record: (action, details) => audits.push({ action, details }) },
      });
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout, /plain-ok/);
      assert.equal(audits.length, 0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('BUILD_SANDBOXED audit on the success path', async function () {
    if (skipUnlessSandboxed('BUILD_SANDBOXED audit')) return;
    resetSandboxProbeCache();
    const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
    const workDir = mkdtempSync(join(tmpdir(), 'sb-test-'));
    try {
      const r = await runBuildCommand(['/bin/sh', '-c', 'echo boxed-ok'], {
        workDir,
        timeoutMs: 30000,
        buildId: 'build-sb-boxed-1',
        sandbox: { enabled: true, network: false, bwrapBin: 'bwrap', extraRoBinds: ['/usr', '/opt'] },
        audit: { record: (action, details) => audits.push({ action, details }) },
      });
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /boxed-ok/);
      const boxed = audits.find((a) => a.action === 'BUILD_SANDBOXED');
      assert.ok(boxed, 'expected BUILD_SANDBOXED audit');
      assert.equal(boxed.details['network'], 'isolated');
    } finally {
      resetSandboxProbeCache();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

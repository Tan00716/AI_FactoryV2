/**
 * Bubblewrap sandbox for the post-merge build runner — SPEC v2 §7 SANDBOX STRATEGY (Batch 37).
 *
 * What this is, honestly:
 *
 *  The build runner executes repo-controlled code (e.g. `npm run build`
 *  runs the merged package.json scripts). Historically it ran with the
 *  server's OS privileges inside a worktree dir — NOT a sandbox
 *  (KNOWN_LIMITATIONS said so, plainly). This module adds an optional
 *  OS-level sandbox around the build command itself, using bubblewrap
 *  (bwrap) user namespaces:
 *
 *   - filesystem: the build sees a fresh root with /usr, /opt and the
 *     other toolchain roots mounted READ-ONLY, a tmpfs /tmp, and exactly
 *     one writable bind — the build worktree, mounted at /work. The
 *     server's home directory, /etc (except DNS/certs when network is
 *     on), and every other host path are simply not there.
 *   - processes/IPC: fresh pid/ipc/uts namespaces, --die-with-parent.
 *   - network: ISOLATED by default (own net namespace, no route out —
 *     not even the host's loopback services are reachable). Opt-in via
 *     FACTORY_BUILD_SANDBOX_NETWORK=1, which shares the host network
 *     and binds DNS/certs read-only.
 *
 *  What this is NOT:
 *
 *   - Not a guarantee on machines without a working bwrap. Availability
 *     is PROBED at runtime (a real bwrap invocation, not a version
 *     string): when the probe fails the runner falls back to the
 *     previous unsandboxed behavior and audits SANDBOX_UNAVAILABLE with
 *     the probe's reason — never a silent downgrade, never a claim of
 *     isolation that isn't there.
 *   - Not a multi-machine story: one host, one kernel, same as before.
 *   - The environment (PATH, env vars) passes through — it is operator
 *     configuration, and the command itself was already execution-
 *     policy-checked before it gets here.
 *   - HOME inside the sandbox is an empty tmpfs (/tmp), not the
 *     server's real home. Toolchains must live under the read-only
 *     roots (/usr, /opt, plus FACTORY_BUILD_SANDBOX_RO_BINDS).
 *   - bwrap is looked up as `bwrap` on PATH (override with
 *     FACTORY_BWRAP_BIN, used by tests). Installing bubblewrap on the
 *     host is the operator's job — this module does not install it.
 */

import {
  runCommandPipe,
  SandboxUnavailableError,
  type ShellRunResult,
} from '@ai-factory/runtime';

export const BUILD_SANDBOX_ENV = 'FACTORY_BUILD_SANDBOX';
export const BUILD_SANDBOX_NETWORK_ENV = 'FACTORY_BUILD_SANDBOX_NETWORK';
export const BUILD_SANDBOX_RO_BINDS_ENV = 'FACTORY_BUILD_SANDBOX_RO_BINDS';
export const BWRAP_BIN_ENV = 'FACTORY_BWRAP_BIN';

/** Default read-only toolchain roots inside the sandbox. */
export const DEFAULT_SANDBOX_RO_BINDS = ['/usr', '/opt'];

export interface SandboxConfig {
  /** Master switch. Default true; '0'/'false'/'no'/'off' disables. */
  enabled: boolean;
  /** Share the host network instead of isolating it. Default false. */
  network: boolean;
  /** bwrap binary (PATH lookup or absolute). Overridable for tests. */
  bwrapBin: string;
  /** Extra read-only binds (absolute host paths). Default /usr,/opt. */
  extraRoBinds: string[];
}

function isFalsySwitch(v: string): boolean {
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

function isTruthySwitch(v: string): boolean {
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function sandboxConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SandboxConfig {
  const enabled = !isFalsySwitch((env[BUILD_SANDBOX_ENV] ?? '').trim().toLowerCase());
  const network = isTruthySwitch(
    (env[BUILD_SANDBOX_NETWORK_ENV] ?? '').trim().toLowerCase(),
  );
  const extraRoBinds = ((env[BUILD_SANDBOX_RO_BINDS_ENV] ?? '').trim() || '/usr,/opt')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    enabled,
    network,
    bwrapBin: (env[BWRAP_BIN_ENV] ?? '').trim() || 'bwrap',
    extraRoBinds,
  };
}

export interface SandboxProbe {
  available: boolean;
  /** Human-readable reason when unavailable; null when available. */
  reason: string | null;
}

// Probe cache, keyed by binary: the probe is a real bwrap invocation
// (a version string proves nothing about userns availability).
let probeCache: { bin: string; probe: Promise<SandboxProbe> } | null = null;

/** For tests: drop the cached probe so the next call re-probes. */
export function resetSandboxProbeCache(): void {
  probeCache = null;
}

/**
 * The read-only OS binds shared by the probe and the real sandbox argv.
 * /bin//lib//lib64 are symlinks into /usr on usr-merged systems and
 * real dirs elsewhere — -try covers both. (Without /lib64 the dynamic
 * loader is missing and exec fails with ENOENT — a real gotcha caught
 * by the probe test.)
 */
export function sandboxRoBindArgs(extraRoBinds: string[]): string[] {
  const a: string[] = [];
  for (const p of [...extraRoBinds, '/bin', '/lib', '/lib64']) {
    a.push('--ro-bind-try', p, p);
  }
  return a;
}

async function doProbe(bin: string, timeoutMs: number): Promise<SandboxProbe> {
  try {
    const r = await runCommandPipe(
      [
        bin,
        '--unshare-all',
        '--die-with-parent',
        ...sandboxRoBindArgs(DEFAULT_SANDBOX_RO_BINDS),
        '--dev',
        '/dev',
        '--tmpfs',
        '/tmp',
        '--chdir',
        '/tmp',
        '--',
        '/usr/bin/true',
      ],
      { timeoutMs },
    );
    if (r.exitCode === 0) return { available: true, reason: null };
    const detail = (r.stderr || r.stdout || '').trim().slice(0, 300);
    return {
      available: false,
      reason: `bwrap probe exited ${r.exitCode}${detail ? `: ${detail}` : ''}`,
    };
  } catch (err) {
    return {
      available: false,
      reason: `bwrap probe failed to spawn: ${(err as Error).message}`.slice(0, 300),
    };
  }
}

export function probeSandbox(
  bin: string = 'bwrap',
  timeoutMs: number = 15000,
): Promise<SandboxProbe> {
  if (!probeCache || probeCache.bin !== bin) {
    probeCache = { bin, probe: doProbe(bin, timeoutMs) };
  }
  return probeCache.probe;
}

/**
 * Strict form of the probe (Batch 40): throws SandboxUnavailableError
 * (code ENV_SANDBOX_UNAVAILABLE) when bwrap is not usable. The default
 * runBuildCommand path keeps the honest fallback (audit
 * SANDBOX_UNAVAILABLE + run unsandboxed) — this is for callers that
 * REQUIRE the sandbox and want a deterministic machine-readable signal
 * that flows through RunResult.reasonCode. Signal layer only: nothing
 * auto-emits needsHuman on this code.
 */
export async function assertSandboxAvailable(bin: string = 'bwrap'): Promise<void> {
  const probe = await probeSandbox(bin);
  if (!probe.available) {
    throw new SandboxUnavailableError(probe.reason ?? 'probe failed');
  }
}

export interface SandboxRunOptions {
  network: boolean;
  bwrapBin: string;
  extraRoBinds: string[];
  timeoutMs: number;
}

/**
 * Build the bwrap argv for running `tokens` with the worktree at /work.
 * The command itself was already execution-policy-checked by the caller
 * (build-runner.ts) — this layer only confines it.
 */
export function buildSandboxArgv(
  workDir: string,
  tokens: string[],
  opts: { network: boolean; bwrapBin: string; extraRoBinds: string[] },
): string[] {
  if (!workDir || !workDir.startsWith('/')) {
    throw new Error('buildSandboxArgv: workDir must be an absolute path');
  }
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error('buildSandboxArgv: tokens must be a non-empty argv');
  }
  const a: string[] = [opts.bwrapBin];
  // Namespaces: always user/ipc/pid/uts (+cgroup when the kernel
  // allows); the network namespace is what actually isolates traffic,
  // so it is only skipped on explicit opt-in.
  a.push(
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-cgroup-try',
  );
  if (!opts.network) a.push('--unshare-net');
  a.push('--die-with-parent');
  // Toolchain roots, read-only (shared with the probe — see
  // sandboxRoBindArgs for why /lib64 matters).
  a.push(...sandboxRoBindArgs(opts.extraRoBinds));
  a.push('--dev', '/dev', '--tmpfs', '/tmp');
  // HOME is a fresh empty tmpfs, not the server's real home: builds
  // get a writable cache location and nothing else.
  a.push('--setenv', 'HOME', '/tmp');
  if (opts.network) {
    // DNS + TLS roots so registry fetches can actually work.
    a.push(
      '--ro-bind-try',
      '/etc/resolv.conf',
      '/etc/resolv.conf',
      '--ro-bind-try',
      '/etc/ssl',
      '/etc/ssl',
    );
  }
  // The single writable bind: the build worktree, at a fixed sandbox path.
  a.push('--bind', workDir, '/work', '--chdir', '/work');
  a.push('--', ...tokens);
  return a;
}

export function runSandboxedCommand(
  tokens: string[],
  opts: {
    workDir: string;
    timeoutMs: number;
    network: boolean;
    bwrapBin: string;
    extraRoBinds: string[];
  },
): Promise<ShellRunResult> {
  const argv = buildSandboxArgv(opts.workDir, tokens, opts);
  // cwd for the bwrap supervisor itself is irrelevant (it chdirs to
  // /work inside); the host workDir exists, so use it.
  return runCommandPipe(argv, { cwd: opts.workDir, timeoutMs: opts.timeoutMs });
}

export interface BuildCommandAudit {
  record(action: string, details: Record<string, unknown>): void;
}

/**
 * The full decision tree used by the build runner:
 *
 *  - sandbox disabled in config → run as before, no audit either way
 *    (the operator chose this explicitly).
 *  - probe says bwrap works → run sandboxed, audit BUILD_SANDBOXED.
 *  - probe fails → audit SANDBOX_UNAVAILABLE with the probe's reason
 *    and run the command exactly as before (honest fallback, never a
 *    silent downgrade).
 */
export async function runBuildCommand(
  tokens: string[],
  opts: {
    workDir: string;
    timeoutMs: number;
    buildId: string;
    sandbox: SandboxConfig;
    audit: BuildCommandAudit;
  },
): Promise<ShellRunResult> {
  const { sandbox } = opts;
  if (!sandbox.enabled) {
    return runCommandPipe(tokens, { cwd: opts.workDir, timeoutMs: opts.timeoutMs });
  }
  const probe = await probeSandbox(sandbox.bwrapBin);
  if (probe.available) {
    opts.audit.record('BUILD_SANDBOXED', {
      buildId: opts.buildId,
      network: sandbox.network ? 'shared' : 'isolated',
      bwrap: sandbox.bwrapBin,
    });
    return runSandboxedCommand(tokens, {
      workDir: opts.workDir,
      timeoutMs: opts.timeoutMs,
      network: sandbox.network,
      bwrapBin: sandbox.bwrapBin,
      extraRoBinds: sandbox.extraRoBinds,
    });
  }
  opts.audit.record('SANDBOX_UNAVAILABLE', {
    buildId: opts.buildId,
    reason: probe.reason ?? 'probe failed',
    fallback: 'unsandboxed execution (pre-Batch-37 behavior)',
  });
  return runCommandPipe(tokens, { cwd: opts.workDir, timeoutMs: opts.timeoutMs });
}

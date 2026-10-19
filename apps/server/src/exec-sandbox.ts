/**
 * Bubblewrap sandbox for /api/exec one-shots, interactive terminal
 * sessions and the server tool-runner's shell.execute — the exec-side
 * sibling of build-sandbox.ts (which covers the post-merge build
 * runner).
 *
 * What this is, honestly:
 *
 *  Policy (routes/exec.ts: binary whitelist, deny patterns, control-dir
 *  guard, hooks) decides WHAT may run. This module decides WHERE it
 *  runs: inside a bubblewrap user-namespace sandbox when bwrap works
 *  on the host, directly on the host when it does not. The two layers
 *  are independent — the policy is unchanged by this module, and the
 *  sandbox never grants permission.
 *
 *  Inside the sandbox the command sees:
 *   - a fresh root with /usr, /opt (+/bin//lib//lib64 via --ro-bind-try)
 *     mounted READ-ONLY, a tmpfs /tmp, /dev, and exactly one writable
 *     bind — the request's cwd, mounted AT ITS REAL PATH (so absolute
 *     paths keep working, unlike the build sandbox's /work). The
 *     server's home directory, /etc (except DNS/certs when the network
 *     is shared), and every other host path are simply not there.
 *   - HOME is a fresh empty tmpfs (/tmp), not the server's real home:
 *     dotfiles (~/.gitconfig, ~/.npmrc, …) are neither read nor
 *     written.
 *   - fresh pid/ipc/uts namespaces, --die-with-parent.
 *   - network: SHARED with the host by default (unlike the build
 *     sandbox, which isolates by default — one-shot exec and
 *     interactive terminals legitimately use the network, e.g. npm).
 *     Set FACTORY_EXEC_SANDBOX_NETWORK=0 for --unshare-net.
 *
 *  What this is NOT:
 *
 *   - Not a guarantee on machines without a working bwrap. Availability
 *     is PROBED at runtime (the shared probeSandbox from
 *     build-sandbox.ts — a real bwrap invocation, not a version
 *     string). When the probe fails the caller runs the command
 *     exactly as before and MUST mark the run `sandbox: 'none
 *     (fallback)'` with the probe's reason in the audit record and the
 *     response — never a silent downgrade, never a claim of isolation
 *     that isn't there.
 *   - Not a confinement proof for §7.5: agent (non-human) one-shot
 *     exec stays refused by routes/exec.ts's gate regardless of this
 *     module. A bwrap-backed IsolationBackend that would let §7.5 pass
 *     is a separate, deliberate product decision — not smuggled in
 *     here.
 *   - bwrap is looked up as `bwrap` on PATH (override with
 *     FACTORY_BWRAP_BIN, shared with the build sandbox). Linux-only in
 *     practice; on other platforms the probe fails and every run is
 *     honestly marked as fallback.
 */

import {
  probeSandbox,
  resetSandboxProbeCache,
  sandboxRoBindArgs,
  BWRAP_BIN_ENV,
} from './build-sandbox';

/** Re-exported for tests: drop the cached probe so the next call re-probes. */
export { resetSandboxProbeCache as resetExecSandboxProbeCacheForTests };

export const EXEC_SANDBOX_ENV = 'FACTORY_EXEC_SANDBOX';
export const EXEC_SANDBOX_NETWORK_ENV = 'FACTORY_EXEC_SANDBOX_NETWORK';
export const EXEC_SANDBOX_RO_BINDS_ENV = 'FACTORY_EXEC_SANDBOX_RO_BINDS';

export interface ExecSandboxConfig {
  /** Master switch. Default true; '0'/'false'/'no'/'off' disables. */
  enabled: boolean;
  /**
   * Share the host network inside the sandbox. Default TRUE (unlike the
   * build sandbox: exec/terminal legitimately use the network);
   * '0'/'false'/'no'/'off' isolates with --unshare-net.
   */
  network: boolean;
  /** bwrap binary (PATH lookup or absolute). Overridable for tests. */
  bwrapBin: string;
  /** Extra read-only binds (absolute host paths). Default /usr,/opt. */
  extraRoBinds: string[];
}

function isFalsySwitch(v: string): boolean {
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

export function execSandboxConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ExecSandboxConfig {
  const enabled = !isFalsySwitch((env[EXEC_SANDBOX_ENV] ?? '').trim().toLowerCase());
  // Default: share the host network ("no-network 可选" — isolation is
  // the opt-in, because one-shot exec and interactive terminals
  // legitimately use the network, e.g. npm).
  const network = !isFalsySwitch((env[EXEC_SANDBOX_NETWORK_ENV] ?? '').trim().toLowerCase());
  const extraRoBinds = ((env[EXEC_SANDBOX_RO_BINDS_ENV] ?? '').trim() || '/usr,/opt')
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

/**
 * Build the bwrap argv PREFIX for running a command with `cwd` as the
 * working directory. The caller appends its own tokens after the
 * trailing '--'. Unlike the build sandbox (worktree at /work), the cwd
 * is bound AT ITS REAL PATH so absolute paths keep working for
 * interactive terminals and one-shot exec alike.
 */
export function buildExecSandboxPrefix(
  cwd: string,
  opts: { network: boolean; bwrapBin: string; extraRoBinds: string[] },
): string[] {
  if (!cwd || !cwd.startsWith('/')) {
    throw new Error('buildExecSandboxPrefix: cwd must be an absolute path');
  }
  const a: string[] = [opts.bwrapBin];
  a.push(
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-cgroup-try',
  );
  if (!opts.network) a.push('--unshare-net');
  a.push('--die-with-parent');
  // Toolchain roots, read-only (shared helper with the probe — see
  // build-sandbox.ts sandboxRoBindArgs for why /lib64 matters).
  a.push(...sandboxRoBindArgs(opts.extraRoBinds));
  a.push('--dev', '/dev', '--tmpfs', '/tmp');
  // HOME is a fresh empty tmpfs, not the server's real home.
  a.push('--setenv', 'HOME', '/tmp');
  if (opts.network) {
    // DNS + TLS roots so registry fetches (npm, git) can work on the
    // shared host network.
    a.push(
      '--ro-bind-try',
      '/etc/resolv.conf',
      '/etc/resolv.conf',
      '--ro-bind-try',
      '/etc/ssl',
      '/etc/ssl',
    );
  }
  // The single writable bind: the request's cwd, at its real path.
  a.push('--bind', cwd, cwd, '--chdir', cwd);
  a.push('--');
  return a;
}

/**
 * The sandbox mode reported for a run. 'bwrap' = the command ran (or
 * the session was created) inside the sandbox; 'none (fallback)' =
 * bwrap was unavailable and the command ran directly on the host —
 * callers MUST surface this in audit records and responses, never
 * silently; 'disabled' = the operator turned the sandbox off
 * (FACTORY_EXEC_SANDBOX=0).
 */
export type ExecSandboxMode = 'bwrap' | 'none (fallback)' | 'disabled';

export interface ExecSandboxDecision {
  mode: ExecSandboxMode;
  /** Argv prefix to prepend to the command (empty when not sandboxed). */
  prefix: string[];
  /** Human-readable reason when mode is 'none (fallback)'. */
  reason: string | null;
}

/**
 * The decision tree for one exec/terminal run:
 *
 *  - sandbox disabled in config → direct execution, no probe, no audit
 *    either way (the operator chose this explicitly; the mode is still
 *    reported as 'disabled' so responses stay honest).
 *  - probe says bwrap works → prefix for sandboxed execution.
 *  - probe fails → empty prefix (direct execution, exactly as before)
 *    with mode 'none (fallback)' and the probe's reason — the caller
 *    MUST mark the run with both, in the audit record and the
 *    response.
 */
export async function decideExecSandbox(
  cwd: string,
  config: ExecSandboxConfig,
): Promise<ExecSandboxDecision> {
  if (!config.enabled) {
    return { mode: 'disabled', prefix: [], reason: null };
  }
  const probe = await probeSandbox(config.bwrapBin);
  if (probe.available) {
    return {
      mode: 'bwrap',
      prefix: buildExecSandboxPrefix(cwd, config),
      reason: null,
    };
  }
  return {
    mode: 'none (fallback)',
    prefix: [],
    reason: probe.reason ?? 'bwrap probe failed',
  };
}

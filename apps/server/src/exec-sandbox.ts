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
 *     mounted READ-ONLY, a tmpfs /tmp, /dev, and — in workspace-write
 *     mode — exactly one writable bind: the request's cwd, mounted AT
 *     ITS REAL PATH (so absolute paths keep working, unlike the build
 *     sandbox's /work). In read-only mode (sandbox-modes.ts) the cwd
 *     is bound READ-ONLY instead: the only writable path is /tmp.
 *     The server's home directory, /etc (except DNS/certs when the
 *     network is shared), and every other host path are simply not
 *     there.
 *   - HOME is a fresh empty tmpfs (/tmp), not the server's real home:
 *     dotfiles (~/.gitconfig, ~/.npmrc, …) are neither read nor
 *     written.
 *   - fresh pid/ipc/uts namespaces, --die-with-parent.
 *   - network: SHARED with the host by default (unlike the build
 *     sandbox, which isolates by default — one-shot exec and
 *     interactive terminals legitimately use the network, e.g. npm).
 *     Set FACTORY_EXEC_SANDBOX_NETWORK=0 for --unshare-net.
 *
 *  Sandbox modes (see sandbox-modes.ts for resolution):
 *
 *   - 'workspace-write' (default): the behavior above.
 *   - 'read-only': cwd bound --ro-bind; writes outside /tmp are
 *     refused by the kernel. Network follows the offline switch.
 *   - 'danger-full-access': handled by the caller (no sandbox at all);
 *     decideExecSandbox reports it directly and NEVER probes.
 *
 *  Fail-closed (no fake isolation): read-only and workspace-write
 *  REQUIRE a working bwrap. When the probe fails (non-Linux, bwrap
 *  missing, user namespaces disabled) the decision is
 *  refused=true / SANDBOX_UNAVAILABLE — the caller MUST refuse the
 *  run (403), never run it unisolated. The old 'none (fallback)'
 *  behavior (run anyway, marked) is gone: there is no fallback, only
 *  refusal. The audit/response `sandbox` field reports the actual
 *  tier — 'read-only' | 'workspace-write' | 'danger-full-access' |
 *  'disabled' (explicit operator opt-out) — never a vague 'bwrap',
 *  never a fake claim.
 *
 *  What this is NOT:
 *
 *   - Not a guarantee on machines without a working bwrap. Availability
 *     is PROBED at runtime (the shared probeSandbox from
 *     build-sandbox.ts — a real bwrap invocation, not a version
 *     string). When the probe fails, read-only and workspace-write
 *     runs are REFUSED (fail-closed): the caller must answer 403
 *     SANDBOX_UNAVAILABLE with the probe's reason in the audit record
 *     and the response — never a silent downgrade, never a claim of
 *     isolation that isn't there, never "run anyway and mark it".
 *   - Not a confinement proof for §7.5: agent (non-human) one-shot
 *     exec stays refused by routes/exec.ts's gate regardless of this
 *     module. A bwrap-backed IsolationBackend that would let §7.5 pass
 *     is a separate, deliberate product decision — not smuggled in
 *     here.
 *   - bwrap is looked up as `bwrap` on PATH (override with
 *     FACTORY_BWRAP_BIN, shared with the build sandbox). Linux-only in
 *     practice; on other platforms the probe fails and every
 *     read-only/workspace-write run is honestly refused.
 */

import {
  probeSandbox,
  resetSandboxProbeCache,
  sandboxRoBindArgs,
  BWRAP_BIN_ENV,
} from './build-sandbox';
import type { SandboxMode } from './sandbox-modes';
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/**
 * Control-plane directories that must never be visible inside a sandbox
 * whose cwd contains them (V3.0 audit round 17, item #6 sub-item (k)(a2)).
 *
 * The vault lives under the control-plane data dir by default
 * (<data>/secrets — packages/secrets/src/config.ts), and the server's
 * cwd IS the workspace root, so a run whose cwd is the server cwd (or
 * an ancestor of the data dir) would otherwise have the vault inside
 * its one writable bind. The exclusion is enforced by mounting an
 * empty tmpfs over each such directory AFTER the cwd bind, so the
 * child sees an empty directory there instead of the vault.
 *
 * Candidates (absolute, deduplicated, only those strictly UNDER cwd —
 * a run whose cwd IS the control dir itself is not silently repaired
 * here; the control-dir argv guard and the project-root cwd jail are
 * what keep runs out of the data dir in the first place):
 *   - dirname(DB_PATH) — the control-plane data dir (routes/exec.ts
 *     CONTROL_DATA_DIR uses the same derivation);
 *   - FACTORY_SECRETS_DIR, when set (vault moved out of the data dir);
 *   - AI_FACTORY_DATA_DIR, when set (user data dir, may differ from
 *     dirname(DB_PATH) in tests and custom layouts).
 * A candidate that does not exist on the host is skipped — there is
 * nothing to hide — which also keeps the prefix stable for runs
 * whose vault was never created.
 */
export function sandboxExcludeDirs(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const base = resolve(cwd);
  const prefix = base.endsWith(sep) ? base : base + sep;
  const candidates: string[] = [dirname(resolve(env.DB_PATH ?? './data/factory.db'))];
  if (env.FACTORY_SECRETS_DIR) candidates.push(resolve(env.FACTORY_SECRETS_DIR));
  if (env.AI_FACTORY_DATA_DIR) candidates.push(resolve(env.AI_FACTORY_DATA_DIR));
  const out: string[] = [];
  for (const dir of candidates) {
    const abs = resolve(dir);
    if (abs === base || !abs.startsWith(prefix)) continue;
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/** Re-exported for tests: drop the cached probe so the next call re-probes. */
export { resetSandboxProbeCache as resetExecSandboxProbeCacheForTests };

export const EXEC_SANDBOX_ENV = 'FACTORY_EXEC_SANDBOX';
export const EXEC_SANDBOX_NETWORK_ENV = 'FACTORY_EXEC_SANDBOX_NETWORK';
export const EXEC_SANDBOX_RO_BINDS_ENV = 'FACTORY_EXEC_SANDBOX_RO_BINDS';

export interface ExecSandboxConfig {
  /** Master switch. Default true; '0'/'false'/'no'/'off' disables. */
  enabled: boolean;
  /**
   * The OS-enforced tier (sandbox-modes.ts). Default 'workspace-write'.
   * 'danger-full-access' is resolved by the caller before this module
   * is consulted — decideExecSandbox reports it directly and never
   * probes for it.
   */
  mode: SandboxMode;
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
    mode: 'workspace-write',
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
  opts: { network: boolean; bwrapBin: string; extraRoBinds: string[]; excludeDirs?: string[] },
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
  a.push('--bind', cwd, cwd);
  // V3R17 #6(k)(a2): control-plane dirs under the cwd (the vault) are
  // shadowed by empty tmpfs mounts AFTER the bind, so the child sees
  // an empty directory there. Only dirs that exist on the host are
  // overlaid — a missing dir has nothing to hide and bwrap would fail
  // the mount.
  for (const dir of opts.excludeDirs ?? []) {
    if (existsSync(dir)) a.push('--tmpfs', dir);
  }
  a.push('--chdir', cwd);
  a.push('--');
  return a;
}

/**
 * Build the bwrap argv PREFIX for the read-only tier: identical to
 * buildExecSandboxPrefix except the cwd is bound READ-ONLY
 * (--ro-bind) instead of writable. The only writable path inside is
 * the tmpfs /tmp (HOME=/tmp) — any write outside it is refused by the
 * kernel, not by policy text.
 */
export function buildReadOnlySandboxPrefix(
  cwd: string,
  opts: { network: boolean; bwrapBin: string; extraRoBinds: string[]; excludeDirs?: string[] },
): string[] {
  if (!cwd || !cwd.startsWith('/')) {
    throw new Error('buildReadOnlySandboxPrefix: cwd must be an absolute path');
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
  a.push(...sandboxRoBindArgs(opts.extraRoBinds));
  a.push('--dev', '/dev', '--tmpfs', '/tmp');
  a.push('--setenv', 'HOME', '/tmp');
  if (opts.network) {
    a.push(
      '--ro-bind-try',
      '/etc/resolv.conf',
      '/etc/resolv.conf',
      '--ro-bind-try',
      '/etc/ssl',
      '/etc/ssl',
    );
  }
  // The cwd, READ-ONLY, at its real path. No writable bind at all.
  a.push('--ro-bind', cwd, cwd);
  // V3R17 #6(k)(a2): same control-plane shadowing as the writable
  // tier — a read-only bind still EXPOSES the vault for reading.
  for (const dir of opts.excludeDirs ?? []) {
    if (existsSync(dir)) a.push('--tmpfs', dir);
  }
  a.push('--chdir', cwd);
  a.push('--');
  return a;
}

/**
 * The sandbox tier reported for a run. This is the ACTUAL tier that
 * applied — 'read-only' | 'workspace-write' | 'danger-full-access' —
 * or 'disabled' when the operator explicitly turned the sandbox off
 * (FACTORY_EXEC_SANDBOX=0). It is never 'bwrap' (vague) and never a
 * faked tier: callers MUST surface this value in audit records and
 * responses, and must refuse (not downgrade) when refused=true.
 */
export type ExecSandboxReport =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'
  | 'disabled';

export interface ExecSandboxDecision {
  mode: ExecSandboxReport;
  /** Argv prefix to prepend to the command (empty when not sandboxed). */
  prefix: string[];
  /** Human-readable reason when refused (the probe's reason). */
  reason: string | null;
  /** True when a bwrap prefix is actually applied to the command. */
  sandboxed: boolean;
  /**
   * Fail-closed: OS isolation is required by the tier but bwrap is
   * unavailable. The caller MUST refuse the run (403
   * SANDBOX_UNAVAILABLE) — never run it unisolated.
   */
  refused: boolean;
  refuseCode: 'SANDBOX_UNAVAILABLE' | null;
}

/**
 * The decision tree for one exec/terminal run:
 *
 *  - sandbox disabled in config → direct execution, no probe, reported
 *    as 'disabled' (the operator chose this explicitly).
 *  - mode 'danger-full-access' → direct execution by design (the tier
 *    IS "no sandbox"); reported as 'danger-full-access'. The caller
 *    must have passed the danger approval gate first.
 *  - mode 'read-only' / 'workspace-write' → probe bwrap:
 *      available → sandboxed prefix for the tier;
 *      unavailable → refused=true, SANDBOX_UNAVAILABLE. No fallback.
 */
export async function decideExecSandbox(
  cwd: string,
  config: ExecSandboxConfig,
): Promise<ExecSandboxDecision> {
  if (!config.enabled) {
    return { mode: 'disabled', prefix: [], reason: null, sandboxed: false, refused: false, refuseCode: null };
  }
  if (config.mode === 'danger-full-access') {
    // By design: no sandbox. The danger approval gate (sandbox-modes.ts)
    // runs in the route before this is consulted.
    return {
      mode: 'danger-full-access',
      prefix: [],
      reason: null,
      sandboxed: false,
      refused: false,
      refuseCode: null,
    };
  }
  const probe = await probeSandbox(config.bwrapBin);
  if (probe.available) {
    // V3R17 #6(k)(a2): the exclusion is computed here, once, so every
    // caller of decideExecSandbox — /api/exec, terminal, and the four
    // R17 routes — gets the vault shadowing for free. A caller that
    // builds a prefix directly must pass excludeDirs itself.
    const prefix =
      config.mode === 'read-only'
        ? buildReadOnlySandboxPrefix(cwd, { ...config, excludeDirs: sandboxExcludeDirs(cwd) })
        : buildExecSandboxPrefix(cwd, { ...config, excludeDirs: sandboxExcludeDirs(cwd) });
    return { mode: config.mode, prefix, reason: null, sandboxed: true, refused: false, refuseCode: null };
  }
  return {
    mode: config.mode,
    prefix: [],
    reason: probe.reason ?? 'bwrap probe failed',
    sandboxed: false,
    refused: true,
    refuseCode: 'SANDBOX_UNAVAILABLE',
  };
}

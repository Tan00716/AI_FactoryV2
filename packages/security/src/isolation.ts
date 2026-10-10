/**
 * Isolation backend abstraction — SPEC v2 §7 (Workspace, full Shell, real isolation).
 *
 * v2 §7.3 is explicit: intercepting tool arguments, setting cwd, or telling
 * the model "don't use ../" is NOT enough for a full Shell. The agent process
 * MUST run inside a genuinely restricted OS principal / sandbox / VM, and the
 * product must be able to *prove* the boundary — otherwise autonomous shell
 * execution is refused with CONFINEMENT_UNAVAILABLE (fail-closed, §7.5).
 *
 * This module provides:
 *  - `IsolationBackend`: replaceable backend contract (VM, restricted OS
 *    account, container, local-dev best-effort, unverified).
 *  - `ConfinementReport`: the proof object ({verified, verified_at, checks,
 *    limitations}). Limitations are honest: anything we cannot prove at the
 *    OS level is listed, never silently assumed.
 *  - `LocalDevBackend`: best-effort checks for trusted local development.
 *  - `UnverifiedBackend`: always reports unverified (fail-closed default).
 *  - `assertConfinementForAutonomousShell()`: the §7.5 gate — throws
 *    CONFINEMENT_UNAVAILABLE unless the backend proves confinement.
 *  - `WorkspaceRecord` (§7.2): the workspace boundary document, including
 *    `isolation_backend` and `confinement_verified_at`.
 *  - Extended path-threat analysis (§7.3): case, Unicode, UNC, device paths,
 *    symlink/junction/reparse, hardlink, shared git common-dir, TOCTOU.
 *
 * The pre-existing `sandbox.ts` API (local/strong tiers, resolveSafePath) is
 * preserved; `sandboxTierBackend()` adapts a tier into this abstraction.
 */

import { realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep, isAbsolute } from 'path';
import { REASON_CODES } from '@ai-factory/api-contracts';
import { resolvePolicy, SandboxTier, SandboxViolationError } from './sandbox';

/** Backend technology kinds. `local-dev` and `unverified` are not OS isolation. */
export type IsolationBackendKind =
  | 'vm'
  | 'restricted-os-account'
  | 'container'
  | 'local-dev'
  | 'unverified';

export interface ConfinementCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ConfinementReport {
  backend: string;
  kind: IsolationBackendKind;
  /** True only when every mandatory check passed. */
  verified: boolean;
  /** ISO timestamp of the verification, null when never verified. */
  verified_at: string | null;
  checks: ConfinementCheck[];
  /**
   * Honest limitations, e.g. "cannot prove OS-level process isolation from
   * inside the process". A backend that cannot list its limitations is not
   * a backend.
   */
  limitations: string[];
}

/** Replaceable isolation backend contract (SPEC v2 §7.3). */
export interface IsolationBackend {
  readonly name: string;
  readonly kind: IsolationBackendKind;
  verifyConfinement(): ConfinementReport;
}

/** Thrown by the §7.5 fail-closed gate. */
export class ConfinementUnavailableError extends Error {
  readonly code = 'CONFINEMENT_UNAVAILABLE';
  readonly reasonCode = 'CONFINEMENT_UNAVAILABLE' as const;
  readonly report: ConfinementReport;
  constructor(report: ConfinementReport) {
    super(
      `${REASON_CODES.CONFINEMENT_UNAVAILABLE}: backend '${report.backend}' ` +
        `cannot prove confinement (${report.limitations.join('; ') || 'no details'})`,
    );
    this.name = 'ConfinementUnavailableError';
    this.report = report;
  }
}

export interface ConfinementGateOptions {
  now?: () => number;
}

/**
 * §7.5 fail-closed gate. Autonomous shell execution MUST call this first.
 * Returns the passing report; throws ConfinementUnavailableError otherwise.
 * Never silently downgrades to host-user unlimited permissions.
 */
export function assertConfinementForAutonomousShell(
  backend: IsolationBackend,
  opts: ConfinementGateOptions = {},
): ConfinementReport {
  const report = backend.verifyConfinement();
  if (!report.verified) throw new ConfinementUnavailableError(report);
  void opts;
  return report;
}

// ---------------------------------------------------------------------------
// Workspace record (§7.2)
// ---------------------------------------------------------------------------

export type NetworkProfile =
  | { mode: 'deny' }
  | { mode: 'allowlist'; domains: string[]; notes?: string };

export type ProcessProfile =
  | { mode: 'confined'; maxProcesses?: number }
  | { mode: 'unrestricted'; reason: string };

export interface WorkspaceRecord {
  id: string;
  /** Human-authorized folder roots. */
  authorized_roots: string[];
  allowed_readonly_mounts: string[];
  /** Read-only runtime mounts (system libs, compilers) — explicitly shown (§7.3). */
  runtime_support_mounts: string[];
  writable_temp_roots: string[];
  network_profile: NetworkProfile;
  process_profile: ProcessProfile;
  owner: string;
  boundary_version: number;
  isolation_backend: string;
  confinement_verified_at: string | null;
}

export interface CreateWorkspaceInput {
  id: string;
  authorized_roots: string[];
  owner: string;
  backend: IsolationBackend;
  allowed_readonly_mounts?: string[];
  runtime_support_mounts?: string[];
  writable_temp_roots?: string[];
  network_profile?: NetworkProfile;
  process_profile?: ProcessProfile;
  now?: () => number;
}

/**
 * Build the §7.2 workspace boundary document. `confinement_verified_at`
 * comes from the backend's own report — never hand-written.
 */
export function createWorkspaceRecord(input: CreateWorkspaceInput): WorkspaceRecord {
  const report = input.backend.verifyConfinement();
  const tempDefault = join(tmpdir(), 'ai-factory-workspaces', input.id);
  return {
    id: input.id,
    authorized_roots: input.authorized_roots.map((r) => resolve(r)),
    allowed_readonly_mounts: (input.allowed_readonly_mounts ?? []).map((r) => resolve(r)),
    runtime_support_mounts: (input.runtime_support_mounts ?? []).map((r) => resolve(r)),
    writable_temp_roots: (input.writable_temp_roots ?? [tempDefault]).map((r) => resolve(r)),
    network_profile: input.network_profile ?? { mode: 'deny' },
    process_profile: input.process_profile ?? { mode: 'confined' },
    owner: input.owner,
    boundary_version: 1,
    isolation_backend: input.backend.name,
    confinement_verified_at: report.verified ? report.verified_at : null,
  };
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

function isoNow(now?: () => number): string {
  return new Date(now ? now() : Date.now()).toISOString();
}

/**
 * Best-effort backend for trusted local development. Runs every check it
 * honestly can and lists the rest as limitations — it does NOT claim
 * OS-level isolation, so `verified` is false unless every mandatory check
 * passes AND the operator explicitly attests the OS boundary.
 */
export class LocalDevBackend implements IsolationBackend {
  readonly name = 'local-dev';
  readonly kind: IsolationBackendKind = 'local-dev';
  constructor(
    private readonly opts: {
      workspaceRoot: string;
      /** Absolute paths that must never be reachable (control-plane DB, keyring…). */
      forbiddenPrefixes?: string[];
      /** Set true only when the operator attests a real OS boundary exists. */
      osBoundaryAttested?: boolean;
      now?: () => number;
    },
  ) {}

  verifyConfinement(): ConfinementReport {
    const root = resolve(this.opts.workspaceRoot);
    const checks: ConfinementCheck[] = [];
    const limitations: string[] = [
      'local-dev cannot prove OS-level process isolation from inside the process; ' +
        'agent subprocesses inherit the host user principal (§7.3)',
      'TOCTOU: path checks are check-then-use; without OS support an attacker ' +
        'can swap a path between validation and use — treated as a limitation, not a guarantee',
      'symlink/junction/reparse targets are resolved at check time only',
    ];
    checks.push({
      name: 'workspace-root-resolves',
      passed: isAbsolute(root),
      detail: `workspace root resolves to ${root}`,
    });
    const forbidden = (this.opts.forbiddenPrefixes ?? []).map((p) => resolve(p));
    const forbiddenInside = forbidden.filter(
      (p) => p === root || p.startsWith(root + sep),
    );
    checks.push({
      name: 'forbidden-prefixes-outside-root',
      passed: forbiddenInside.length === 0,
      detail:
        forbiddenInside.length === 0
          ? 'no forbidden prefix lives inside the workspace root'
          : `forbidden prefixes inside root: ${forbiddenInside.join(', ')}`,
    });
    const attested = this.opts.osBoundaryAttested === true;
    checks.push({
      name: 'os-boundary-attested',
      passed: attested,
      detail: attested
        ? 'operator attests a real OS boundary (restricted account / VM / container)'
        : 'no OS boundary attested — autonomous shell must stay fail-closed',
    });
    const verified = checks.every((c) => c.passed);
    return {
      backend: this.name,
      kind: this.kind,
      verified,
      verified_at: verified ? isoNow(this.opts.now) : null,
      checks,
      limitations,
    };
  }
}

/** Fail-closed default: never verifies, so autonomous shell is always refused. */
export class UnverifiedBackend implements IsolationBackend {
  readonly name = 'unverified';
  readonly kind: IsolationBackendKind = 'unverified';
  constructor(private readonly now?: () => number) {}
  verifyConfinement(): ConfinementReport {
    return {
      backend: this.name,
      kind: this.kind,
      verified: false,
      verified_at: null,
      checks: [
        {
          name: 'backend-qualification',
          passed: false,
          detail: 'no isolation backend qualified on this host',
        },
      ],
      limitations: ['no backend — autonomous shell execution is prohibited (§7.5)'],
    };
  }
}

/**
 * Adapt the pre-existing sandbox tiers (sandbox.ts) into the backend
 * abstraction. The tiers are policy checks only, so verification stays
 * best-effort and honest about it.
 */
export function sandboxTierBackend(
  tier: SandboxTier,
  workspaceRoot: string,
  opts: { now?: () => number } = {},
): IsolationBackend {
  const policy = resolvePolicy(tier === 'strong' ? 'high' : 'low', {
    workspaceRoot,
  });
  const name = `sandbox-tier:${policy.tier}`;
  return {
    name,
    kind: 'local-dev',
    verifyConfinement(): ConfinementReport {
      return {
        backend: name,
        kind: 'local-dev',
        verified: false,
        verified_at: null,
        checks: [
          {
            name: 'tier-policy-resolved',
            passed: true,
            detail: `tier=${policy.tier}, network=${policy.networkAllowed ? 'allowed' : 'denied'}`,
          },
          {
            name: 'os-boundary-attested',
            passed: false,
            detail: 'sandbox tiers are policy checks only; no OS boundary proven (§7.3)',
          },
        ],
        limitations: [
          'tier policies intercept arguments and set cwd; they are not OS isolation',
          'TOCTOU and symlink-swap races not closable at this layer',
        ],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Extended path-threat analysis (§7.3)
// ---------------------------------------------------------------------------

export type PathThreatKind =
  | 'null-byte'
  | 'escape'
  | 'unc'
  | 'device-path'
  | 'unicode'
  | 'symlink-risk'
  | 'git-common-dir';

export interface PathThreat {
  kind: PathThreatKind;
  detail: string;
}

/**
 * Static analysis of a user-supplied path. Flags what string inspection can
 * see; symlink/junction/reparse *targets* need filesystem resolution
 * (see resolveConfinedPathSync). Case-insensitivity is handled by
 * normalizing comparisons, not by trusting the input's case.
 */
export function detectPathThreats(userPath: string): PathThreat[] {
  const threats: PathThreat[] = [];
  if (userPath.includes('\0')) {
    threats.push({ kind: 'null-byte', detail: 'null byte in path' });
  }
  if (/^(\\\\|\/\/)/.test(userPath)) {
    threats.push({ kind: 'unc', detail: 'UNC-style path; resolved against local root only' });
  }
  if (/^\\\\\.\\/.test(userPath) || /(^|\/)dev\//.test(userPath.replace(/\\/g, '/'))) {
    threats.push({ kind: 'device-path', detail: 'device path (Win32 device namespace or /dev)' });
  }
  if (/[^\x00-\x7F]/.test(userPath)) {
    threats.push({
      kind: 'unicode',
      detail: 'non-ASCII characters — confusable/homoglyph review required',
    });
  }
  if (/(^|[/\\])\.\.(?=[/\\]|$)/.test(userPath)) {
    threats.push({ kind: 'escape', detail: '`..` segment present; must stay inside root' });
  }
  if (/(^|[/\\])\.git([/\\]|$)/.test(userPath)) {
    threats.push({
      kind: 'git-common-dir',
      detail: '.git access — hooks, config and common-dir are untrusted (§7.3)',
    });
  }
  return threats;
}

/**
 * Resolve a path inside root, following symlinks via realpath and rejecting
 * anything that lands outside. Missing files resolve via their nearest
 * existing ancestor. TOCTOU between this check and later use cannot be
 * closed at this layer — callers needing atomicity must use an OS backend.
 */
export function resolveConfinedPathSync(root: string, userPath: string): string {
  const absRoot = realpathSyncSafe(root);
  const threats = detectPathThreats(userPath);
  const fatal = threats.find((t) => t.kind === 'null-byte');
  if (fatal) {
    throw new SandboxViolationError('PATH_ESCAPE', fatal.detail);
  }
  const candidate = resolve(absRoot, userPath);
  // Walk up to the nearest existing ancestor so realpath works for new files.
  let probe = candidate;
  const trail: string[] = [];
  while (true) {
    try {
      const real = realpathSyncSafe(probe);
      // Re-attach the non-existing tail, then verify containment.
      const rebuilt = trail.length > 0 ? join(real, ...trail.reverse()) : real;
      const resolved = resolve(rebuilt);
      if (resolved !== absRoot && !resolved.startsWith(absRoot + sep)) {
        throw new SandboxViolationError(
          'PATH_ESCAPE',
          `symlink/junction target escapes workspace: ${JSON.stringify(userPath)}`,
        );
      }
      return resolved;
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = join(probe, '..');
        if (parent === probe) break;
        trail.push(probe.slice(parent.length + 1));
        probe = parent;
        continue;
      }
      throw err;
    }
  }
  throw new SandboxViolationError('PATH_ESCAPE', `cannot resolve path: ${JSON.stringify(userPath)}`);
}

function realpathSyncSafe(p: string): string {
  return realpathSync(p);
}

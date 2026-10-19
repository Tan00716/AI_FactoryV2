/**
 * OS-enforced sandbox modes (Codex-CLI-style sandbox_mode, adapted).
 *
 * Three tiers — enforced by the OPERATING SYSTEM (bubblewrap user
 * namespaces), never by prompt text:
 *
 *   read-only          — the whole workspace is bound READ-ONLY; the
 *                        only writable path is a tmpfs /tmp (HOME=/tmp).
 *                        Non-mutating commands work; any write outside
 *                        /tmp is refused by the kernel, not by policy.
 *                        Network follows the offline switch: shared when
 *                        online, --unshare-net when offline.
 *   workspace-write    — the existing exec-sandbox behavior: exactly one
 *                        writable bind (the request cwd at its real
 *                        path), everything else read-only or absent.
 *                        Network shared by default, --unshare-net when
 *                        offline mode is on (or FACTORY_EXEC_SANDBOX_NETWORK=0).
 *   danger-full-access — NO sandbox at all: the command runs directly
 *                        on the host. Intended for disposable CI
 *                        containers. Requires BOTH:
 *                          (1) the project config `.ai-factory/sandbox.json`
 *                              explicitly sets `"allowDanger": true`, AND
 *                          (2) a per-run approval through ApprovalManager
 *                              (action 'sandbox.danger-exec', CRITICAL),
 *                              bound to the exact command via
 *                              candidate_digest = sha256(command).
 *                        approval_policy 'never' refuses danger outright.
 *
 * Config resolution (first hit wins):
 *   1. project `.ai-factory/sandbox.json` — searched upward from the
 *      request cwd (max 8 levels); committable, per-project.
 *   2. env FACTORY_SANDBOX_MODE (and FACTORY_SANDBOX_APPROVAL_POLICY).
 *   3. the persisted store (<data>/sandbox-mode.json), default
 *      workspace-write / on-request — settable via POST /api/sandbox/mode.
 *
 * Honest boundaries (fail-closed, no fake isolation):
 *
 *   - read-only and workspace-write REQUIRE a working bwrap. When the
 *     probe fails (non-Linux, bwrap missing, user namespaces disabled)
 *     the call is REFUSED with SANDBOX_UNAVAILABLE — it is never run
 *     unisolated and called "sandboxed". This replaces the old
 *     'none (fallback)' behavior: there is no silent or marked
 *     fallback anymore, only refusal.
 *   - danger-full-access runs directly by DESIGN (that is the point of
 *     the tier); the audit/response field says 'danger-full-access'
 *     explicitly — never 'bwrap', never a fake claim.
 *   - Only Linux + a working bwrap gives real OS enforcement. The
 *     decision function reports which tier actually applied; callers
 *     MUST surface it in audit records and responses.
 *   - allowDanger lives ONLY in the project config file — it cannot be
 *     granted via env var or the mode API, so a compromised env cannot
 *     silently enable it.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ApprovalManager } from '@ai-factory/approvals';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'on-request' | 'never';

export const SANDBOX_MODES: readonly SandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['on-request', 'never'];

/** Env override for the mode (resolution step 2). */
export const SANDBOX_MODE_ENV = 'FACTORY_SANDBOX_MODE';
/** Env override for the danger approval policy (resolution step 2). */
export const SANDBOX_APPROVAL_POLICY_ENV = 'FACTORY_SANDBOX_APPROVAL_POLICY';
/** Persisted-store file env override (tests). */
export const SANDBOX_MODE_FILE_ENV = 'AI_FACTORY_SANDBOX_MODE_FILE';
export const SANDBOX_DATA_DIR_ENV = 'AI_FACTORY_DATA_DIR';

/** Machine-readable codes for sandbox-mode refusals. */
export const SANDBOX_UNAVAILABLE_CODE = 'SANDBOX_UNAVAILABLE';
export const DANGER_NOT_CONFIGURED_CODE = 'DANGER_NOT_CONFIGURED';
export const DANGER_APPROVAL_REQUIRED_CODE = 'DANGER_APPROVAL_REQUIRED';
export const DANGER_APPROVAL_INVALID_CODE = 'DANGER_APPROVAL_INVALID';
export const DANGER_APPROVAL_NEVER_CODE = 'DANGER_APPROVAL_NEVER';
export const SANDBOX_MODE_ESCALATION_CODE = 'SANDBOX_MODE_ESCALATION';

/** The ApprovalManager action for danger-tier runs. */
export const DANGER_EXEC_ACTION = 'sandbox.danger-exec';

/** Strictness order: lower = stricter. A per-request hint may only tighten. */
const STRICTNESS: Record<SandboxMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
};

export function sandboxModeStrictness(mode: SandboxMode): number {
  return STRICTNESS[mode];
}

export function isSandboxMode(v: unknown): v is SandboxMode {
  return typeof v === 'string' && (SANDBOX_MODES as readonly string[]).includes(v);
}

export function isApprovalPolicy(v: unknown): v is ApprovalPolicy {
  return typeof v === 'string' && (APPROVAL_POLICIES as readonly string[]).includes(v);
}

/** sha256 hex (16 chars) binding an approval ticket to one exact command. */
export function dangerCommandDigest(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex').slice(0, 16);
}

export interface ProjectSandboxConfig {
  mode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  allowDanger?: boolean;
}

function defaultFile(): string {
  const fromEnv = process.env[SANDBOX_MODE_FILE_ENV];
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env[SANDBOX_DATA_DIR_ENV] ?? 'data';
  return resolve(dataDir, 'sandbox-mode.json');
}

export interface SandboxModeState {
  mode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  updatedAt: string;
  updatedBy: string;
}

const DEFAULT_STATE: SandboxModeState = {
  mode: 'workspace-write',
  approvalPolicy: 'on-request',
  updatedAt: new Date(0).toISOString(),
  updatedBy: 'default',
};

/**
 * Read `.ai-factory/sandbox.json` searching upward from cwd (max 8
 * levels). Missing file → {}. Unparsable or invalid fields → ignored
 * (documented: fail-safe defaults are workspace-write / on-request /
 * allowDanger=false; a broken config can never widen access).
 */
export function readProjectSandboxConfig(cwd: string): ProjectSandboxConfig {
  let dir = resolve(cwd);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, '.ai-factory', 'sandbox.json');
    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: ProjectSandboxConfig = {};
      if (isSandboxMode(parsed['mode'])) out.mode = parsed['mode'];
      if (isApprovalPolicy(parsed['approvalPolicy'])) out.approvalPolicy = parsed['approvalPolicy'];
      if (parsed['allowDanger'] === true) out.allowDanger = true;
      return out;
    } catch {
      // missing or unreadable — walk up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

export class SandboxModeStore {
  private readonly file: string;
  private state: SandboxModeState;

  constructor(file?: string) {
    this.file = file ?? defaultFile();
    this.state = this.load();
  }

  private load(): SandboxModeState {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SandboxModeState>;
      return {
        mode: isSandboxMode(parsed.mode) ? parsed.mode : DEFAULT_STATE.mode,
        approvalPolicy: isApprovalPolicy(parsed.approvalPolicy)
          ? parsed.approvalPolicy
          : DEFAULT_STATE.approvalPolicy,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : DEFAULT_STATE.updatedAt,
        updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : 'unknown',
      };
    } catch {
      // Missing or corrupt → the long-standing default. Corrupt can
      // never widen access (workspace-write still needs bwrap).
      return { ...DEFAULT_STATE };
    }
  }

  get(): SandboxModeState {
    return { ...this.state };
  }

  set(mode: SandboxMode, approvalPolicy: ApprovalPolicy, actor: string): SandboxModeState {
    const next: SandboxModeState = {
      mode,
      approvalPolicy,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tmp, this.file);
    this.state = next;
    return this.get();
  }
}

/** Module singleton for the production server (lazy — created on first use). */
let singleton: SandboxModeStore | null = null;

export function sandboxModeStore(): SandboxModeStore {
  if (!singleton) singleton = new SandboxModeStore();
  return singleton;
}

/** Re-exported for tests: drop the singleton so the next call re-reads. */
export function resetSandboxModeStoreForTests(): void {
  singleton = null;
}

export interface ResolvedSandboxMode {
  mode: SandboxMode;
  /** Where the mode came from: project config, env, or the persisted store. */
  source: 'project' | 'env' | 'store';
  approvalPolicy: ApprovalPolicy;
  /** Only ever true via the project config file — never env, never the API. */
  allowDanger: boolean;
}

/**
 * Resolve the effective sandbox mode for a request cwd:
 * project config → env → persisted store.
 */
export function resolveSandboxMode(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSandboxMode {
  const project = readProjectSandboxConfig(cwd);
  const envMode = (env[SANDBOX_MODE_ENV] ?? '').trim();
  const envPolicy = (env[SANDBOX_APPROVAL_POLICY_ENV] ?? '').trim();
  const stored = sandboxModeStore().get();
  const approvalPolicy: ApprovalPolicy = isApprovalPolicy(project.approvalPolicy)
    ? project.approvalPolicy
    : isApprovalPolicy(envPolicy)
      ? envPolicy
      : stored.approvalPolicy;
  if (isSandboxMode(project.mode)) {
    return { mode: project.mode, source: 'project', approvalPolicy, allowDanger: project.allowDanger === true };
  }
  if (isSandboxMode(envMode)) {
    return { mode: envMode, source: 'env', approvalPolicy, allowDanger: false };
  }
  return { mode: stored.mode, source: 'store', approvalPolicy, allowDanger: false };
}

// ------------------------------------------------------------------
// Danger-tier approval gate
// ------------------------------------------------------------------

export interface DangerGateSuccess {
  ok: true;
  approvalId: string;
}
export interface DangerGateFailure {
  ok: false;
  code: string;
  message: string;
  /** Set when the server minted a fresh PENDING approval for the human. */
  approvalId?: string;
  /**
   * sha256(command)[:16] — always set on DANGER_APPROVAL_REQUIRED so a
   * human can mint the ticket manually (POST /api/approvals with
   * action 'sandbox.danger-exec' + this candidate_digest + a real
   * task_id) when the server could not auto-mint (no task to bind to:
   * approvals.task_id has a FOREIGN KEY to tasks(id), so a ticket can
   * never be unbound — minting without a task would 500).
   */
  candidateDigest?: string;
}
export type DangerGateResult = DangerGateSuccess | DangerGateFailure;

/**
 * One-shot-consumed danger approvals. In-memory: a restart clears the
 * set, but every consumption is also audit-logged (DANGER_EXEC_CONSUMED)
 * so reuse across a restart is visible, and approvals carry short
 * deadlines by default (24h) bounding the window.
 */
const consumedDangerApprovals = new Set<string>();

/** Re-exported for tests. */
export function resetDangerConsumedForTests(): void {
  consumedDangerApprovals.clear();
}

function approvalExpired(deadline: string | null): boolean {
  return deadline !== null && Date.now() >= new Date(deadline).getTime();
}

/**
 * Validate an already-approved danger ticket for this exact command.
 * Pure check — no minting. Used by surfaces (tool-runner) where the
 * human mints the ticket themselves via /api/approvals.
 */
export function validateDangerApproval(
  manager: ApprovalManager,
  approvalId: string,
  command: string,
): DangerGateResult {
  let approval;
  try {
    approval = manager.get(approvalId);
  } catch {
    return {
      ok: false,
      code: DANGER_APPROVAL_INVALID_CODE,
      message: `danger approval '${approvalId}' not found`,
    };
  }
  if (approval.status !== 'APPROVED') {
    return {
      ok: false,
      code: DANGER_APPROVAL_INVALID_CODE,
      message: `danger approval '${approvalId}' is ${approval.status}, not APPROVED`,
    };
  }
  if (approvalExpired(approval.deadline)) {
    return {
      ok: false,
      code: DANGER_APPROVAL_INVALID_CODE,
      message: `danger approval '${approvalId}' is expired`,
    };
  }
  if (approval.action !== DANGER_EXEC_ACTION || approval.candidate_digest !== dangerCommandDigest(command)) {
    return {
      ok: false,
      code: DANGER_APPROVAL_INVALID_CODE,
      message: `danger approval '${approvalId}' is not bound to this command`,
    };
  }
  if (consumedDangerApprovals.has(approvalId)) {
    return {
      ok: false,
      code: DANGER_APPROVAL_INVALID_CODE,
      message: `danger approval '${approvalId}' was already consumed (one-shot)`,
    };
  }
  consumedDangerApprovals.add(approvalId);
  return { ok: true, approvalId };
}

/**
 * The full danger gate for human-driven surfaces (/api/exec, terminal
 * sessions): config check → policy check → approval check.
 *
 * Minting: when no dangerApprovalId is supplied the gate mints a fresh
 * PENDING ticket (action sandbox.danger-exec, CRITICAL, bound to the
 * command via candidate_digest) so the human sees it in the Approvals
 * tab — but ONLY when the caller supplies a taskId to bind it to.
 * approvals.task_id is NOT NULL REFERENCES tasks(id): a ticket can
 * never be unbound, and minting without a task would die with
 * FOREIGN KEY constraint failed. When no taskId is available the gate
 * returns DANGER_APPROVAL_REQUIRED with the candidateDigest and manual
 * minting instructions instead of a fake/unsavable ticket.
 */
export function checkDangerExec(opts: {
  manager: ApprovalManager;
  actor: string;
  command: string;
  allowDanger: boolean;
  approvalPolicy: ApprovalPolicy;
  dangerApprovalId?: string;
  /** Task to bind a freshly minted ticket to (required for minting). */
  taskId?: string;
}): DangerGateResult {
  const { manager, actor, command, allowDanger, approvalPolicy, dangerApprovalId, taskId } = opts;
  if (!allowDanger) {
    return {
      ok: false,
      code: DANGER_NOT_CONFIGURED_CODE,
      message:
        'danger-full-access is not enabled for this project: ' +
        '.ai-factory/sandbox.json must explicitly set "allowDanger": true',
    };
  }
  if (approvalPolicy === 'never') {
    return {
      ok: false,
      code: DANGER_APPROVAL_NEVER_CODE,
      message: 'danger-full-access runs are refused by approval_policy=never',
    };
  }
  if (typeof dangerApprovalId === 'string' && dangerApprovalId) {
    return validateDangerApproval(manager, dangerApprovalId, command);
  }
  const digest = dangerCommandDigest(command);
  if (!taskId) {
    // Cannot mint: no task to bind the ticket to (FK). Hand the human
    // everything needed to mint it themselves via POST /api/approvals.
    return {
      ok: false,
      code: DANGER_APPROVAL_REQUIRED_CODE,
      message:
        `danger-full-access requires a per-run human approval, and this ` +
        `call carries no task to bind the ticket to — mint it manually: ` +
        `POST /api/approvals {action:'sandbox.danger-exec', task_id:'<a real task id>', ` +
        `candidate_digest:'${digest}', risk_level:'CRITICAL', requester:'<you>'} ` +
        `then retry with dangerApprovalId`,
      candidateDigest: digest,
    };
  }
  // Mint a PENDING ticket for the human. evaluateAction() maps the
  // unknown action to AUTO → CRITICAL escalates to HUMAN_APPROVAL
  // (never BLOCKED), so request() succeeds.
  const approval = manager.request({
    action: DANGER_EXEC_ACTION,
    requester: actor || 'human',
    task_id: taskId,
    risk_level: 'CRITICAL',
    candidate_digest: digest,
    environment: `danger-full-access exec: ${command.slice(0, 120)}`,
  });
  return {
    ok: false,
    code: DANGER_APPROVAL_REQUIRED_CODE,
    message:
      `danger-full-access requires a per-run human approval: ` +
      `approval '${approval.approval_id}' is PENDING — approve it in the ` +
      `Approvals tab (or POST /api/approvals/${approval.approval_id}/decision) ` +
      `then retry with dangerApprovalId`,
    approvalId: approval.approval_id,
    candidateDigest: digest,
  };
}

/**
 * @ai-factory/evaluation — automatic governance (spec §45.4 / INV-28).
 *
 * §45.4 allows Policy to AUTOMATICALLY:
 *   1. lower autonomy (Policy 自动降低自主权),
 *   2. disable defective versions (禁用缺陷版本),
 *   3. switch to an approved fallback (切换已批准 Fallback);
 * and FORBIDS automatic privilege escalation on high scores:
 *   "不得自动因评分高就获取 Prod Admin 或移除 Human 决策".
 *
 * Design:
 *  - `evaluateAutoGovernance` is a PURE policy function: evaluation results
 *    and observations in, governance decisions out. It never grants
 *    privileges and never removes Human decisions — the decision type has
 *    no such variants, and high scores produce NO decisions at all.
 *  - `VersionRegistry` tracks version status (ACTIVE / DISABLED), the
 *    POLICY_APPROVAL-approved flag (fallback eligibility), and the effect
 *    record retained when a version is disabled (§45.4: "回退保留效果记录").
 *  - Execution is the caller's job (ImprovementLoop.autoGovern, server
 *    routes): the function only decides. The autonomy-layer enforcement of
 *    `downgrade-autonomy` lives outside this package (zero-deps convention);
 *    the decision is recorded on the case's admission trail.
 *
 * Deterministic thresholds (documented, tested):
 *  - disable-version:      ≥1 failing observation, or independent eval failed.
 *  - downgrade-autonomy:   ≥2 CONSECUTIVE failing observations (tail), or
 *                          independent eval failed.
 *  - switch-to-fallback:   the version is disabled (this pass or already)
 *                          AND an approved, non-disabled fallback exists
 *                          AND the case is not already on a fallback.
 * Idempotency: an already-disabled version is never disabled twice; an
 * already-downgraded scope is never downgraded twice; a case already on a
 * fallback is never switched again.
 */

export type AutoGovernanceAction =
  | 'downgrade-autonomy'
  | 'disable-version'
  | 'switch-to-fallback';

/** One canary observation, reduced to what governance may decide on. */
export interface AutoGovernanceObservation {
  at: number;
  success: boolean;
}

export interface AutoGovernanceInput {
  /** The version under limited activation. */
  version: string;
  /** Canary scope employees the version was activated for. */
  scopeEmployees: string[];
  /** Observations from LIMITED_ACTIVATION / OBSERVE (oldest first). */
  observations: AutoGovernanceObservation[];
  /** Independent regression/security evaluation outcome, if run. */
  independentEval?: { passed: boolean };
  /** Approved (POLICY_APPROVAL) and not disabled, preference order. */
  approvedFallbacks: string[];
  /** Versions already disabled (defective). */
  disabledVersions: readonly string[];
  /** True when this scope already had an auto downgrade applied. */
  autonomyAlreadyDowngraded?: boolean;
  /** True when the case is already running on a fallback version. */
  alreadyOnFallback?: boolean;
}

export interface AutoGovernanceDecision {
  action: AutoGovernanceAction;
  /** The version the decision is about. */
  version: string;
  /** For switch-to-fallback: the approved fallback to switch to. */
  targetVersion?: string;
  /** Employees affected (downgrade-autonomy). */
  scopeEmployees: string[];
  /** Human-readable, deterministic; never carries secret values. */
  reason: string;
  at: number;
}

function consecutiveFailures(observations: AutoGovernanceObservation[]): number {
  let n = 0;
  for (let i = observations.length - 1; i >= 0; i--) {
    if (!observations[i].success) n++;
    else break;
  }
  return n;
}

/**
 * Pure policy function: evaluation results in, governance decisions out.
 * Never emits privilege grants or human-decision removals — no such
 * decision variant exists, and excellent results yield zero decisions.
 */
export function evaluateAutoGovernance(
  input: AutoGovernanceInput,
  clock: { now(): number } = Date,
): AutoGovernanceDecision[] {
  const at = clock.now();
  const decisions: AutoGovernanceDecision[] = [];
  const failCount = input.observations.filter((o) => !o.success).length;
  const consec = consecutiveFailures(input.observations);
  const independentFailed = input.independentEval?.passed === false;
  const alreadyDisabled = input.disabledVersions.includes(input.version);

  // 1. 禁用缺陷版本 — any failure in the canary scope, or a failed
  //    independent evaluation, marks the version defective.
  if (!alreadyDisabled && (failCount >= 1 || independentFailed)) {
    decisions.push({
      action: 'disable-version',
      version: input.version,
      scopeEmployees: [...input.scopeEmployees],
      reason:
        `version ${input.version} defective: ${failCount} failing observation(s)` +
        (independentFailed ? ', independent evaluation FAILED' : ''),
      at,
    });
  }

  // 2. 切换已批准 Fallback — only to an APPROVED, non-disabled fallback,
  //    only when this version is (being) disabled, never blindly.
  const willBeDisabled = alreadyDisabled || decisions.some((d) => d.action === 'disable-version');
  if (willBeDisabled && !input.alreadyOnFallback && input.approvedFallbacks.length > 0) {
    decisions.push({
      action: 'switch-to-fallback',
      version: input.version,
      targetVersion: input.approvedFallbacks[0],
      scopeEmployees: [...input.scopeEmployees],
      reason:
        `version ${input.version} disabled — switching to approved fallback ` +
        `${input.approvedFallbacks[0]}`,
      at,
    });
  }

  // 3. Policy 自动降低自主权 — repeated failure pattern only. Never on
  //    high scores: excellent results never reach this function with
  //    failures, and the decision type cannot express privilege grants.
  if (!input.autonomyAlreadyDowngraded && (consec >= 2 || independentFailed)) {
    decisions.push({
      action: 'downgrade-autonomy',
      version: input.version,
      scopeEmployees: [...input.scopeEmployees],
      reason:
        `repeated failures for version ${input.version} ` +
        `(${consec} consecutive failing observation(s)` +
        (independentFailed ? ', independent evaluation FAILED' : '') +
        ') — autonomy downgraded for scope',
      at,
    });
  }

  return decisions;
}

/* ------------------------------------------------------------------ */
/* Version registry: status, approval flag, disable effect records     */
/* ------------------------------------------------------------------ */

export type VersionStatus = 'ACTIVE' | 'DISABLED';

export interface VersionRecord {
  version: string;
  status: VersionStatus;
  /** True once the version passed POLICY_APPROVAL (fallback-eligible). */
  approved: boolean;
  disabledAt?: number;
  disabledBy?: string;
  disableReason?: string;
  /** Effect record retained on disable (§45.4: 回退保留效果记录). */
  effectRecord?: string;
}

export class VersionRegistryError extends Error {
  readonly code = 'VERSION_REGISTRY_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'VersionRegistryError';
  }
}

export class VersionRegistry {
  private readonly versions = new Map<string, VersionRecord>();
  private readonly nowFn: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.nowFn = opts.now ?? Date.now;
  }

  /** Register a version as ACTIVE (idempotent). */
  register(version: string): VersionRecord {
    const existing = this.versions.get(version);
    if (existing) return { ...existing };
    const rec: VersionRecord = { version, status: 'ACTIVE', approved: false };
    this.versions.set(version, rec);
    return { ...rec };
  }

  /** Mark a version POLICY_APPROVAL-approved (fallback-eligible). Idempotent. */
  approve(version: string): VersionRecord {
    const rec = this.register(version);
    rec.approved = true;
    this.versions.set(version, rec);
    return { ...rec };
  }

  /**
   * Disable a defective version. Keeps the effect record. Idempotent:
   * disabling an already-disabled version is a no-op returning the
   * existing record (no double bookkeeping).
   */
  disable(
    version: string,
    opts: { by: string; reason: string; effectRecord?: string },
  ): VersionRecord {
    const rec = this.register(version);
    if (rec.status === 'DISABLED') return { ...rec };
    rec.status = 'DISABLED';
    rec.disabledAt = this.nowFn();
    rec.disabledBy = opts.by;
    rec.disableReason = opts.reason;
    if (opts.effectRecord !== undefined) rec.effectRecord = opts.effectRecord;
    this.versions.set(version, rec);
    return { ...rec };
  }

  isDisabled(version: string): boolean {
    return this.versions.get(version)?.status === 'DISABLED';
  }

  isApproved(version: string): boolean {
    return this.versions.get(version)?.approved === true;
  }

  record(version: string): VersionRecord | undefined {
    const rec = this.versions.get(version);
    return rec ? { ...rec } : undefined;
  }

  all(): VersionRecord[] {
    return [...this.versions.values()].map((r) => ({ ...r }));
  }
}

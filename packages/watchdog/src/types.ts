/**
 * Watchdog types — SPEC v2 §30.
 *
 * Health is tracked separately from Run State: waiting on a human approval
 * is WAITING, not a stall. Engineering defaults: heartbeat every 5s, three
 * consecutive misses → SUSPECTED_STALL, 60s missing and unreconnectable →
 * STALLED. Thresholds are configurable per tool/host and versioned.
 */

/** SPEC v2 §30 — health categories (distinct from run states). */
export type Health =
  | 'HEALTHY'
  | 'IDLE'
  | 'WAITING'
  | 'BLOCKED'
  | 'SUSPECTED_STALL'
  | 'STALLED'
  | 'FAILED'
  | 'RECOVERING';

export const HEALTH_VALUES: readonly Health[] = [
  'HEALTHY',
  'IDLE',
  'WAITING',
  'BLOCKED',
  'SUSPECTED_STALL',
  'STALLED',
  'FAILED',
  'RECOVERING',
];

/** Heartbeat / stall thresholds. */
export interface HeartbeatConfig {
  /** Expected heartbeat interval. Default 5_000 (§30). */
  intervalMs: number;
  /** Consecutive misses before SUSPECTED_STALL. Default 3 (§30). */
  missLimit: number;
  /** Silence duration before STALLED (when unreconnectable). Default 60_000. */
  stallAfterMs: number;
  /** Which config version produced these numbers (recorded, §30). */
  version: string;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  intervalMs: 5_000,
  missLimit: 3,
  stallAfterMs: 60_000,
  version: 'watchdog-defaults@1',
};

/** Per-tool or per-host threshold override. */
export interface ThresholdOverride {
  /** e.g. "tool:pytest" or "host:gpu-b". */
  scope: string;
  config: HeartbeatConfig;
}

/**
 * §30 — diagnose BEFORE recovering. A waiting approval and a dead worker
 * look different and get different responses.
 */
export type DiagnosisKind =
  | 'worker-lost'
  | 'tool-hung'
  | 'provider-stalled'
  | 'quota-or-auth'
  | 'lock-or-dependency-wait'
  | 'approval-wait'
  | 'loop-stagnation'
  | 'healthy-activity';

/** Signals the watchdog may consider when diagnosing. */
export interface WorkerSignals {
  lastToolActivityAt?: number;
  lastModelStreamAt?: number;
  providerReachable?: boolean;
  quotaOrAuthBlocked?: boolean;
  lockWait?: boolean;
  approvalWait?: boolean;
  loopStagnated?: boolean;
  /** Worker is legitimately idle/waiting — heartbeats may be sparse. */
  explicitState?: 'IDLE' | 'WAITING' | 'BLOCKED' | 'RECOVERING';
}

export interface WorkerStatus {
  workerId: string;
  health: Health;
  consecutiveMisses: number;
  lastHeartbeatAt: number | null;
  diagnosis: DiagnosisKind;
  detail: string;
}

export class WatchdogError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PolicyDeniedRecovery extends WatchdogError {
  constructor(action: string) {
    super('POLICY_DENIED_RECOVERY', `Watchdog recovery action '${action}' denied by policy`);
  }
}

export class CircuitOpen extends WatchdogError {
  constructor(workerId: string) {
    super('CIRCUIT_OPEN', `Recovery circuit open for ${workerId}: too many restarts — manual triage required`);
  }
}

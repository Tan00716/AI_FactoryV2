/**
 * Factory control plane types — SPEC v2 §24.
 *
 * Three INDEPENDENT axes (§24.1): control_state, health_state, capacity_state
 * are stored separately and never merged into one mutually-exclusive enum.
 */

/** §24.1 control axis. */
export type ControlState =
  | 'STOPPED'
  | 'STARTING'
  | 'RUNNING'
  | 'PAUSING'
  | 'PAUSED'
  | 'FREEZING'
  | 'FROZEN'
  | 'DRAINING'
  | 'STOPPING'
  | 'EMERGENCY_STOPPED';

/** §24.1 health axis. */
export type HealthState = 'HEALTHY' | 'DEGRADED' | 'RECOVERING';

/** §24.1 capacity axis. */
export type CapacityState = 'AVAILABLE' | 'QUOTA_LIMITED' | 'RESOURCE_LIMITED';

export type ControlOperation =
  | 'START'
  | 'PAUSE_NEW_WORK'
  | 'PAUSE_AI_WORK'
  | 'FREEZE'
  | 'RESUME'
  | 'DRAIN'
  | 'GRACEFUL_STOP'
  | 'EMERGENCY_STOP';

export interface ControlRequest {
  /** Monotonic epoch, assigned by the controller (callers must not invent one). */
  control_epoch?: number;
  requested_by: string;
  scope: string;
  /** PAUSE_NEW_WORK is the default pause button; PAUSE_AI_WORK is the deep one. */
  mode?: string;
  deadline?: string;
}

/**
 * Worker acknowledgement (§24.3): where the worker stopped, what tools were
 * active, which processes are still alive. The controller only displays a
 * terminal state after every expected ACK arrived.
 */
export interface WorkerAck {
  worker_id: string;
  control_epoch: number;
  /** Checkpoint / safe point the worker stopped at. */
  stopped_at: string;
  active_tools: string[];
  live_processes: number[];
  acked_at: string;
}

export interface FactoryStatus {
  control: ControlState;
  health: HealthState;
  capacity: CapacityState;
  control_epoch: number;
  pending_acks: string[];
  /**
   * UI display string. While ACKs are outstanding this MUST read as pending
   * (e.g. "PAUSED (pending — 2 worker ACKs outstanding)") — never a fake
   * terminal state (§24.3).
   */
  display: string;
  updated_at: string;
}

/** §24.2 operation semantics matrix. */
export interface OperationSemantics {
  target: ControlState;
  newWork: string;
  runningTools: string;
  monitoring: string;
}

export const OPERATION_SEMANTICS: Record<ControlOperation, OperationSemantics> = {
  START: {
    target: 'RUNNING',
    newWork: 'open after health/boundary/policy/quota checks',
    runningTools: 'coordinate pre-existing activity, then take over',
    monitoring: 'start and verify',
  },
  PAUSE_NEW_WORK: {
    target: 'PAUSED',
    newWork: 'no new dev tasks; already-running approved runs may continue',
    runningTools: 'legitimate actions continue',
    monitoring: 'continues',
  },
  PAUSE_AI_WORK: {
    target: 'PAUSED',
    newWork: 'dev model decisions stop at safe points; no new dev tool calls',
    runningTools: 'already-started, still-authorized deterministic actions may finish',
    monitoring: 'pre-authorized safety actions continue',
  },
  FREEZE: {
    target: 'FROZEN',
    newWork: 'dev writer leases revoked; model + dev side effects suspended',
    runningTools: 'freezable local process trees suspended; unfreezable external actions coordinated to safe points',
    monitoring: 'safety domain continues by default; UI shows exceptions',
  },
  RESUME: {
    target: 'RUNNING',
    newWork: 'open after coordination + version/lease/permission checks',
    runningTools: 'only the currently legitimate owner resumes',
    monitoring: 'keeps running',
  },
  DRAIN: {
    target: 'DRAINING',
    newWork: 'new tasks refused; admitted tasks may reason to the configured completion boundary',
    runningTools: 'legitimate actions continue',
    monitoring: 'continues',
  },
  GRACEFUL_STOP: {
    target: 'STOPPED',
    newWork: 'no new dev steps; workers end after checkpoint',
    runningTools: 'finish or cancel safely; STOPPED only after confirmed end',
    monitoring: 'may stay via resident service; explicit warning if the service itself stops',
  },
  EMERGENCY_STOP: {
    target: 'EMERGENCY_STOPPED',
    newWork: 'execution permissions revoked immediately; tool ingress closed',
    runningTools: 'factory-managed dev/dangerous process trees force-terminated; external actions → UNKNOWN + coordinated',
    monitoring: 'isolated read-only monitoring/audit kept where possible; only unaffected pre-authorized recovery allowed',
  },
};

/** What Emergency Stop MUST NOT do (§24.3) — enforced by construction. */
export const EMERGENCY_STOP_PROHIBITIONS = [
  'does not shut down the system',
  'does not delete workspaces',
  'does not stop customer production services',
  'does not retry UNKNOWN side effects on resume',
] as const;

export class ControlError extends Error {
  readonly code = 'CONTROL_ERROR' as const;
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

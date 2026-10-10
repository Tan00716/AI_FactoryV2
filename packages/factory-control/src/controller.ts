/**
 * Factory controller — SPEC v2 §24.
 *
 * - Three independent state axes (§24.1).
 * - Every control request bumps control_epoch; ACKs bind to the epoch.
 * - Terminal states are DISPLAYED only after all expected ACKs arrive
 *   (§24.3) — the UI can never show "PAUSED" from a bare button click.
 * - Emergency Stop revokes execution and terminates factory-managed process
 *   trees; it never touches customer production or deletes workspaces.
 */
import {
  CapacityState,
  ControlError,
  ControlOperation,
  ControlRequest,
  ControlState,
  EMERGENCY_STOP_PROHIBITIONS,
  FactoryStatus,
  HealthState,
  OPERATION_SEMANTICS,
  WorkerAck,
} from './types';

export interface ControlHooks {
  now?: () => number;
  /** Authorize the control request; throw/return false to deny. */
  authorizer?: (op: ControlOperation, req: ControlRequest) => boolean | void;
  /** Revoke execution permissions (emergency stop). */
  revokeExecution?: (epoch: number) => void;
  /** Force-terminate factory-managed dev/dangerous process trees. */
  terminateManagedTrees?: (epoch: number) => string[];
  /** Move in-flight external actions to UNKNOWN for coordination. */
  markExternalUnknown?: (epoch: number) => string[];
}

function iso(now?: () => number): string {
  return new Date(now ? now() : Date.now()).toISOString();
}

/** Operations legal from each control state. EMERGENCY_STOP is legal from
 *  every state — an emergency stop must never be refused by state
 *  bookkeeping (§24.2). */
const ALLOWED: Record<ControlState, ControlOperation[]> = {
  STOPPED: ['START', 'EMERGENCY_STOP'],
  STARTING: ['EMERGENCY_STOP'],
  RUNNING: [
    'PAUSE_NEW_WORK',
    'PAUSE_AI_WORK',
    'FREEZE',
    'DRAIN',
    'GRACEFUL_STOP',
    'EMERGENCY_STOP',
  ],
  PAUSING: ['EMERGENCY_STOP', 'RESUME'],
  PAUSED: ['RESUME', 'FREEZE', 'DRAIN', 'GRACEFUL_STOP', 'EMERGENCY_STOP'],
  FREEZING: ['EMERGENCY_STOP', 'RESUME'],
  FROZEN: ['RESUME', 'GRACEFUL_STOP', 'EMERGENCY_STOP'],
  DRAINING: ['GRACEFUL_STOP', 'EMERGENCY_STOP', 'RESUME'],
  STOPPING: ['EMERGENCY_STOP'],
  EMERGENCY_STOPPED: ['RESUME', 'START', 'EMERGENCY_STOP'],
};

export class FactoryController {
  private control: ControlState = 'STOPPED';
  private health: HealthState = 'HEALTHY';
  private capacity: CapacityState = 'AVAILABLE';
  private epoch = 0;
  /** worker_id → ack for the CURRENT epoch. */
  private acks = new Map<string, WorkerAck>();
  private expectedWorkers = new Set<string>();
  private pendingTarget: ControlState | null = null;
  private lastOp: ControlOperation | null = null;

  constructor(private readonly hooks: ControlHooks = {}) {}

  // -- worker registration -------------------------------------------------

  registerWorker(workerId: string): void {
    this.expectedWorkers.add(workerId);
  }

  unregisterWorker(workerId: string): void {
    this.expectedWorkers.delete(workerId);
    this.acks.delete(workerId);
  }

  // -- independent axes -----------------------------------------------------

  setHealth(health: HealthState): void {
    this.health = health;
  }

  setCapacity(capacity: CapacityState): void {
    this.capacity = capacity;
  }

  // -- control operations ----------------------------------------------------

  /**
   * Issue a control operation. Returns the new epoch. Throws ControlError
   * when the operation is illegal from the current state or denied.
   */
  request(op: ControlOperation, req: ControlRequest): number {
    const auth = this.hooks.authorizer?.(op, req);
    if (auth === false) {
      throw new ControlError('UNAUTHORIZED', `control request denied for ${req.requested_by}`);
    }
    const allowed = ALLOWED[this.control];
    if (!allowed.includes(op)) {
      throw new ControlError(
        'POLICY_DENIED',
        `operation ${op} not allowed from ${this.control}`,
      );
    }
    this.epoch += 1;
    this.acks.clear();
    this.lastOp = op;
    const semantics = OPERATION_SEMANTICS[op];
    this.pendingTarget = semantics.target;

    if (op === 'EMERGENCY_STOP') {
      this.hooks.revokeExecution?.(this.epoch);
      this.hooks.terminateManagedTrees?.(this.epoch);
      this.hooks.markExternalUnknown?.(this.epoch);
      // Prohibitions hold by construction: nothing here shuts down the
      // system, deletes workspaces, or stops customer production.
    }

    // Optimistic transitional display; the terminal state is only *shown*
    // once ACKs arrive (see status()).
    if (op === 'START') this.control = 'STARTING';
    else if (op === 'RESUME') this.control = 'STARTING';
    else if (op === 'PAUSE_NEW_WORK' || op === 'PAUSE_AI_WORK') this.control = 'PAUSING';
    else if (op === 'FREEZE') this.control = 'FREEZING';
    else if (op === 'DRAIN') this.control = 'DRAINING';
    else if (op === 'GRACEFUL_STOP') this.control = 'STOPPING';
    else if (op === 'EMERGENCY_STOP') this.control = 'EMERGENCY_STOPPED';

    // No workers to wait for → settle immediately; otherwise the terminal
    // state waits for ACKs (never faked).
    if (this.expectedWorkers.size === 0 && this.pendingTarget) {
      this.control = this.pendingTarget;
      this.pendingTarget = null;
    }

    return this.epoch;
  }

  /** Record a worker ACK. Stale epochs are ignored (never applied backwards). */
  ack(ack: WorkerAck): void {
    if (ack.control_epoch !== this.epoch) return;
    if (!this.expectedWorkers.has(ack.worker_id)) return;
    this.acks.set(ack.worker_id, { ...ack, acked_at: iso(this.hooks.now) });
    if (this.pendingTarget && this.pendingAcks().length === 0) {
      this.control = this.pendingTarget;
      this.pendingTarget = null;
    }
  }

  pendingAcks(): string[] {
    const out: string[] = [];
    for (const id of this.expectedWorkers) {
      if (!this.acks.has(id)) out.push(id);
    }
    return out;
  }

  status(): FactoryStatus {
    const pending = this.pendingAcks();
    const display =
      pending.length > 0 && this.pendingTarget
        ? `${this.pendingTarget} (pending — ${pending.length} worker ACK${pending.length === 1 ? '' : 's'} outstanding: ${pending.join(', ')})`
        : `${this.control} · ${this.health} · ${this.capacity === 'AVAILABLE' ? 'AVAILABLE' : this.capacity.replace('_', ' ')}`;
    return {
      control: this.control,
      health: this.health,
      capacity: this.capacity,
      control_epoch: this.epoch,
      pending_acks: pending,
      display,
      updated_at: iso(this.hooks.now),
    };
  }

  semantics(op: ControlOperation) {
    return OPERATION_SEMANTICS[op];
  }

  prohibitions(): readonly string[] {
    return EMERGENCY_STOP_PROHIBITIONS;
  }

  lastOperation(): ControlOperation | null {
    return this.lastOp;
  }
}

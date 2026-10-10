/**
 * Run state machine — SPEC v2 §25.
 *
 * Twelve run states. SUCCEEDED means this Run's output contract is
 * satisfied; it does NOT mean the Task is DONE (INV-13: implementation,
 * verification, release, outcome verification and Done are different facts).
 */
import { Clock, FactoryError, systemClock } from './types';

/** SPEC v2 §25 — the twelve run states. */
export type RunState =
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'WAITING_TOOL'
  | 'WAITING_APPROVAL'
  | 'PAUSED'
  | 'BLOCKED'
  | 'QUOTA_LIMITED'
  | 'RECOVERING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export const RUN_STATES: readonly RunState[] = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'WAITING_TOOL',
  'WAITING_APPROVAL',
  'PAUSED',
  'BLOCKED',
  'QUOTA_LIMITED',
  'RECOVERING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
];

const TERMINAL: ReadonlySet<RunState> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/** Allowed transitions. Terminal states have no outgoing edges. */
export const RUN_STATE_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  QUEUED: ['STARTING', 'CANCELLED'],
  STARTING: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: [
    'WAITING_TOOL',
    'WAITING_APPROVAL',
    'PAUSED',
    'BLOCKED',
    'QUOTA_LIMITED',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
  ],
  WAITING_TOOL: ['RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  WAITING_APPROVAL: ['RUNNING', 'BLOCKED', 'CANCELLED'],
  PAUSED: ['RECOVERING', 'CANCELLED'],
  BLOCKED: ['RECOVERING', 'CANCELLED'],
  QUOTA_LIMITED: ['RUNNING', 'PAUSED', 'CANCELLED'],
  RECOVERING: ['RUNNING', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export class InvalidRunStateTransition extends FactoryError {
  constructor(from: RunState, to: RunState) {
    super(
      'INVALID_RUN_TRANSITION',
      `Run cannot transition ${from} → ${to}`,
    );
  }
}

export interface RunStateEvent {
  from: RunState;
  to: RunState;
  at: number;
  reason?: string;
}

export interface RunRecord {
  id: string;
  taskId: string;
  state: RunState;
  history: RunStateEvent[];
  /** SUCCEEDED records which output contract was satisfied — never "task done". */
  outputContract?: string;
}

/**
 * Explicit run-state machine. Every transition is recorded; illegal jumps
 * throw InvalidRunStateTransition instead of silently landing somewhere.
 */
export class RunStateMachine {
  private readonly clock: Clock;
  private readonly record: RunRecord;

  constructor(id: string, taskId: string, clock?: Clock) {
    this.clock = clock ?? systemClock;
    this.record = { id, taskId, state: 'QUEUED', history: [] };
  }

  get state(): RunState {
    return this.record.state;
  }

  get snapshot(): RunRecord {
    return { ...this.record, history: [...this.record.history] };
  }

  get isTerminal(): boolean {
    return TERMINAL.has(this.record.state);
  }

  transition(to: RunState, reason?: string): RunRecord {
    const from = this.record.state;
    if (!(RUN_STATE_TRANSITIONS[from] as readonly RunState[]).includes(to)) {
      throw new InvalidRunStateTransition(from, to);
    }
    this.record.state = to;
    this.record.history.push({ from, to, at: this.clock.now(), reason });
    return this.snapshot;
  }

  /** SUCCEEDED = output contract satisfied. Callers must name the contract. */
  succeed(outputContract: string): RunRecord {
    this.record.outputContract = outputContract;
    return this.transition('SUCCEEDED', `output contract satisfied: ${outputContract}`);
  }
}

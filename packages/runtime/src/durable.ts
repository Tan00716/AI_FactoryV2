/**
 * Durable execution — SPEC v2 §28.
 *
 * External operations move PREPARED → DISPATCHED → CONFIRMED_SUCCEEDED |
 * CONFIRMED_FAILED | UNKNOWN. A restart NEVER blindly replays: it queries
 * the target system's ledger first, and UNKNOWN results for irreversible
 * actions require manual/controlled recovery — never an automatic retry.
 *
 * Step intents are persisted BEFORE execution; facts are committed after
 * result collection. Checkpoints carry the §28.3 field set (not a chat
 * tail). When the disk is full or the DB unwritable, new dangerous side
 * effects stop while a minimal emergency log is preserved.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Clock, FactoryError, systemClock } from './types';

/** SPEC v2 §28.2 — external operation lifecycle. */
export type ExternalOpState =
  | 'PREPARED'
  | 'DISPATCHED'
  | 'CONFIRMED_SUCCEEDED'
  | 'CONFIRMED_FAILED'
  | 'UNKNOWN';

export const EXTERNAL_OP_STATES: readonly ExternalOpState[] = [
  'PREPARED',
  'DISPATCHED',
  'CONFIRMED_SUCCEEDED',
  'CONFIRMED_FAILED',
  'UNKNOWN',
];

export interface ExternalOperation {
  id: string;
  /** Binds the logical action + candidate + environment (§28.2). */
  idempotencyKey: string;
  logicalAction: string;
  candidateDigest: string;
  environment: string;
  state: ExternalOpState;
  /** Whether the effect can be safely retried / compensated. */
  reversible: boolean;
  preparedAt: number;
  dispatchedAt?: number;
  confirmedAt?: number;
  /** Reference into the target system's own ledger (PR #, deploy id, …). */
  ledgerRef?: string;
  attempts: number;
  lastError?: string;
}

export class UnknownExternalOpState extends FactoryError {
  constructor(id: string) {
    super('UNKNOWN_EXTERNAL_OP', `External operation ${id} is in an unknown state`);
  }
}

export class BlindReplayRefused extends FactoryError {
  readonly operationId: string;
  constructor(operationId: string, reason: string) {
    super(
      'BLIND_REPLAY_REFUSED',
      `Refusing to blindly replay external operation ${operationId}: ${reason}`,
    );
    this.operationId = operationId;
  }
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Read-only view of the TARGET system's ledger (queried on reconcile). */
export interface TargetLedgerQuery {
  /**
   * Look up what the target system actually did for this idempotency key.
   * Returns the known outcome, or undefined when the target cannot answer.
   */
  findByIdempotencyKey(
    key: string,
  ): { outcome: 'succeeded' | 'failed'; ledgerRef: string } | undefined;
}

export type ReconcileAction = 'already-done' | 'safe-to-retry' | 'needs-manual-recovery';

export interface ReconcileResult {
  action: ReconcileAction;
  operation: ExternalOperation;
  detail: string;
}

/**
 * Storage seam for the operation ledger (§28.2, G-59).
 *
 * The state machine (transition rules, reconcile verdicts) lives in
 * OperationLedger and reads/writes ONLY through this interface, in the
 * exact access pattern the machine uses: point lookups by id and by
 * idempotency key, whole-record writes after each transition, and a
 * full listing for startup reconciliation. Implementations must hand
 * back records the caller may freely mutate (copies, or freshly read
 * rows): the ledger mutates the record it fetched and then put()s it
 * back, so a store that returns live internal references would let a
 * failed transition leak a half-mutated record.
 */
export interface OperationStore {
  getById(id: string): ExternalOperation | undefined;
  getByIdempotencyKey(key: string): ExternalOperation | undefined;
  /** Insert a new operation, or replace the stored record with this id. */
  put(op: ExternalOperation): void;
  /** Every stored operation, in insertion order. */
  list(): ExternalOperation[];
}

/**
 * Default OperationStore: the original in-process Maps. Nothing here
 * survives a restart — it exists so embedders without a database keep
 * the pre-G-59 behavior, and so the ledger's default path is byte-for-
 * byte the old implementation's semantics (copies out, copies in).
 */
export class InMemoryOperationStore implements OperationStore {
  private readonly ops = new Map<string, ExternalOperation>();
  private readonly byKey = new Map<string, string>();

  getById(id: string): ExternalOperation | undefined {
    const op = this.ops.get(id);
    return op ? { ...op } : undefined;
  }

  getByIdempotencyKey(key: string): ExternalOperation | undefined {
    const id = this.byKey.get(key);
    return id === undefined ? undefined : this.getById(id);
  }

  put(op: ExternalOperation): void {
    this.ops.set(op.id, { ...op });
    this.byKey.set(op.idempotencyKey, op.id);
  }

  list(): ExternalOperation[] {
    return [...this.ops.values()].map((op) => ({ ...op }));
  }
}

export interface OperationLedgerOptions {
  now?: () => number;
  /**
   * Backing store for operation records. Defaults to a fresh
   * InMemoryOperationStore (pre-G-59 behavior: nothing survives a
   * restart). Durable deployments inject a persistent implementation
   * (see SqliteOperationStore in @ai-factory/db).
   */
  store?: OperationStore;
}

/**
 * Local ledger of external operations. The critical rule lives in
 * reconcile(): the target system is queried BEFORE any replay decision,
 * and UNKNOWN + irreversible ⇒ controlled/manual recovery, never auto-retry.
 */
export class OperationLedger {
  private readonly store: OperationStore;
  private readonly now: () => number;

  constructor(opts: OperationLedgerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.store = opts.store ?? new InMemoryOperationStore();
  }

  /** Idempotency key binds logical action + candidate digest + environment. */
  static idempotencyKey(logicalAction: string, candidateDigest: string, environment: string): string {
    return sha256Hex(`${logicalAction}|${candidateDigest}|${environment}`);
  }

  prepare(input: {
    logicalAction: string;
    candidateDigest: string;
    environment: string;
    reversible: boolean;
  }): ExternalOperation {
    const key = OperationLedger.idempotencyKey(
      input.logicalAction,
      input.candidateDigest,
      input.environment,
    );
    const existing = this.store.getByIdempotencyKey(key);
    if (existing) return { ...existing };
    const op: ExternalOperation = {
      id: randomUUID(),
      idempotencyKey: key,
      logicalAction: input.logicalAction,
      candidateDigest: input.candidateDigest,
      environment: input.environment,
      state: 'PREPARED',
      reversible: input.reversible,
      preparedAt: this.now(),
      attempts: 0,
    };
    this.store.put(op);
    return { ...op };
  }

  dispatch(id: string): ExternalOperation {
    const op = this.require(id);
    if (op.state !== 'PREPARED') {
      throw new FactoryError(
        'INVALID_OP_TRANSITION',
        `Cannot dispatch external operation in state ${op.state}`,
      );
    }
    op.state = 'DISPATCHED';
    op.dispatchedAt = this.now();
    op.attempts += 1;
    this.store.put(op);
    return { ...op };
  }

  confirm(id: string, ok: boolean, ledgerRef?: string): ExternalOperation {
    const op = this.require(id);
    if (op.state !== 'DISPATCHED' && op.state !== 'UNKNOWN') {
      throw new FactoryError(
        'INVALID_OP_TRANSITION',
        `Cannot confirm external operation in state ${op.state}`,
      );
    }
    op.state = ok ? 'CONFIRMED_SUCCEEDED' : 'CONFIRMED_FAILED';
    op.confirmedAt = this.now();
    if (ledgerRef !== undefined) op.ledgerRef = ledgerRef;
    this.store.put(op);
    return { ...op };
  }

  /** Network timeout / crash / kill with no reliable result → UNKNOWN. */
  markUnknown(id: string, reason: string): ExternalOperation {
    const op = this.require(id);
    op.state = 'UNKNOWN';
    op.lastError = reason;
    this.store.put(op);
    return { ...op };
  }

  get(id: string): ExternalOperation | undefined {
    const op = this.store.getById(id);
    return op ? { ...op } : undefined;
  }

  /**
   * Every operation in the ledger (copies), optionally filtered to one
   * state. This is the startup-reconcile input: after a restart the
   * caller lists what a previous process left behind and runs each
   * non-terminal operation through reconcile().
   */
  listOperations(state?: ExternalOpState): ExternalOperation[] {
    return this.store
      .list()
      .filter((op) => state === undefined || op.state === state)
      .map((op) => ({ ...op }));
  }

  /**
   * §28.2 — reconcile after a restart. The target ledger is queried FIRST.
   * - target says succeeded/failed → adopt it (already-done).
   * - target cannot answer + operation reversible → safe-to-retry (same key).
   * - target cannot answer + irreversible (or unknown reversibility) →
   *   needs-manual-recovery. NEVER a blind replay.
   */
  reconcile(id: string, target: TargetLedgerQuery): ReconcileResult {
    const op = this.require(id);
    if (op.state === 'CONFIRMED_SUCCEEDED' || op.state === 'CONFIRMED_FAILED') {
      return {
        action: 'already-done',
        operation: { ...op },
        detail: `already ${op.state}; no replay`,
      };
    }
    const seen = target.findByIdempotencyKey(op.idempotencyKey);
    if (seen) {
      const confirmed =
        seen.outcome === 'succeeded'
          ? this.confirm(id, true, seen.ledgerRef)
          : this.confirm(id, false, seen.ledgerRef);
      return {
        action: 'already-done',
        operation: confirmed,
        detail: `target ledger shows ${seen.outcome} (${seen.ledgerRef}); adopted, no replay`,
      };
    }
    if (op.reversible) {
      return {
        action: 'safe-to-retry',
        operation: { ...op },
        detail: 'target cannot answer but the action is reversible; retry reuses the idempotency key',
      };
    }
    return {
      action: 'needs-manual-recovery',
      operation: { ...op },
      detail:
        'target cannot answer and the action is irreversible/unknown: refusing blind replay; escalate to controlled recovery',
    };
  }

  /**
   * Convenience guard: throws BlindReplayRefused unless reconcile() produced
   * a replayable verdict. Call sites that want to "just retry" must go
   * through here.
   */
  assertReplayable(id: string, target: TargetLedgerQuery): ExternalOperation {
    const result = this.reconcile(id, target);
    if (result.action !== 'safe-to-retry' && result.action !== 'already-done') {
      throw new BlindReplayRefused(id, result.detail);
    }
    return result.operation;
  }

  private require(id: string): ExternalOperation {
    const op = this.store.getById(id);
    if (!op) throw new FactoryError('OP_NOT_FOUND', `External operation ${id} not found`);
    return op;
  }
}

/* ------------------------------------------------------------------ */
/* Step intents — persisted BEFORE execution (§28.1)                   */
/* ------------------------------------------------------------------ */

export interface StepIntent {
  id: string;
  runId: string;
  tool: string;
  argsHash: string;
  capabilityRef?: string;
  persistedAt: number;
  status: 'PENDING' | 'EXECUTED' | 'FAILED';
  resultHash?: string;
}

/**
 * Durable intent log. persistIntent() is called BEFORE the tool executes;
 * recordResult() commits the fact after. On restart, PENDING intents are
 * reconciled against the external ledger instead of blindly re-run.
 */
export class StepIntentStore {
  private readonly intents = new Map<string, StepIntent>();
  private readonly clock: Clock;

  constructor(clock?: Clock) {
    this.clock = clock ?? systemClock;
  }

  persistIntent(runId: string, tool: string, args: unknown, capabilityRef?: string): StepIntent {
    const intent: StepIntent = {
      id: randomUUID(),
      runId,
      tool,
      argsHash: sha256Hex(JSON.stringify(args ?? null)),
      capabilityRef,
      persistedAt: this.clock.now(),
      status: 'PENDING',
    };
    this.intents.set(intent.id, intent);
    return { ...intent };
  }

  recordResult(id: string, ok: boolean, result: unknown): StepIntent {
    const intent = this.intents.get(id);
    if (!intent) throw new FactoryError('INTENT_NOT_FOUND', `Step intent ${id} not found`);
    intent.status = ok ? 'EXECUTED' : 'FAILED';
    intent.resultHash = sha256Hex(JSON.stringify(result ?? null));
    return { ...intent };
  }

  pendingIntents(runId?: string): StepIntent[] {
    return [...this.intents.values()]
      .filter((i) => i.status === 'PENDING' && (runId === undefined || i.runId === runId))
      .map((i) => ({ ...i }));
  }

  /** All recorded intents (copies), optionally filtered by run id. */
  listIntents(runId?: string): StepIntent[] {
    return [...this.intents.values()]
      .filter((i) => runId === undefined || i.runId === runId)
      .map((i) => ({ ...i }));
  }
}

/* ------------------------------------------------------------------ */
/* Checkpoints — §28.3 field set                                       */
/* ------------------------------------------------------------------ */

/** SPEC v2 §28.3 — a checkpoint is a resumption contract, not a chat tail. */
export interface CheckpointV2 {
  schemaVersion: '2.0';
  runId: string;
  stepPosition: number;
  workflowVersion: string;
  taskVersion: string;
  contextManifestHash: string;
  modelSessionRef?: string;
  workspaceSnapshotHash?: string;
  gitBase?: string;
  gitCandidate?: string;
  activeTools: string[];
  activeProcesses: number[];
  leaseGeneration: number;
  fencingToken: number;
  pendingApprovals: string[];
  budgetUsage: Record<string, number>;
  pendingSideEffects: string[];
  resumePreconditions: string[];
  capturedAt: number;
}

export function createCheckpointV2(
  input: Omit<CheckpointV2, 'schemaVersion' | 'capturedAt'>,
  clock?: Clock,
): CheckpointV2 {
  const now = (clock ?? systemClock).now();
  return { ...input, schemaVersion: '2.0', capturedAt: now };
}

export function validateCheckpointV2(c: unknown): asserts c is CheckpointV2 {
  const v = c as Partial<CheckpointV2>;
  const missing: string[] = [];
  for (const f of [
    'runId',
    'stepPosition',
    'workflowVersion',
    'taskVersion',
    'contextManifestHash',
    'leaseGeneration',
    'fencingToken',
  ] as const) {
    if (v[f] === undefined || v[f] === null) missing.push(f);
  }
  if (v.schemaVersion !== '2.0') missing.push('schemaVersion');
  if (missing.length > 0) {
    throw new FactoryError('BAD_CHECKPOINT_V2', `Checkpoint missing fields: ${missing.join(', ')}`);
  }
}

/* ------------------------------------------------------------------ */
/* Disk / DB safe mode — §28.4                                         */
/* ------------------------------------------------------------------ */

export class DiskFullError extends FactoryError {
  constructor() {
    super('DISK_FULL', 'Storage is full or unwritable: refusing new dangerous side effects');
  }
}

/**
 * §28.4 — when the disk is full or the DB unwritable, stop NEW dangerous
 * side effects but keep a minimal emergency log so the failure itself is
 * recorded ("action executed but evidence never persisted" must not happen).
 */
export class StorageGuard {
  private writable = true;
  private readonly emergencyLog: string[] = [];

  reportWritable(writable: boolean): void {
    this.writable = writable;
  }

  get isWritable(): boolean {
    return this.writable;
  }

  /**
   * Gate a side effect: dangerous writes throw when storage is unhealthy;
   * read-only / emergency logging always passes.
   */
  assertCanWrite(dangerous: boolean, what: string): void {
    if (!this.writable && dangerous) {
      this.emergencyLog.push(`REFUSED(disk-full): ${what}`);
      throw new DiskFullError();
    }
  }

  emergencyLogLine(line: string): void {
    this.emergencyLog.push(line);
  }

  drainEmergencyLog(): string[] {
    const out = [...this.emergencyLog];
    this.emergencyLog.length = 0;
    return out;
  }
}

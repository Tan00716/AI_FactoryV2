/**
 * Agent runtime domain types — spec §24 (Agent Loop), §25 (loop engineering),
 * §26 (Harness), §27 (provider-independent agent runtime).
 */
import type { Agent, Permission, Task } from '@ai-factory/core';

/** §24 — the loop phases, in order. */
export type LoopPhase =
  | 'OBSERVE'
  | 'UNDERSTAND'
  | 'PLAN'
  | 'ACT'
  | 'VERIFY'
  | 'EVALUATE';

/** Phase order for the state machine. */
export const LOOP_PHASES: readonly LoopPhase[] = [
  'OBSERVE',
  'UNDERSTAND',
  'PLAN',
  'ACT',
  'VERIFY',
  'EVALUATE',
];

/** §24 — terminal decision after EVALUATE (plus in-loop CONTINUE/RETRY). */
export type LoopDecision = 'CONTINUE' | 'RETRY' | 'HANDOFF' | 'ESCALATE' | 'COMPLETE' | 'SUBMIT';

/** §25 — budgets. Exceeding any of them throws BudgetExceeded. */
export interface LoopBudgets {
  /** Maximum total phase executions (across all retries). */
  maxSteps: number;
  /** Maximum wall-clock milliseconds for the whole run. */
  timeMs: number;
  /** Maximum RETRY cycles before giving up. */
  maxRetries: number;
}

/** Injectable clock for deterministic tests (§25). */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Read-only view of loop state handed to each StepFn invocation. */
export interface LoopSnapshot {
  phase: LoopPhase;
  totalSteps: number;
  retries: number;
  elapsedMs: number;
  consecutiveFailures: number;
  lastErrorSignature: string | null;
}

/**
 * What a StepFn returns for one phase. The loop never calls an LLM itself:
 * callers script behavior (tests/demo) or wire a RuntimeAdapter (production).
 */
export interface PhaseResult {
  ok: boolean;
  error?: string;
  /**
   * Stable signature of the failure (e.g. a normalized test-output hash).
   * The same signature `stagnationLimit` times in a row → LOOP_STAGNATION
   * → auto-escalate (§25). Defaults to `error` when omitted.
   */
  errorSignature?: string;
  /** Only meaningful from EVALUATE; defaults to COMPLETE on ok. */
  decision?: LoopDecision;
  /** Handoff target agent/queue for decision=HANDOFF. */
  handoffTo?: string;
  note?: string;
}

/** Drives one loop phase; may be async. Throwing counts as a failed phase. */
export type StepFn = (
  phase: LoopPhase,
  snapshot: LoopSnapshot,
) => PhaseResult | Promise<PhaseResult>;

export type LoopOutcomeDecision = 'COMPLETE' | 'HANDOFF' | 'ESCALATE' | 'PAUSED';

export interface LoopOutcome {
  decision: LoopOutcomeDecision;
  handoffTo?: string;
  steps: number;
  retries: number;
  trace: TraceStep[];
}

/** One recorded step — the tracing unit (§26). */
export interface TraceStep {
  t: number;
  phase: string;
  action: string;
  result: string;
}

/**
 * Evidence input for the sink. The runtime never touches core's evidence
 * store directly: the caller supplies an EvidenceSink that forwards into
 * their own store (§26 "Evidence Collection").
 */
export interface EvidenceInput {
  type: string;
  title: string;
  payload: Record<string, unknown>;
}

export interface EvidenceRecord extends EvidenceInput {
  t: number;
}

export interface EvidenceSink {
  collect(evidence: EvidenceInput): void;
}

/** Final result of runAgent(). */
export type RunOutcome = 'completed' | 'escalated' | 'failed';

export interface RunResult {
  outcome: RunOutcome;
  steps: number;
  evidence: EvidenceRecord[];
  handoffs: string[];
  trace: TraceStep[];
  reason?: string;
  /**
   * Machine-readable terminal reason code (Batch 38): the FactoryError.code
   * when the run's terminal state came from a thrown FactoryError
   * ('BUDGET_EXCEEDED', 'LOOP_STAGNATION'), null otherwise. The server
   * classifies §81 needsHuman emissions on this code — determinately —
   * instead of matching on the human-readable reason message.
   */
  reasonCode?: string | null;
  /**
   * Batch 43 — the LoopStagnation signature when the run escalated on
   * stagnation (the errorSignature the loop gave up on: a FactoryError
   * code when the repeating step threw a FactoryError, 'step-throw'
   * otherwise). Null when the run did not escalate on stagnation. The
   * server classifies §81 'irrecoverable-env-error' on this field —
   * determinately, by code — instead of parsing the human-readable
   * reason message.
   */
  stagnationSignature?: string | null;
  /** §25 (G-51) — extended-budget consumption for this run, when a
   *  BudgetTracker was wired (runAgent's default path always wires one). */
  budgetUsage?: {
    modelCalls: number;
    toolCalls: number;
    repairLoops: number;
    noProgressSteps: number;
    elapsedMs: number;
  };
  /** §28.1 (G-53) — step intents persisted by this run (runAgent's
   *  default path always wires a StepIntentStore). Covers only intents
   *  created during this run, read back from the harness's effective
   *  store. The default store is in-memory; the server injects the
   *  SQLite-backed SqliteStepIntentStore (packages/db, G-59), which
   *  persists intents and feeds the startup scan (see
   *  docs/KNOWN_LIMITATIONS.md). */
  intentSummary?: {
    count: number;
    intentIds: string[];
    executed: number;
    failed: number;
    pending: number;
    /** §28.1 — calls the permission gate refused before execution. */
    denied: number;
  };
}

export type { Agent, Permission, Task };

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Base class for runtime errors; `code` is machine-readable. */
export class FactoryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** §25 — step, time, or retry budget exceeded. */
export class BudgetExceeded extends FactoryError {
  constructor(reason: string) {
    super('BUDGET_EXCEEDED', `Budget exceeded: ${reason}`);
  }
}

/** §25 — same error signature N times in a row; the run auto-escalates. */
export class LoopStagnation extends FactoryError {
  readonly signature: string;
  constructor(signature: string, limit: number) {
    super(
      'LOOP_STAGNATION',
      `Loop stagnated: same error signature '${signature}' ${limit} times in a row — escalating`,
    );
    this.signature = signature;
  }
}

/** §26 — a tool call was denied by the permission check (always audited). */
export class PermissionDenied extends FactoryError {
  constructor(tool: string, detail: string) {
    super('PERMISSION_DENIED', `Tool '${tool}' denied: ${detail}`);
  }
}

/**
 * Batch 40 — environment failure: a required sandbox (bwrap) is unavailable.
 * Deterministic machine-readable signal (OS probe result), NOT a heuristic
 * classification — the first half of the 39-4 precondition for ever wiring
 * §81 'irrecoverable-env-error'. The SANDBOX_UNAVAILABLE audit semantics
 * stay as-is; this is the throwable form for callers that REQUIRE the
 * sandbox. Signal layer only: nothing auto-emits needsHuman on this code.
 */
export class SandboxUnavailableError extends FactoryError {
  readonly probeReason: string;
  constructor(probeReason: string) {
    super('ENV_SANDBOX_UNAVAILABLE', `Sandbox unavailable: ${probeReason}`);
    this.probeReason = probeReason;
  }
}

/**
 * Batch 40 — environment failure: a binary the environment must provide is
 * missing. Deterministic (spawn ENOENT from the OS), not a heuristic guess.
 * Thrown by runCommandPipe when the child cannot be spawned because the
 * binary does not exist. Signal layer only: nothing auto-emits needsHuman
 * on this code.
 */
export class MissingBinaryError extends FactoryError {
  readonly binary: string;
  constructor(binary: string, detail?: string) {
    super(
      'ENV_BINARY_MISSING',
      `Required binary '${binary}' is missing${detail ? `: ${detail}` : ''}`,
    );
    this.binary = binary;
  }
}

/** §26 — a path resolved outside the harness's allowed roots. */
export class FilesystemBoundary extends FactoryError {
  constructor(resolvedPath: string) {
    super('FILESYSTEM_BOUNDARY', `Path outside allowed roots: ${resolvedPath}`);
  }
}

/**
 * Batch 43 — the machine-readable environment-error code namespace, as an
 * explicit set. A code is in this set iff a Batch-40-style deterministic
 * environment failure carries it (SandboxUnavailableError,
 * MissingBinaryError). Explicit set, not a prefix rule: adding a code here
 * is a deliberate product decision (a new code starts NOT emitting), never
 * an accident of naming. The server's §81 'irrecoverable-env-error'
 * emission matches on this set — by code, never by message.
 */
export const ENV_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENV_SANDBOX_UNAVAILABLE',
  'ENV_BINARY_MISSING',
]);

/** Deterministic environment-error predicate: code membership, no heuristics. */
export function isEnvErrorCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && ENV_ERROR_CODES.has(code);
}

/** §26 — a step (tool call / adapter call) exceeded its timeout. */
export class StepTimeout extends FactoryError {
  constructor(label: string, ms: number) {
    super('STEP_TIMEOUT', `Step '${label}' timed out after ${ms}ms`);
  }
}

/** §27 — a placeholder adapter was invoked without a real implementation. */
export class AdapterNotImplemented extends FactoryError {
  constructor(detail: string) {
    super('ADAPTER_NOT_IMPLEMENTED', detail);
  }
}

/** Checkpoint token failed to parse/validate. */
export class BadCheckpoint extends FactoryError {
  constructor(detail: string) {
    super('BAD_CHECKPOINT', `Invalid checkpoint token: ${detail}`);
  }
}

/**
 * Adapter contract — spec §26.2.
 *
 * The full provider-independent adapter surface:
 *
 *   discoverCapabilities, getAccountStatus, getQuota, startSession,
 *   runTurn, streamEvents, cancelTurn, exportCheckpoint, recoverSession,
 *   closeSession
 *
 * Rules (§26.2, verbatim intent):
 *  - A method an adapter cannot perform signals UNSUPPORTED — it never
 *    fakes a cancellation, a recovery, or any other success. The signal
 *    is an AdapterUnsupportedError (code 'UNSUPPORTED'); status-shaped
 *    methods (getAccountStatus / getQuota) instead return their result
 *    with source 'none' and an error note, because "unknown" is a
 *    legitimate answer there (§27.1: supplier data that is not provided
 *    is shown as unknown — never fabricated).
 *  - Adapters negotiate the protocol version at handshake
 *    (discoverCapabilities performs/reports it), validate messages at
 *    the transport, and are pinned by repeatable Contract Tests
 *    (tests/adapter-contract.test.ts runs one battery over every
 *    shipped adapter).
 *
 * `RuntimeAdapter.invoke()` (adapters.ts) remains the one-shot
 * convenience the agent loop consumes; `AdapterContract` is the full
 * §26.2 surface layered on top of it. Both shipped adapters
 * (StubAdapter, CodexAdapter) implement AdapterContract.
 */
import type { AdapterAction, AdapterInput, AdapterOutput, RuntimeAdapter } from './adapters';

/** §26.2 — the UNSUPPORTED signal: code is the machine-readable marker. */
export class AdapterUnsupportedError extends Error {
  readonly code = 'UNSUPPORTED' as const;
  constructor(
    readonly adapter: string,
    readonly method: string,
    readonly reason: string,
  ) {
    super(`${adapter}: ${method} is UNSUPPORTED — ${reason}`);
    this.name = 'AdapterUnsupportedError';
  }
}

/**
 * A turn ended because cancelTurn() interrupted it. Distinct from a
 * generic failure: the run was cancelled on purpose, and the adapter
 * only raises this after the provider CONFIRMS the interruption —
 * never as a guess (§26.2: no simulated cancellations).
 */
export class AdapterTurnCancelledError extends Error {
  readonly code = 'TURN_CANCELLED' as const;
  constructor(adapter: string, sessionId: string) {
    super(`${adapter}: turn on session ${sessionId} was cancelled (provider-confirmed)`);
    this.name = 'AdapterTurnCancelledError';
  }
}

/** Context-window bucket, same vocabulary as the model router (§26.1). */
export type AdapterContextSize = 'small' | 'medium' | 'large' | 'unknown';

/**
 * §26.1 capability metadata as discovered/declared by ONE adapter.
 * Values an adapter cannot honestly state are false / 'unknown' —
 * discovery never upgrades a guess into a claim. `notes` carries the
 * provenance of the values (negotiated vs declared).
 */
export interface AdapterCapabilities {
  adapter: string;
  /** Protocol negotiation outcome (§26.2): what the handshake established. */
  protocol: {
    name: string;
    /** Server-reported identity/version string, when the protocol has one. */
    serverInfo?: string;
  };
  /** §26.1 工具调用. */
  tools: boolean;
  /** §26.1 结构化输出. */
  structuredOutput: boolean;
  /** §26.1 Vision. */
  vision: boolean;
  /** §26.1 Reasoning 设置 (boolean: reasoning strings are not cross-provider equivalents). */
  reasoning: boolean;
  /** §26.1 Streaming. */
  streaming: boolean;
  /** §26.1 Cancellation. */
  cancellation: boolean;
  /** §26.1 Resume/Session. */
  resume: boolean;
  /** §26.1 Context (bucket; 'unknown' when the provider does not report one). */
  maxContext: AdapterContextSize;
  /** §26.1 Quota Bucket this adapter draws from, when it is a single known bucket. */
  quotaBucket?: string;
  /** §26.1 Supported Host(s) this adapter instance runs against. */
  supportedHosts: readonly string[];
  /** Provenance / honesty annotations for the values above. */
  notes: readonly string[];
}

/**
 * §26.2 / §27.1 account status, provider-independent.
 * `authenticated: null` means "unknown" (e.g. server unreachable) —
 * never a guessed boolean.
 */
export interface AdapterAccountStatus {
  /** True only when the provider actually answered. */
  reachable: boolean;
  authenticated: boolean | null;
  /** Provider auth mode label ('chatgpt', 'apikey', …), null when unknown. */
  authMethod: string | null;
  /** Whether the provider requires OpenAI auth, when it says so. */
  requiresOpenaiAuth: boolean | null;
  account: { type: string; email: string | null; planType: string | null } | null;
  /** Where this answer came from — live provider, scripted stub, or nobody. */
  source: 'live' | 'stub' | 'none';
  /** Why the status is incomplete/unavailable, when it is. */
  error?: string;
}

/** One quota window (§27.1). Every measurement is nullable: unknown stays null. */
export interface AdapterQuotaBucket {
  /** Bucket identity (provider limit id / window role, e.g. 'codex:primary'). */
  id: string;
  /** Percentage USED of the window; null when the provider does not report it. */
  usedPct: number | null;
  /** Percentage remaining; null unless derivable from a reported usedPct. */
  remainingPct: number | null;
  windowDurationMins: number | null;
  /** Window reset time, epoch milliseconds; null when not reported. */
  resetsAt: number | null;
}

/** §26.2 getQuota / §27.1 quota snapshot. No bucket value is ever invented. */
export interface AdapterQuota {
  /** Collection time (epoch ms) — freshness is part of the §27.1 display contract. */
  collectedAt: number;
  source: 'live' | 'stub' | 'none';
  buckets: AdapterQuotaBucket[];
  planType?: string | null;
  error?: string;
}

export interface AdapterSessionOptions {
  /** Model override for the session (provider default when unset). */
  model?: string;
  /** Working directory for the session (provider default when unset). */
  cwd?: string;
}

/** A live adapter session (§26.2 startSession / recoverSession). */
export interface AdapterSession {
  sessionId: string;
  adapter: string;
  createdAt: number;
  /** True when this handle was reattached from a checkpoint. */
  resumed?: boolean;
}

/**
 * One streamed event of a turn (§26.2 streamEvents). A turn's event
 * sequence ends with exactly one terminal event (turn-completed /
 * turn-failed / turn-cancelled).
 */
export type AdapterEvent =
  | { type: 'text'; text: string }
  | { type: 'action'; action: AdapterAction }
  | { type: 'turn-completed'; status: 'completed' }
  | { type: 'turn-failed'; error: string }
  | { type: 'turn-cancelled' };

/**
 * §26.2 exportCheckpoint — the reattach token for a session. `data`
 * holds only facts the adapter itself knows (provider session/thread
 * reference, configuration, progress counters); it is NOT a transcript
 * and never pretends to be one.
 */
export interface AdapterCheckpoint {
  adapter: string;
  version: 1;
  /** Opaque provider-side session reference (thread id, session id, …). */
  sessionRef: string;
  exportedAt: number;
  data: Record<string, unknown>;
}

/** §26.2 — the full adapter contract. */
export interface AdapterContract extends RuntimeAdapter {
  /** Negotiate/discover what this adapter+provider can do. */
  discoverCapabilities(): Promise<AdapterCapabilities>;
  /** Provider account status; unreachable/unknown is reported, not fabricated. */
  getAccountStatus(): Promise<AdapterAccountStatus>;
  /** Quota snapshot; unreported values stay null (§27.1). */
  getQuota(): Promise<AdapterQuota>;
  /** Open a stateful session. */
  startSession(options?: AdapterSessionOptions): Promise<AdapterSession>;
  /** Run one turn on an open session. */
  runTurn(sessionId: string, input: AdapterInput): Promise<AdapterOutput>;
  /**
   * Events of the session's current / most recent turn, ending with
   * exactly one terminal event. Live while a turn runs on adapters
   * that stream; completes immediately (empty) when the session has
   * no turn yet.
   */
  streamEvents(sessionId: string): AsyncIterable<AdapterEvent>;
  /**
   * Cancel the session's in-flight turn. Resolves only after the
   * provider confirms the interruption; rejects with
   * AdapterUnsupportedError when the provider has no cancellation,
   * and with a plain error when there is no turn to cancel.
   */
  cancelTurn(sessionId: string): Promise<void>;
  /** Export a reattach checkpoint for the session. */
  exportCheckpoint(sessionId: string): Promise<AdapterCheckpoint>;
  /**
   * Reattach a session from a checkpoint. Rejects when the provider
   * cannot reattach (e.g. the session is gone) — never returns a
   * session that was not actually recovered.
   */
  recoverSession(checkpoint: AdapterCheckpoint): Promise<AdapterSession>;
  /** Close the session and release its provider resources. */
  closeSession(sessionId: string): Promise<void>;
}

/** Structural check: does this adapter implement the full §26.2 contract? */
export function isAdapterContract(a: RuntimeAdapter): a is AdapterContract {
  const c = a as Partial<AdapterContract>;
  return (
    typeof c.discoverCapabilities === 'function' &&
    typeof c.getAccountStatus === 'function' &&
    typeof c.getQuota === 'function' &&
    typeof c.startSession === 'function' &&
    typeof c.runTurn === 'function' &&
    typeof c.streamEvents === 'function' &&
    typeof c.cancelTurn === 'function' &&
    typeof c.exportCheckpoint === 'function' &&
    typeof c.recoverSession === 'function' &&
    typeof c.closeSession === 'function'
  );
}

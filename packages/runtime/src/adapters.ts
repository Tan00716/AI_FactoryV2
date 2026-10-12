/**
 * Runtime adapters — spec §27 (Agent Runtime).
 *
 * The runtime layer is provider-independent:
 *
 *   Agent → Model Router → Runtime Adapter
 *                            ├── OpenAI Codex
 *                            ├── OpenAI Agent Runtime
 *                            ├── Anthropic
 *                            ├── Google
 *                            ├── Local Model
 *                            └── Custom Runtime
 *
 * Agent definitions never hard-code one model provider. StubAdapter serves
 * scripted responses for tests and demos; CodexAdapter talks to a real Codex
 * app-server (spec §28: ChatGPT OAuth / authorized plan) over the JSON-RPC
 * transport in codex-transport.ts.
 */
import {
  CodexAdapterError,
  StdioCodexTransport,
  WebSocketCodexTransport,
  type CodexTransport,
} from './codex-transport';
import {
  AdapterTurnCancelledError,
  AdapterUnsupportedError,
  type AdapterAccountStatus,
  type AdapterCapabilities,
  type AdapterCheckpoint,
  type AdapterContract,
  type AdapterEvent,
  type AdapterQuota,
  type AdapterSession,
  type AdapterSessionOptions,
} from './adapter-contract';

export { CodexAdapterError } from './codex-transport';
export type { CodexTransport } from './codex-transport';

export interface AdapterInput {
  prompt: string;
  tools: string[];
}

export interface ToolCall {
  tool: string;
  args: unknown;
}

/**
 * An action a self-driving runtime (e.g. Codex) has ALREADY executed inside
 * its own sandbox, recorded here for the evidence chain. Observation only —
 * the factory harness must never re-execute these.
 */
export interface AdapterAction {
  kind: string;
  summary: string;
}

export interface AdapterOutput {
  text: string;
  toolCalls: ToolCall[];
  /**
   * Actions already executed by the adapter's own runtime (Codex only).
   * Optional: StubAdapter never sets it. See CodexAdapter for why Codex
   * tool calls live here and not in `toolCalls`.
   */
  actions?: AdapterAction[];
}

/** §27 — provider-independent model invocation interface. */
export interface RuntimeAdapter {
  name: string;
  invoke(input: AdapterInput): Promise<AdapterOutput>;
}

/** Optional §26.2 contract fixtures for StubAdapter (all scripted, all labelled). */
export interface StubAdapterOptions {
  capabilities?: Partial<AdapterCapabilities>;
  accountStatus?: AdapterAccountStatus;
  quota?: AdapterQuota;
}

interface StubSessionState {
  createdAt: number;
  resumed: boolean;
  /** Events synthesized from this session's most recent turn (§26.2 streamEvents). */
  lastEvents: AdapterEvent[];
}

/**
 * Scripted adapter for tests and demos: replays queued responses in order.
 * Implements the full §26.2 AdapterContract in scripted form — sessions are
 * in-process handles over the same response queue invoke() draws from, and
 * every status it reports labels itself source 'stub'. The one method it
 * honestly cannot perform is cancelTurn: scripted turns complete
 * synchronously, so there is never an in-flight turn to cancel — it signals
 * UNSUPPORTED instead of simulating a cancellation (§26.2).
 */
export class StubAdapter implements AdapterContract {
  readonly name = 'stub';
  private readonly queue: AdapterOutput[];
  private readonly options: StubAdapterOptions;
  private readonly sessions = new Map<string, StubSessionState>();
  private sessionSeq = 0;
  private servedCount = 0;

  constructor(script: AdapterOutput[], options: StubAdapterOptions = {}) {
    this.queue = [...script];
    this.options = options;
  }

  async invoke(_input: AdapterInput): Promise<AdapterOutput> {
    return this.nextOutput();
  }

  /** How many scripted responses remain. */
  get remaining(): number {
    return this.queue.length;
  }

  private nextOutput(): AdapterOutput {
    const next = this.queue.shift();
    this.servedCount += 1;
    return next ?? { text: '', toolCalls: [] };
  }

  // ── §26.2 contract ──────────────────────────────────────────────────────

  async discoverCapabilities(): Promise<AdapterCapabilities> {
    return {
      adapter: this.name,
      protocol: { name: 'stub' },
      tools: true,
      structuredOutput: true,
      vision: false,
      reasoning: true,
      streaming: true,
      cancellation: false,
      resume: true,
      maxContext: 'unknown',
      supportedHosts: ['in-process'],
      notes: [
        'Scripted test/demo adapter: every value is declared by the fixture, ' +
          'nothing is measured against a provider.',
      ],
      ...this.options.capabilities,
    };
  }

  async getAccountStatus(): Promise<AdapterAccountStatus> {
    return (
      this.options.accountStatus ?? {
        reachable: true,
        authenticated: null,
        authMethod: 'stub',
        requiresOpenaiAuth: null,
        account: null,
        source: 'stub',
      }
    );
  }

  async getQuota(): Promise<AdapterQuota> {
    return (
      this.options.quota ?? { collectedAt: Date.now(), source: 'stub', buckets: [] }
    );
  }

  async startSession(_options?: AdapterSessionOptions): Promise<AdapterSession> {
    const sessionId = `stub-session-${++this.sessionSeq}`;
    const createdAt = Date.now();
    this.sessions.set(sessionId, { createdAt, resumed: false, lastEvents: [] });
    return { sessionId, adapter: this.name, createdAt };
  }

  private stubSession(sessionId: string): StubSessionState {
    const s = this.sessions.get(sessionId);
    if (!s) {
      throw new Error(`stub: unknown session '${sessionId}' (not started, or already closed)`);
    }
    return s;
  }

  async runTurn(sessionId: string, _input: AdapterInput): Promise<AdapterOutput> {
    const session = this.stubSession(sessionId);
    const out = this.nextOutput();
    const events: AdapterEvent[] = [];
    if (out.text) events.push({ type: 'text', text: out.text });
    for (const a of out.actions ?? []) events.push({ type: 'action', action: a });
    events.push({ type: 'turn-completed', status: 'completed' });
    session.lastEvents = events;
    return out;
  }

  async *streamEvents(sessionId: string): AsyncIterable<AdapterEvent> {
    // Scripted turns are already complete by the time anyone subscribes:
    // the stream is the synthesized event record of the most recent turn.
    yield* this.stubSession(sessionId).lastEvents;
  }

  async cancelTurn(_sessionId: string): Promise<void> {
    throw new AdapterUnsupportedError(
      this.name,
      'cancelTurn',
      'scripted turns complete synchronously; there is never an in-flight turn to cancel',
    );
  }

  async exportCheckpoint(sessionId: string): Promise<AdapterCheckpoint> {
    this.stubSession(sessionId);
    return {
      adapter: this.name,
      version: 1,
      sessionRef: sessionId,
      exportedAt: Date.now(),
      data: { servedCount: this.servedCount, remaining: this.queue.length },
    };
  }

  async recoverSession(checkpoint: AdapterCheckpoint): Promise<AdapterSession> {
    if (checkpoint.adapter !== this.name) {
      throw new AdapterUnsupportedError(
        this.name,
        'recoverSession',
        `checkpoint belongs to adapter '${checkpoint.adapter}'`,
      );
    }
    // The script queue is adapter-level and monotonic: recovery is a fresh
    // handle onto the same script position — the next turn continues the
    // script, it neither restarts nor skips.
    const session = await this.startSession();
    this.sessions.get(session.sessionId)!.resumed = true;
    return { ...session, resumed: true };
  }

  async closeSession(sessionId: string): Promise<void> {
    this.stubSession(sessionId);
    this.sessions.delete(sessionId);
  }
}

export interface CodexAdapterConfig {
  /**
   * URL of an already-running app-server: `ws://127.0.0.1:PORT` (start one
   * with `codex app-server --listen ws://127.0.0.1:PORT`). When unset, the
   * adapter spawns a local app-server over stdio instead.
   */
  appServerUrl?: string;
  /** Auth profile per spec §28 — never force everything onto an API key. */
  auth: 'chatgpt-oauth' | 'api-key';
  account?: string;
  /** Model override for thread/start (server default when unset). */
  model?: string;
  /** Working directory for the thread (server default when unset). */
  cwd?: string;
  /**
   * Sandbox for the thread. Default 'read-only' — fail-closed: the first
   * wired loop observes Codex, it does not yet let it write. Widening this
   * is an explicit operator decision, never a silent default.
   */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Approval policy for the thread. Default 'never' (no server-initiated approval requests). */
  approvalPolicy?: 'never' | 'on-request' | 'untrusted';
  /** Overall budget for one invoke()/getAccountStatus() call. Default 120_000 ms. */
  timeoutMs?: number;
  /** Spawn-mode executable. Default 'codex'. */
  command?: string;
  /** Spawn-mode arguments. Default ['app-server', '--stdio']. */
  args?: string[];
}

/** Structured result of CodexAdapter.getAccountStatus() — honest, never fabricated. */
export interface CodexAccountStatus {
  /** True only when the app-server answered. */
  reachable: boolean;
  /** AuthMode from getAuthStatus ('chatgpt', 'apikey', …), null when unknown. */
  authMethod: string | null;
  requiresOpenaiAuth: boolean | null;
  account: { type: string; email: string | null; planType: string | null } | null;
  /** Raw account/rateLimits/read snapshot, when the server provides one. */
  rateLimits?: unknown;
  /**
   * §26.2 contract field: true when the server reported an account,
   * false when it reported none while requiring OpenAI auth, null when
   * authentication state is unknown (server unreachable).
   */
  authenticated: boolean | null;
  /** §26.2 contract field: 'live' when the app-server answered, else 'none'. */
  source: 'live' | 'none';
  /** Why the status is incomplete/unavailable, when it is. */
  error?: string;
}

const DEFAULT_CODEX_TIMEOUT_MS = 120_000;
const CLIENT_INFO = { name: 'ai-factory', title: 'AI Factory Runtime', version: '0.1.0' };

/**
 * Real OpenAI Codex runtime (spec §27–§28), backed by `codex app-server`.
 *
 * Key semantic — why `toolCalls` is ALWAYS [] here:
 * The factory loop (runner.ts) hands AdapterOutput.toolCalls to the factory
 * harness for execution, and unknown tools fail the run. Codex is itself an
 * agent runtime: by the time a turn completes, it has ALREADY executed its
 * commands/file changes/tool calls inside its own sandbox. Reporting those
 * as factory `toolCalls` would make the factory execute them a second time
 * (or fail them as unknown). So Codex-internal actions are mapped to the
 * observation-only `actions` field instead, for the evidence chain.
 *
 * Thread defaults are fail-closed: ephemeral thread, sandbox 'read-only',
 * approvalPolicy 'never'. Every invoke() uses its own connection + thread
 * and always cleans up (socket closed / child killed), even on timeout.
 * Any failure — spawn error, handshake refusal, server exit, failed turn,
 * not-logged-in — throws CodexAdapterError. There is no fake success path.
 */
/** Live session state for the §26.2 session methods (one transport per session). */
interface CodexSessionState {
  transport: CodexTransport;
  threadId: string;
  createdAt: number;
  resumed: boolean;
  /** Events of the current / most recent turn (streamEvents source). */
  events: AdapterEvent[];
  turnActive: boolean;
  activeTurnId: string | null;
  /** How the most recent turn ended; cancelTurn only trusts 'cancelled'. */
  lastTurnOutcome: 'completed' | 'failed' | 'cancelled' | null;
  /** Settles (never rejects) when the in-flight turn settles. */
  activeDone: Promise<void> | null;
  /** streamEvents subscribers waiting for the next event / turn end. */
  waiters: Array<() => void>;
}

export class CodexAdapter implements AdapterContract {
  readonly name = 'codex';
  private readonly sessions = new Map<string, CodexSessionState>();

  constructor(private readonly config: CodexAdapterConfig) {}

  get authKind(): CodexAdapterConfig['auth'] {
    return this.config.auth;
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
  }

  private async connect(): Promise<CodexTransport> {
    const url = this.config.appServerUrl;
    if (url) {
      if (!/^wss?:\/\//i.test(url)) {
        throw new CodexAdapterError(
          `CodexAdapter: appServerUrl must be a ws:// or wss:// URL (got '${url}'). ` +
            `Start a server with 'codex app-server --listen ws://127.0.0.1:PORT', ` +
            `or omit appServerUrl to spawn 'codex app-server --stdio' locally.`,
        );
      }
      return WebSocketCodexTransport.connect(url);
    }
    return new StdioCodexTransport(this.config.command ?? 'codex', this.config.args ?? [
      'app-server',
      '--stdio',
    ]);
  }

  /** Race `work` against timeoutMs; callers close the transport in finally. */
  private async withTimeout<T>(label: string, work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new CodexAdapterError(
                `codex app-server ${label} timed out after ${this.timeoutMs}ms`,
              ),
            );
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async invoke(input: AdapterInput): Promise<AdapterOutput> {
    const transport = await this.connect();
    try {
      return await this.withTimeout('turn', this.invokeEphemeral(transport, input));
    } finally {
      transport.close();
    }
  }

  /** One-shot flow behind invoke(): handshake → ephemeral thread → one turn. */
  private async invokeEphemeral(
    transport: CodexTransport,
    input: AdapterInput,
  ): Promise<AdapterOutput> {
    await this.initialize(transport);
    const threadId = await this.startThreadWith(transport, {}, true);
    return this.executeTurn(transport, threadId, input);
  }

  /** Protocol handshake (§26.2 version negotiation). Returns the initialize result. */
  private async initialize(transport: CodexTransport): Promise<any> {
    const res = await transport.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: null,
    });
    transport.notify('initialized');
    return res;
  }

  /**
   * Execute one turn on an existing thread and await its terminal event.
   * Shared by invoke() (ephemeral thread) and the §26.2 session methods.
   * A turn the server reports as 'interrupted' rejects with
   * AdapterTurnCancelledError — the only path that produces it, so a
   * cancellation is never claimed without the server's confirmation.
   */
  private async executeTurn(
    transport: CodexTransport,
    threadId: string,
    input: AdapterInput,
    hooks: {
      onEvent?: (e: AdapterEvent) => void;
      onTurnStarted?: (turnId: string | null) => void;
    } = {},
  ): Promise<AdapterOutput> {
    const textParts: string[] = [];
    const actions: AdapterAction[] = [];
    let turnId: string | null = null;
    // Session transports outlive a single turn: this handler must go
    // inert when its turn settles, or it would double-report the NEXT
    // turn's events on the same thread.
    let active = true;
    let settleTurn!: {
      resolve: () => void;
      reject: (err: unknown) => void;
    };
    const turnDone = new Promise<void>((resolve, reject) => {
      settleTurn = { resolve, reject };
    });

    // Attach collectors BEFORE turn/start: the server may stream
    // item/completed notifications ahead of the turn/start response.
    transport.onNotification((method, params) => {
      if (!active) return;
      if (params?.threadId !== threadId) return;
      if (method === 'item/completed' && params.item) {
        const beforeText = textParts.length;
        const beforeActions = actions.length;
        collectItem(params.item, textParts, actions);
        for (const t of textParts.slice(beforeText)) hooks.onEvent?.({ type: 'text', text: t });
        for (const a of actions.slice(beforeActions)) hooks.onEvent?.({ type: 'action', action: a });
      } else if (method === 'turn/completed') {
        const turn = params.turn ?? {};
        if (turnId && turn.id && turn.id !== turnId) return;
        const status: string = turn.status ?? 'unknown';
        if (status === 'completed') {
          hooks.onEvent?.({ type: 'turn-completed', status: 'completed' });
          settleTurn.resolve();
        } else if (status === 'interrupted') {
          hooks.onEvent?.({ type: 'turn-cancelled' });
          settleTurn.reject(new AdapterTurnCancelledError(this.name, threadId));
        } else {
          const detail =
            turn.error?.message ??
            (turn.error ? JSON.stringify(turn.error) : 'no error detail from server');
          hooks.onEvent?.({ type: 'turn-failed', error: detail });
          settleTurn.reject(
            new CodexAdapterError(
              `codex turn ${status} on thread ${threadId}: ${detail}` +
                (status === 'failed'
                  ? ' (if this is an auth failure, run `codex login` first)'
                  : ''),
            ),
          );
        }
      }
    });

    try {
      const turnRes = await transport.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
      });
      turnId = turnRes?.turn?.id ?? turnRes?.turnId ?? null;
      hooks.onTurnStarted?.(turnId);

      await turnDone;
      return { text: textParts.join('\n'), toolCalls: [], actions };
    } finally {
      active = false;
    }
  }

  /**
   * Real account status from the app-server (getAuthStatus + account/read,
   * rate limits when available). Never fabricates: when the server cannot
   * be reached or does not answer, returns reachable:false with the reason.
   */
  async getAccountStatus(): Promise<CodexAccountStatus> {
    let transport: CodexTransport;
    try {
      transport = await this.connect();
    } catch (err) {
      return {
        reachable: false,
        authMethod: null,
        requiresOpenaiAuth: null,
        account: null,
        authenticated: null,
        source: 'none',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    try {
      return await this.withTimeout('account status query', this.readAccountStatus(transport));
    } catch (err) {
      return {
        reachable: false,
        authMethod: null,
        requiresOpenaiAuth: null,
        account: null,
        authenticated: null,
        source: 'none',
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      transport.close();
    }
  }

  private async readAccountStatus(transport: CodexTransport): Promise<CodexAccountStatus> {
    await transport.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null });
    transport.notify('initialized');

    const auth = await transport.request('getAuthStatus', {
      includeToken: false,
      refreshToken: false,
    });

    let account: CodexAccountStatus['account'] = null;
    try {
      const res = await transport.request('account/read', { refreshToken: false });
      const a = res?.account ?? null;
      if (a) {
        account = {
          type: String(a.type),
          email: a.email ?? null,
          planType: a.planType ?? null,
        };
      }
    } catch {
      // account/read is best-effort: getAuthStatus already answered, and a
      // null account honestly means "no account reported" (e.g. logged out).
    }

    let rateLimits: unknown;
    try {
      const res = await transport.request('account/rateLimits/read', {});
      rateLimits = res?.rateLimits ?? res;
    } catch {
      rateLimits = undefined; // Optional per protocol; absence is not an error.
    }

    const requiresOpenaiAuth = auth?.requiresOpenaiAuth ?? null;
    return {
      reachable: true,
      authMethod: auth?.authMethod ?? null,
      requiresOpenaiAuth,
      account,
      // An account was reported → authenticated. None reported while the
      // server demands OpenAI auth → not authenticated. Anything else
      // stays unknown rather than guessed.
      authenticated: account ? true : requiresOpenaiAuth === true ? false : null,
      source: 'live',
      ...(rateLimits !== undefined ? { rateLimits } : {}),
    };
  }

  // ── §26.2 contract: capabilities & quota ────────────────────────────────

  /**
   * §26.2 discoverCapabilities: performs the real initialize handshake
   * (protocol negotiation) and reports what this adapter implements over
   * that protocol. Values are protocol-surface declarations, NOT
   * per-model measurements — see notes; anything the handshake does not
   * establish (e.g. context window) is reported 'unknown'.
   */
  async discoverCapabilities(): Promise<AdapterCapabilities> {
    const transport = await this.connect();
    try {
      const init = await this.withTimeout('initialize', this.initialize(transport));
      return {
        adapter: this.name,
        protocol: {
          name: 'codex-app-server',
          ...(typeof init?.userAgent === 'string' ? { serverInfo: init.userAgent } : {}),
        },
        tools: true,
        structuredOutput: false,
        vision: false,
        reasoning: true,
        streaming: true,
        cancellation: true,
        resume: true,
        maxContext: 'unknown',
        supportedHosts: [this.config.appServerUrl ? 'websocket' : 'local-process'],
        notes: [
          'Declared from the app-server protocol surface this adapter implements ' +
            '(streamed notifications, turn/interrupt, thread/resume); not per-model measurements.',
          'tools: Codex executes tools inside its own sandbox; the factory observes ' +
            'them as actions (AdapterOutput.toolCalls stays []).',
          'vision: this adapter sends text-only turn input. structuredOutput: turns ' +
            'return free text; the protocol subset used here has no structured-output channel.',
          'maxContext is model-dependent and not reported by the initialize ' +
            'handshake — unknown, never guessed.',
        ],
      };
    } finally {
      transport.close();
    }
  }

  /**
   * §26.2 getQuota / §27.1: real quota from account/rateLimits/read.
   * Windows the provider does not report (null) produce NO bucket —
   * an absent measurement, never a fabricated percentage.
   */
  async getQuota(): Promise<AdapterQuota> {
    const collectedAt = Date.now();
    let transport: CodexTransport;
    try {
      transport = await this.connect();
    } catch (err) {
      return {
        collectedAt,
        source: 'none',
        buckets: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    try {
      return await this.withTimeout('quota query', this.readQuota(transport, collectedAt));
    } catch (err) {
      return {
        collectedAt,
        source: 'none',
        buckets: [],
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      transport.close();
    }
  }

  private async readQuota(
    transport: CodexTransport,
    collectedAt: number,
  ): Promise<AdapterQuota> {
    await this.initialize(transport);
    let res: any;
    try {
      res = await transport.request('account/rateLimits/read', {});
    } catch (err) {
      // The server answered the handshake but not the quota query (e.g.
      // not logged in): report live-with-no-data, not a fake snapshot.
      return {
        collectedAt,
        source: 'live',
        buckets: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const rl = res?.rateLimits ?? res ?? {};
    const limitId = typeof rl.limitId === 'string' ? rl.limitId : 'codex';
    const buckets: AdapterQuota['buckets'] = [];
    for (const role of ['primary', 'secondary'] as const) {
      const w = rl[role];
      if (!w || typeof w !== 'object') continue; // null window = not reported
      const usedPct = typeof w.usedPercent === 'number' ? w.usedPercent : null;
      buckets.push({
        id: `${limitId}:${role}`,
        usedPct,
        remainingPct: usedPct !== null ? 100 - usedPct : null,
        windowDurationMins: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
        resetsAt: epochToMs(w.resetsAt),
      });
    }
    return {
      collectedAt,
      source: 'live',
      buckets,
      planType: typeof rl.planType === 'string' ? rl.planType : null,
    };
  }

  // ── §26.2 contract: sessions ────────────────────────────────────────────

  /**
   * §26.2 startSession: a persistent (non-ephemeral) thread on its own
   * connection. Non-ephemeral is deliberate: it is what lets
   * exportCheckpoint/recoverSession reattach later. invoke() stays
   * ephemeral one-shot by contrast.
   */
  async startSession(options: AdapterSessionOptions = {}): Promise<AdapterSession> {
    const transport = await this.connect();
    try {
      await this.withTimeout('initialize', this.initialize(transport));
      const threadId = await this.withTimeout(
        'thread/start',
        this.startThreadWith(transport, options, false),
      );
      const createdAt = Date.now();
      this.sessions.set(threadId, {
        transport,
        threadId,
        createdAt,
        resumed: false,
        events: [],
        turnActive: false,
        activeTurnId: null,
        lastTurnOutcome: null,
        activeDone: null,
        waiters: [],
      });
      return { sessionId: threadId, adapter: this.name, createdAt };
    } catch (err) {
      transport.close();
      throw err;
    }
  }

  private async startThreadWith(
    transport: CodexTransport,
    options: AdapterSessionOptions,
    ephemeral: boolean,
  ): Promise<string> {
    const threadRes = await transport.request('thread/start', {
      model: options.model ?? this.config.model ?? null,
      cwd: options.cwd ?? this.config.cwd ?? null,
      approvalPolicy: this.config.approvalPolicy ?? 'never',
      sandbox: this.config.sandbox ?? 'read-only',
      ephemeral,
    });
    const threadId: string | undefined =
      threadRes?.thread?.id ?? threadRes?.threadId ?? threadRes?.id;
    if (!threadId) {
      throw new CodexAdapterError(
        `codex app-server: thread/start returned no thread id: ${JSON.stringify(threadRes)}`,
      );
    }
    return threadId;
  }

  private session(sessionId: string): CodexSessionState {
    const s = this.sessions.get(sessionId);
    if (!s) {
      throw new CodexAdapterError(
        `codex: unknown session '${sessionId}' (not started here, already closed, or recovered elsewhere)`,
      );
    }
    return s;
  }

  private wake(state: CodexSessionState): void {
    const waiters = state.waiters.splice(0);
    for (const w of waiters) w();
  }

  /** §26.2 runTurn on an open session. */
  async runTurn(sessionId: string, input: AdapterInput): Promise<AdapterOutput> {
    const state = this.session(sessionId);
    if (state.turnActive) {
      throw new CodexAdapterError(
        `codex: a turn is already in flight on session '${sessionId}'`,
      );
    }
    state.events = [];
    state.turnActive = true;
    const run = this.withTimeout(
      'turn',
      this.executeTurn(state.transport, state.threadId, input, {
        onEvent: (e) => {
          state.events.push(e);
          this.wake(state);
        },
        onTurnStarted: (turnId) => {
          state.activeTurnId = turnId;
        },
      }),
    );
    state.activeDone = run.then(
      () => {
        state.lastTurnOutcome = 'completed';
      },
      (err: unknown) => {
        state.lastTurnOutcome =
          err instanceof AdapterTurnCancelledError ? 'cancelled' : 'failed';
      },
    );
    try {
      return await run;
    } finally {
      state.turnActive = false;
      state.activeTurnId = null;
      this.wake(state);
    }
  }

  /** §26.2 streamEvents: the session's current / most recent turn, live while it runs. */
  async *streamEvents(sessionId: string): AsyncIterable<AdapterEvent> {
    const state = this.session(sessionId);
    let idx = 0;
    let sawTerminal = false;
    for (;;) {
      while (idx < state.events.length) {
        const e = state.events[idx++];
        if (e.type.startsWith('turn-')) sawTerminal = true;
        yield e;
      }
      if (sawTerminal || !state.turnActive) return;
      await new Promise<void>((resolve) => state.waiters.push(resolve));
    }
  }

  /**
   * §26.2 cancelTurn: sends turn/interrupt and resolves ONLY when the
   * in-flight turn actually settles as interrupted. A server without
   * turn/interrupt → AdapterUnsupportedError; a turn that ended on its
   * own first → CodexAdapterError. Never a simulated cancellation.
   */
  async cancelTurn(sessionId: string): Promise<void> {
    const state = this.session(sessionId);
    if (!state.turnActive || !state.activeTurnId) {
      throw new CodexAdapterError(
        `codex: no turn in flight on session '${sessionId}' — nothing to cancel`,
      );
    }
    const turnId = state.activeTurnId;
    await this.withTimeout('turn/interrupt', (async () => {
      try {
        await state.transport.request('turn/interrupt', {
          threadId: state.threadId,
          turnId,
        });
      } catch (err) {
        if (isMethodNotFound(err)) {
          throw new AdapterUnsupportedError(
            this.name,
            'cancelTurn',
            `app-server answered method-not-found for turn/interrupt: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        throw err;
      }
      await state.activeDone;
    })());
    if (state.lastTurnOutcome !== 'cancelled') {
      throw new CodexAdapterError(
        `codex: cancel requested on session '${sessionId}', but the turn ended as ` +
          `'${state.lastTurnOutcome ?? 'unknown'}' before the interrupt took effect`,
      );
    }
  }

  /**
   * §26.2 exportCheckpoint: the reattach token for the session — the
   * server-side thread reference plus the configuration it was opened
   * with. Thread state itself stays with the server; nothing about the
   * conversation is invented here.
   */
  async exportCheckpoint(sessionId: string): Promise<AdapterCheckpoint> {
    const state = this.session(sessionId);
    return {
      adapter: this.name,
      version: 1,
      sessionRef: state.threadId,
      exportedAt: Date.now(),
      data: {
        model: this.config.model ?? null,
        cwd: this.config.cwd ?? null,
        sandbox: this.config.sandbox ?? 'read-only',
        approvalPolicy: this.config.approvalPolicy ?? 'never',
        auth: this.config.auth,
        resumed: state.resumed,
      },
    };
  }

  /**
   * §26.2 recoverSession: reattach via thread/resume on a fresh
   * connection. If the server refuses (thread gone), the error
   * propagates — no session is returned, nothing is faked.
   */
  async recoverSession(checkpoint: AdapterCheckpoint): Promise<AdapterSession> {
    if (checkpoint.adapter !== this.name) {
      throw new AdapterUnsupportedError(
        this.name,
        'recoverSession',
        `checkpoint belongs to adapter '${checkpoint.adapter}'`,
      );
    }
    const transport = await this.connect();
    try {
      await this.withTimeout('initialize', this.initialize(transport));
      const res = await this.withTimeout(
        'thread/resume',
        transport.request('thread/resume', { threadId: checkpoint.sessionRef }),
      );
      const threadId: string = res?.thread?.id ?? res?.threadId ?? checkpoint.sessionRef;
      const createdAt = Date.now();
      this.sessions.set(threadId, {
        transport,
        threadId,
        createdAt,
        resumed: true,
        events: [],
        turnActive: false,
        activeTurnId: null,
        lastTurnOutcome: null,
        activeDone: null,
        waiters: [],
      });
      return { sessionId: threadId, adapter: this.name, createdAt, resumed: true };
    } catch (err) {
      transport.close();
      throw err;
    }
  }

  /** §26.2 closeSession: closes the session's connection and forgets it. */
  async closeSession(sessionId: string): Promise<void> {
    const state = this.session(sessionId);
    this.sessions.delete(sessionId);
    state.transport.close();
  }
}

/** Epoch seconds (protocol) → epoch ms; tolerates values already in ms. */
function epochToMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v > 1e12 ? v : v * 1000;
}

/** Did the app-server reject a request as method-not-found (JSON-RPC -32601)? */
function isMethodNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /method not found|unknown method|-32601/i.test(msg);
}

/**
 * Map one completed ThreadItem to output text / observed actions.
 * agentMessage contributes answer text; plan items are recorded as actions
 * (kept out of `text` so the final answer stays clean); every other action
 * item Codex executed in its sandbox becomes an observation record.
 */
function collectItem(item: any, textParts: string[], actions: AdapterAction[]): void {
  switch (item?.type) {
    case 'agentMessage':
      if (typeof item.text === 'string' && item.text) textParts.push(item.text);
      return;
    case 'plan':
      actions.push({ kind: 'plan', summary: String(item.text ?? '') });
      return;
    case 'commandExecution': {
      const exit = item.exitCode === null || item.exitCode === undefined ? '?' : item.exitCode;
      actions.push({
        kind: 'commandExecution',
        summary: `${item.command ?? ''} (status=${item.status ?? '?'}, exit=${exit})`,
      });
      return;
    }
    case 'fileChange': {
      const paths = Array.isArray(item.changes)
        ? item.changes.map((c: any) => c?.path).filter(Boolean).join(', ')
        : '';
      actions.push({
        kind: 'fileChange',
        summary: `${paths || '(no paths reported)'} (status=${item.status ?? '?'})`,
      });
      return;
    }
    case 'mcpToolCall':
      actions.push({ kind: 'mcpToolCall', summary: `${item.server ?? '?'}/${item.tool ?? '?'}` });
      return;
    case 'dynamicToolCall':
      actions.push({
        kind: 'dynamicToolCall',
        summary: item.namespace ? `${item.namespace}/${item.tool ?? '?'}` : String(item.tool ?? '?'),
      });
      return;
    case 'webSearch':
      actions.push({ kind: 'webSearch', summary: String(item.query ?? 'web search') });
      return;
    case 'userMessage':
    case 'hookPrompt':
    case 'reasoning':
      // Not answer text and not an executed action — nothing to record.
      return;
    default:
      // Any other completed item (collabAgentToolCall, imageView, …) is an
      // action Codex performed; record it generically for the evidence chain.
      if (item?.type) actions.push({ kind: String(item.type), summary: String(item.type) });
      return;
  }
}

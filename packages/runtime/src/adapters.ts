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

/** Scripted adapter for tests and demos: replays queued responses in order. */
export class StubAdapter implements RuntimeAdapter {
  readonly name = 'stub';
  private readonly queue: AdapterOutput[];

  constructor(script: AdapterOutput[]) {
    this.queue = [...script];
  }

  async invoke(_input: AdapterInput): Promise<AdapterOutput> {
    const next = this.queue.shift();
    return next ?? { text: '', toolCalls: [] };
  }

  /** How many scripted responses remain. */
  get remaining(): number {
    return this.queue.length;
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
export class CodexAdapter implements RuntimeAdapter {
  readonly name = 'codex';

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
      return await this.withTimeout('turn', this.runTurn(transport, input));
    } finally {
      transport.close();
    }
  }

  private async runTurn(transport: CodexTransport, input: AdapterInput): Promise<AdapterOutput> {
    await transport.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null });
    transport.notify('initialized');

    const threadRes = await transport.request('thread/start', {
      model: this.config.model ?? null,
      cwd: this.config.cwd ?? null,
      approvalPolicy: this.config.approvalPolicy ?? 'never',
      sandbox: this.config.sandbox ?? 'read-only',
      ephemeral: true,
    });
    const threadId: string | undefined =
      threadRes?.thread?.id ?? threadRes?.threadId ?? threadRes?.id;
    if (!threadId) {
      throw new CodexAdapterError(
        `codex app-server: thread/start returned no thread id: ${JSON.stringify(threadRes)}`,
      );
    }

    const textParts: string[] = [];
    const actions: AdapterAction[] = [];
    let turnId: string | null = null;
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
      if (params?.threadId !== threadId) return;
      if (method === 'item/completed' && params.item) {
        collectItem(params.item, textParts, actions);
      } else if (method === 'turn/completed') {
        const turn = params.turn ?? {};
        if (turnId && turn.id && turn.id !== turnId) return;
        const status: string = turn.status ?? 'unknown';
        if (status === 'completed') {
          settleTurn.resolve();
        } else {
          const detail =
            turn.error?.message ??
            (turn.error ? JSON.stringify(turn.error) : 'no error detail from server');
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

    const turnRes = await transport.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: input.prompt, text_elements: [] }],
    });
    turnId = turnRes?.turn?.id ?? turnRes?.turnId ?? null;

    await turnDone;
    return { text: textParts.join('\n'), toolCalls: [], actions };
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

    return {
      reachable: true,
      authMethod: auth?.authMethod ?? null,
      requiresOpenaiAuth: auth?.requiresOpenaiAuth ?? null,
      account,
      ...(rateLimits !== undefined ? { rateLimits } : {}),
    };
  }
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

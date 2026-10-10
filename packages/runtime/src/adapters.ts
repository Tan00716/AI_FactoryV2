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
 * scripted responses for tests and demos; CodexAdapter is a placeholder that
 * holds config and throws a clear AdapterNotImplemented until it is wired to
 * a real Codex app-server (spec §28: ChatGPT OAuth / authorized plan).
 */
import { AdapterNotImplemented } from './types';

export interface AdapterInput {
  prompt: string;
  tools: string[];
}

export interface ToolCall {
  tool: string;
  args: unknown;
}

export interface AdapterOutput {
  text: string;
  toolCalls: ToolCall[];
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
  /** Codex app-server URL, e.g. http://127.0.0.1:18791 */
  appServerUrl?: string;
  /** Auth profile per spec §28 — never force everything onto an API key. */
  auth: 'chatgpt-oauth' | 'api-key';
  account?: string;
}

/**
 * Placeholder for the OpenAI Codex runtime (spec §27–§28). Holds config and
 * fails loudly until invoke() is wired to the Codex app-server with
 * ChatGPT OAuth / authorized-plan auth.
 */
export class CodexAdapter implements RuntimeAdapter {
  readonly name = 'codex';

  constructor(private readonly config: CodexAdapterConfig) {}

  get authKind(): CodexAdapterConfig['auth'] {
    return this.config.auth;
  }

  async invoke(_input: AdapterInput): Promise<AdapterOutput> {
    throw new AdapterNotImplemented(
      `CodexAdapter.invoke() is not implemented in this prototype: wire it to the Codex ` +
        `app-server at ${this.config.appServerUrl ?? '<unset appServerUrl>'} using ` +
        `'${this.config.auth}' auth (spec §28). Until then, use StubAdapter for tests/demos.`,
    );
  }
}

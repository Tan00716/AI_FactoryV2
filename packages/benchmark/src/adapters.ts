/**
 * Adapter selection for the benchmark harness — task 10.
 *
 * `FACTORY_BENCH_ADAPTER` selects the adapter: `stub` (default, scripted,
 * deterministic) or `codex` (real model, zero harness changes needed).
 * Codex wiring is entirely env-driven so real-model onboarding is config,
 * not code:
 *
 *   FACTORY_BENCH_ADAPTER=codex
 *   FACTORY_BENCH_CODEX_AUTH=chatgpt-oauth|api-key   (default: chatgpt-oauth)
 *   FACTORY_BENCH_CODEX_COMMAND=codex               (spawn-mode binary)
 *   FACTORY_BENCH_CODEX_URL=ws://127.0.0.1:PORT     (existing app-server; unset = spawn)
 *   FACTORY_BENCH_CODEX_MODEL=...                   (model override)
 *   FACTORY_BENCH_CODEX_TIMEOUT_MS=...              (default 120000)
 *
 * The stub adapter is wrapped in a measuring decorator that records the
 * prompt characters of every invoke() — the token estimate is computed
 * from measured prompt + output chars, never guessed.
 */
import type {
  AdapterInput,
  AdapterOutput,
  CodexAdapterConfig,
  RuntimeAdapter,
} from '@ai-factory/runtime';
import { CodexAdapter, StubAdapter } from '@ai-factory/runtime';

export type BenchmarkAdapterName = 'stub' | 'codex';

const KNOWN_ADAPTERS: readonly string[] = ['stub', 'codex'];

/** Resolve the adapter name from the environment. Throws on unknown values. */
export function resolveAdapterName(env: NodeJS.ProcessEnv = process.env): BenchmarkAdapterName {
  const raw = (env['FACTORY_BENCH_ADAPTER'] ?? 'stub').trim().toLowerCase();
  if (!KNOWN_ADAPTERS.includes(raw)) {
    throw new Error(
      `unknown benchmark adapter '${raw}' (FACTORY_BENCH_ADAPTER must be one of: ${KNOWN_ADAPTERS.join(', ')})`,
    );
  }
  return raw as BenchmarkAdapterName;
}

export interface MeasuredAdapter {
  adapter: RuntimeAdapter;
  /** Total prompt characters sent across all invoke() calls so far. */
  promptChars(): number;
  /** Total output text characters received across all invoke() calls so far. */
  outputChars(): number;
}

class MeasuringAdapter implements MeasuredAdapter {
  private promptTotal = 0;
  private outputTotal = 0;
  constructor(
    private readonly inner: RuntimeAdapter,
    private readonly onPrompt?: (prompt: string) => void,
  ) {}
  get adapter(): RuntimeAdapter {
    return this;
  }
  get name(): string {
    return this.inner.name;
  }
  async invoke(input: AdapterInput): Promise<AdapterOutput> {
    this.promptTotal += input.prompt.length;
    this.onPrompt?.(input.prompt);
    const out = await this.inner.invoke(input);
    this.outputTotal += out.text.length;
    return out;
  }
  promptChars(): number {
    return this.promptTotal;
  }
  outputChars(): number {
    return this.outputTotal;
  }
}

function codexConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CodexAdapterConfig {
  const auth = (env['FACTORY_BENCH_CODEX_AUTH'] ?? 'chatgpt-oauth').trim().toLowerCase();
  if (auth !== 'chatgpt-oauth' && auth !== 'api-key') {
    throw new Error(
      `FACTORY_BENCH_CODEX_AUTH must be 'chatgpt-oauth' or 'api-key' (got '${auth}')`,
    );
  }
  const timeoutRaw = env['FACTORY_BENCH_CODEX_TIMEOUT_MS'];
  const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`FACTORY_BENCH_CODEX_TIMEOUT_MS must be a positive number (got '${timeoutRaw}')`);
  }
  return {
    auth,
    command: env['FACTORY_BENCH_CODEX_COMMAND']?.trim() || undefined,
    appServerUrl: env['FACTORY_BENCH_CODEX_URL']?.trim() || undefined,
    model: env['FACTORY_BENCH_CODEX_MODEL']?.trim() || undefined,
    timeoutMs,
    // Fail-closed thread defaults from CodexAdapter are kept:
    // sandbox 'read-only', approvalPolicy 'never'.
  };
}

/**
 * Create a measured adapter for one benchmark case. For the stub adapter
 * the scripted responses are replayed in order; for codex the script is
 * ignored and the real model drives the run.
 */
export function createCaseAdapter(
  name: BenchmarkAdapterName,
  script: AdapterOutput[],
  env: NodeJS.ProcessEnv = process.env,
  onPrompt?: (prompt: string) => void,
): MeasuredAdapter {
  const inner: RuntimeAdapter =
    name === 'stub' ? new StubAdapter(script) : new CodexAdapter(codexConfigFromEnv(env));
  return new MeasuringAdapter(inner, onPrompt);
}

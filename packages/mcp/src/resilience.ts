/**
 * @ai-factory/mcp — loss-of-contact chain (§34.4).
 *
 * Spec order: 失联 → classify → bounded retry / circuit breaker →
 * compatible alternative （同授权） → reconcile/continue or escalate.
 *
 * - classify: every failure is tagged with an McpFailureClass
 *   (handshake.ts). Only 'unreachable' and 'timeout' are retried by
 *   default: those mean the request almost certainly never executed.
 *   'protocol' / 'tool' failures may already have had side effects,
 *   and §34.4 says unknown side effects are NOT auto-retried.
 * - bounded retry: attempts are capped and delays back off
 *   exponentially up to a ceiling — never an unbounded loop.
 * - circuit breaker: after N consecutive failures the circuit opens
 *   and calls fail fast; after a cooldown a single half-open probe is
 *   allowed through; its success closes the circuit, its failure
 *   re-opens it.
 * - compatible alternative: when a call cannot proceed, other
 *   installed + enabled servers covering the needed tools under the
 *   SAME authorization scope are SUGGESTED. Nothing is switched
 *   automatically — §34.4's chain ends in reconcile/continue or
 *   escalate, so the outcome flags `escalated` for the caller.
 */
import { McpRegistry } from './registry';
import { McpManager } from './security';
import { classifyMcpError } from './handshake';
import { Clock, McpFailureClass, ScopeRef, TrustLevel } from './types';

/* ------------------------------------------------------------ breaker -- */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** consecutive failures that open the circuit (default 3) */
  failureThreshold?: number;
  /** how long the circuit stays open before a probe is allowed (default 30s) */
  cooldownMs?: number;
  clock?: Clock;
}

export interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureClass?: McpFailureClass;
  lastFailureAt?: number;
  openedAt?: number;
  /** when the next half-open probe becomes allowed (state OPEN only) */
  nextProbeAt?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastFailureClass?: McpFailureClass;
  private lastFailureAt?: number;
  private openedAt?: number;
  private probeInFlight = false;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly clock: Clock;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.clock = opts.clock ?? { now: () => Date.now() };
  }

  snapshot(): CircuitSnapshot {
    this.refresh();
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureClass: this.lastFailureClass,
      lastFailureAt: this.lastFailureAt,
      openedAt: this.openedAt,
      nextProbeAt: this.state === 'OPEN' && this.openedAt !== undefined ? this.openedAt + this.cooldownMs : undefined,
    };
  }

  /**
   * May a call proceed right now? In HALF_OPEN exactly one probe is
   * admitted; further calls wait for its verdict.
   */
  canExecute(): boolean {
    this.refresh();
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') return false;
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): CircuitSnapshot {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
    this.openedAt = undefined;
    return this.snapshot();
  }

  recordFailure(failureClass: McpFailureClass): CircuitSnapshot {
    const now = this.clock.now();
    this.consecutiveFailures += 1;
    this.lastFailureClass = failureClass;
    this.lastFailureAt = now;
    this.probeInFlight = false;
    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.threshold) {
      this.state = 'OPEN';
      this.openedAt = now;
    }
    return this.snapshot();
  }

  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastFailureClass = undefined;
    this.lastFailureAt = undefined;
    this.openedAt = undefined;
    this.probeInFlight = false;
  }

  private refresh(): void {
    if (this.state === 'OPEN' && this.openedAt !== undefined && this.clock.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'HALF_OPEN';
      this.probeInFlight = false;
    }
  }
}

/* -------------------------------------------------------------- retry -- */

export interface RetryPolicy {
  /** total attempts including the first (default 3) — the bound in "bounded retry" */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** failure classes worth retrying (default: unreachable, timeout — see header) */
  retryableClasses?: readonly McpFailureClass[];
}

export const DEFAULT_RETRYABLE_CLASSES: readonly McpFailureClass[] = ['unreachable', 'timeout'];

export type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` with bounded retries. A failure is retried only while its
 * §34.4 class is retryable and attempts remain; the delay before
 * attempt n+1 is min(base · 2^(n-1), max). The final error is rethrown
 * untouched so callers can classify/record it themselves.
 */
export async function withBoundedRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = {},
  sleep: SleepFn = realSleep,
): Promise<T> {
  const maxAttempts = Math.max(1, policy.maxAttempts ?? 3);
  const base = policy.baseDelayMs ?? 100;
  const cap = policy.maxDelayMs ?? 5_000;
  const retryable = policy.retryableClasses ?? DEFAULT_RETRYABLE_CLASSES;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (err) {
      const cls = classifyMcpError(err, 'execution');
      if (attempt >= maxAttempts || !retryable.includes(cls)) throw err;
      await sleep(Math.min(base * 2 ** (attempt - 1), cap));
    }
  }
}

/* -------------------------------------------------------- alternative -- */

export interface AlternativeRequest {
  /** the server that failed (excluded from its own suggestions) */
  failedServer: string;
  failedVersion?: string;
  /** tools the caller needs the alternative to cover */
  requiredTools: string[];
  /** authorization scopes the alternative must be enabled under — the SAME authorization (§34.4) */
  scopes?: ScopeRef[];
}

export interface AlternativeSuggestion {
  name: string;
  version: string;
  trustLevel: TrustLevel;
  coversTools: string[];
  missingTools: string[];
  /** true when every required tool is covered */
  fullCoverage: boolean;
}

/**
 * Suggest compatible alternatives for a failed server. Candidates must
 * be installed and enabled under the same scopes, and are ranked:
 * full coverage first, then higher trust, then name/version for
 * determinism. Suggestions only — this never rebinds a call.
 */
export function findCompatibleAlternatives(
  registry: McpRegistry,
  manager: McpManager,
  req: AlternativeRequest,
): AlternativeSuggestion[] {
  const out: AlternativeSuggestion[] = [];
  for (const install of manager.listInstalls()) {
    if (install.status !== 'INSTALLED') continue;
    if (install.name === req.failedServer && (req.failedVersion === undefined || install.version === req.failedVersion)) {
      continue;
    }
    if (!manager.isEnabled(install.name, install.version, req.scopes ?? [])) continue;
    const server = registry.get(install.name, install.version);
    if (!server) continue;
    const provided = new Set(server.tools.map((t) => t.name));
    const coversTools = req.requiredTools.filter((t) => provided.has(t));
    const missingTools = req.requiredTools.filter((t) => !provided.has(t));
    if (coversTools.length === 0 && req.requiredTools.length > 0) continue;
    out.push({
      name: install.name,
      version: install.version,
      trustLevel: server.trustLevel,
      coversTools,
      missingTools,
      fullCoverage: missingTools.length === 0,
    });
  }
  const trustRank: Record<TrustLevel, number> = { VERIFIED: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };
  out.sort(
    (a, b) =>
      Number(b.fullCoverage) - Number(a.fullCoverage) ||
      trustRank[a.trustLevel] - trustRank[b.trustLevel] ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1),
  );
  return out;
}

/* ----------------------------------------------------- resilient call -- */

export interface ResilientCallOutcome<T> {
  ok: boolean;
  value?: T;
  /** how many times the operation actually ran (0 when the open circuit refused it) */
  attempts: number;
  failureClass?: McpFailureClass;
  error?: string;
  circuit: CircuitSnapshot;
  /** compatible alternatives under the same authorization, when the call failed */
  alternatives: AlternativeSuggestion[];
  /** true when the §34.4 chain is exhausted — the caller must reconcile or escalate */
  escalated: boolean;
}

export interface McpResilienceOptions {
  registry: McpRegistry;
  manager: McpManager;
  breaker?: CircuitBreakerOptions;
  retry?: RetryPolicy;
  sleep?: SleepFn;
}

/**
 * Per-server circuit breakers + the §34.4 execute chain. One breaker
 * per (name, version); state is inspectable via breakerFor()/snapshot.
 */
export class McpResilience {
  private breakers = new Map<string, CircuitBreaker>();
  private readonly registry: McpRegistry;
  private readonly manager: McpManager;
  private readonly breakerOpts: CircuitBreakerOptions;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep?: SleepFn;

  constructor(opts: McpResilienceOptions) {
    this.registry = opts.registry;
    this.manager = opts.manager;
    this.breakerOpts = opts.breaker ?? {};
    this.retryPolicy = opts.retry ?? {};
    this.sleep = opts.sleep;
  }

  breakerFor(name: string, version: string): CircuitBreaker {
    const k = `${name}@${version}`;
    let b = this.breakers.get(k);
    if (!b) {
      b = new CircuitBreaker(this.breakerOpts);
      this.breakers.set(k, b);
    }
    return b;
  }

  /**
   * Execute one operation against a server under its circuit breaker
   * and the bounded-retry policy. Never throws for operational
   * failures — they come back as an outcome with the failure class,
   * the breaker state, alternative suggestions and the escalate flag.
   */
  async execute<T>(
    ref: { name: string; version: string },
    fn: (attempt: number) => Promise<T>,
    alt?: Omit<AlternativeRequest, 'failedServer' | 'failedVersion'>,
  ): Promise<ResilientCallOutcome<T>> {
    const breaker = this.breakerFor(ref.name, ref.version);
    const alternatives = () =>
      findCompatibleAlternatives(this.registry, this.manager, {
        failedServer: ref.name,
        failedVersion: ref.version,
        requiredTools: alt?.requiredTools ?? [],
        scopes: alt?.scopes,
      });

    if (!breaker.canExecute()) {
      const snap = breaker.snapshot();
      return {
        ok: false,
        attempts: 0,
        failureClass: snap.lastFailureClass,
        error: `circuit OPEN for ${ref.name}@${ref.version} — call refused without executing (probe allowed at ${snap.nextProbeAt})`,
        circuit: snap,
        alternatives: alternatives(),
        escalated: true,
      };
    }

    let attempts = 0;
    try {
      const value = await withBoundedRetry(
        async (a) => {
          attempts = a;
          return fn(a);
        },
        this.retryPolicy,
        this.sleep,
      );
      return {
        ok: true,
        value,
        attempts,
        circuit: breaker.recordSuccess(),
        alternatives: [],
        escalated: false,
      };
    } catch (err) {
      const cls = classifyMcpError(err, 'execution');
      const snap = breaker.recordFailure(cls);
      return {
        ok: false,
        attempts,
        failureClass: cls,
        error: err instanceof Error ? err.message : String(err),
        circuit: snap,
        alternatives: alternatives(),
        escalated: true,
      };
    }
  }
}

/**
 * Harness — spec §26 (Harness Engineering).
 *
 * The persistent harness around every agent. Responsibilities implemented
 * here: tool routing with permission checks (denials throw PermissionDenied
 * and are audited via callback), filesystem boundary enforcement, per-step
 * timeouts, evidence collection (forwarded to the caller's EvidenceSink —
 * the runtime never mutates core's evidence store itself), and tracing.
 *
 * The model never directly owns critical workflow control: every tool call
 * passes through this harness.
 *
 * Execution-surface contract (Batch 21): this is the §26 AGENT execution
 * surface (name-based, Permission-gated, step intents, budget, retry,
 * trace/evidence). The §33 AUDITED DIRECT execution surface is the
 * ToolExecutor in @ai-factory/tools (capability grants, approval gates,
 * input-schema validation, idempotency, exit-code-truth records,
 * implementation gate). The two stay separate by design — see
 * apps/server/src/tool-runner.ts for the layering rationale and the
 * shared command policy.
 */
import * as path from 'node:path';
import type { Permission } from '@ai-factory/core';
import {
  Clock,
  EvidenceInput,
  EvidenceRecord,
  EvidenceSink,
  FilesystemBoundary,
  PermissionDenied,
  StepTimeout,
  systemClock,
  TraceStep,
} from './types';
import type { StepIntentStore } from './durable';
import {
  BudgetTracker,
  RetryPolicy,
  withRetryBudget,
} from './limits';
import {
  assertNoPermissionBypass,
  classifyFailure,
  isAutoRetryAllowed,
} from './failures';

export interface AuditEvent {
  t: number;
  action: string;
  detail: string;
}

export interface HarnessOptions {
  /** Filesystem roots the agent may touch; everything else is denied. */
  allowedRoots: string[];
  /** Per-step timeout in ms, applied to tool and adapter calls. */
  stepTimeoutMs: number;
  /** The agent's granted capability permissions (core Permission type). */
  permissions: Permission[];
  /** Override/extend the default tool → permission mapping. */
  toolPermissions?: Record<string, Permission>;
  clock?: Clock;
  /** Caller's evidence store — the runtime only appends via this interface. */
  evidence: EvidenceSink;
  /** Audit callback; every denial is reported here. */
  onAudit?: (event: AuditEvent) => void;
  onTrace?: (step: TraceStep) => void;
  /**
   * SPEC v2 §28.1 — when provided, the tool-call intent is persisted BEFORE
   * the permission gate and before execution; the outcome is committed
   * after (EXECUTED / FAILED, or DENIED when the gate refuses the call —
   * a refusal is a recorded intent, never a silent absence).
   * Absent → legacy behavior.
   */
  intentStore?: StepIntentStore;
  /** Run id stamped onto persisted intents. */
  runId?: string;
  /**
   * SPEC v2 §25 (G-51/G-52) — extended budget tracker. When attached,
   * every tool-call ATTEMPT consumes one tool call; exceeding
   * maxToolCalls throws BudgetExceeded. runAgent attaches the run's
   * tracker automatically; direct Harness users may pass their own.
   */
  budgetTracker?: BudgetTracker;
  /**
   * §25 (G-52) — jittered retry for tool execution. When set, transient
   * failures are retried via withRetryBudget(): attempts are bounded by
   * BOTH policy.maxAttempts (derived from maxRetries by runAgent) and
   * policy.totalBudgetMs. Permission denials are never retried — the
   * no-bypass guard (failures.ts) turns a retry attempt after a denial
   * into a loud PermissionBypassAttempt. Absent → single attempt (legacy).
   */
  toolRetryPolicy?: RetryPolicy;
  /** Injectable randomness for retry jitter (deterministic tests). */
  retryRand?: () => number;
  /** Injectable sleep for retry backoff (deterministic tests). */
  retrySleep?: (ms: number) => Promise<void>;
}

/** Default mapping from tool name to the core Permission it requires. */
export const DEFAULT_TOOL_PERMISSIONS: Record<string, Permission> = {
  read: 'filesystem.read',
  write: 'filesystem.write',
  delete: 'filesystem.delete',
  shell: 'shell.execute',
  commit: 'git.commit',
  push: 'git.push',
  pull_request: 'github.pull_request',
};

export type ToolImpl = (args: unknown) => Promise<unknown> | unknown;

/**
 * §33 — empty tool-result predicate.
 *
 * A tool that returns "nothing" has NOT produced the effect or data a
 * successful result implies, so an empty result must never be sealed as
 * a plain success (the tools package makes the same distinction with its
 * EMPTY_RESULT outcome; the harness walks an independent ToolImpl path
 * and needs its own predicate). Empty is judged on the RAW result value:
 *
 *   EMPTY:     undefined · null · a string that is blank after trim ·
 *              a zero-length array · an object with no own enumerable
 *              keys (a Map/Set with size 0 counts as an empty object).
 *   NOT EMPTY: everything else — crucially 0 and false are REAL results
 *              (a count of zero, a boolean answer), never "empty"; NaN,
 *              non-blank strings, non-empty arrays/objects likewise.
 *
 * Empty is not an error: the run continues, nothing is retried — only
 * the evidence and intent records stop claiming an unqualified success.
 */
export function isEmptyToolResult(result: unknown): boolean {
  if (result === undefined || result === null) return true;
  if (typeof result === 'string') return result.trim().length === 0;
  if (Array.isArray(result)) return result.length === 0;
  if (result instanceof Map || result instanceof Set) return result.size === 0;
  if (typeof result === 'object') return Object.keys(result).length === 0;
  return false;
}

export class Harness {
  readonly allowedRoots: string[];
  private readonly options: HarnessOptions;
  private readonly clock: Clock;
  private readonly evidenceLog: EvidenceRecord[] = [];
  private readonly traceLog: TraceStep[] = [];
  private budgetTracker?: BudgetTracker;
  private toolRetryPolicy?: RetryPolicy;
  private stepIntentStore?: StepIntentStore;

  constructor(options: HarnessOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.allowedRoots = options.allowedRoots.map((r) => path.resolve(r));
    this.budgetTracker = options.budgetTracker;
    this.toolRetryPolicy = options.toolRetryPolicy;
    this.stepIntentStore = options.intentStore;
  }

  /** The attached extended-budget tracker, if any (§25). */
  get tracker(): BudgetTracker | undefined {
    return this.budgetTracker;
  }

  /** The attached step-intent store, if any (§28.1). */
  get intentStore(): StepIntentStore | undefined {
    return this.stepIntentStore;
  }

  /**
   * §28.1 (G-53) — attach the run's StepIntentStore after construction.
   * Used by runAgent so caller-supplied harnesses join the run's intent
   * log. No-op when a store is already attached: a store the harness was
   * constructed with wins — same rule as attachBudgetTracker.
   */
  attachIntentStore(store: StepIntentStore): void {
    if (!this.stepIntentStore) this.stepIntentStore = store;
  }

  /**
   * §25 (G-51/G-52) — attach the run's BudgetTracker (and, unless one was
   * configured, its tool retry policy) after construction. Used by
   * runAgent so caller-supplied harnesses join the run's accounting.
   * No-op for slots already filled.
   */
  attachBudgetTracker(tracker: BudgetTracker, retryPolicy?: RetryPolicy): void {
    if (!this.budgetTracker) this.budgetTracker = tracker;
    if (!this.toolRetryPolicy && retryPolicy) this.toolRetryPolicy = retryPolicy;
  }

  /** Drain internally recorded trace steps (also forwarded to onTrace). */
  drainTrace(): TraceStep[] {
    const out = [...this.traceLog];
    this.traceLog.length = 0;
    return out;
  }

  /** Drain evidence collected through this harness. */
  drainEvidence(): EvidenceRecord[] {
    const out = [...this.evidenceLog];
    this.evidenceLog.length = 0;
    return out;
  }

  /** §26 Permissions — deny (and audit) when the agent lacks the permission. */
  checkPermission(tool: string): void {
    const required = { ...DEFAULT_TOOL_PERMISSIONS, ...this.options.toolPermissions }[tool];
    if (!required) {
      this.audit('permission.denied', `unknown tool '${tool}'`);
      throw new PermissionDenied(tool, 'unknown tool — default deny');
    }
    if (!this.options.permissions.includes(required)) {
      this.audit('permission.denied', `tool '${tool}' requires '${required}'`);
      throw new PermissionDenied(tool, `missing permission '${required}'`);
    }
    this.audit('permission.granted', `tool '${tool}' (${required})`);
  }

  /**
   * §26 Filesystem Boundary — resolve the path and require it to sit inside
   * one of the allowed roots. The `path.sep` check blocks the classic
   * sibling-prefix escape (e.g. root /a/ws vs /a/ws-evil).
   */
  assertWithinRoot(p: string): string {
    const resolved = path.resolve(p);
    const ok = this.allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );
    if (!ok) {
      this.audit('filesystem.denied', resolved);
      throw new FilesystemBoundary(resolved);
    }
    return resolved;
  }

  /** §26 Timeout — race the step against the per-step budget. */
  async withTimeout<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const ms = this.options.stepTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StepTimeout(label, ms)), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * §26 Tool Routing — permission check, timeout, evidence, tracing.
   * Denials throw PermissionDenied and are audited.
   *
   * §28.1: the step intent is persisted BEFORE the permission check, so
   * a denied call still leaves an intent record — committed DENIED via
   * recordDenied(), with the tool never invoked.
   *
   * §25 (G-51/G-52): when a BudgetTracker is attached each attempt
   * consumes a tool call; when a retry policy is configured, transient
   * failures retry with jitter inside a total budget — bounded by both
   * maxAttempts and totalBudgetMs — and a retry after a permission
   * denial trips assertNoPermissionBypass (loud, never a workaround).
   *
   * §33: a tool that returns an empty result (see isEmptyToolResult) is
   * not an error, but its evidence and intent records are marked
   * `empty: true` — "nothing came back" is never sealed as a plain ok.
   */
  async runTool(name: string, args: unknown, impl: ToolImpl): Promise<unknown> {
    // §28.1 — persist the intent BEFORE the permission gate, not just
    // before execution: a denied call is an intent too, and reconciliation
    // (§28.1 startup scan) must see it. The gate's refusal commits the
    // intent as DENIED below — never EXECUTED, never left PENDING (a
    // leftover PENDING would be misreported as an interrupted execution).
    const intent = this.stepIntentStore?.persistIntent(
      this.options.runId ?? 'unknown-run',
      name,
      args,
    );
    try {
      this.checkPermission(name);
    } catch (err) {
      if (intent && err instanceof PermissionDenied) {
        this.stepIntentStore?.recordDenied(intent.id, err.message);
      }
      throw err;
    }
    this.trace('HARNESS', `tool:${name}`, 'start');
    const attempt = async (): Promise<unknown> => {
      // §25 (G-51): every real execution attempt counts against the
      // tool-call budget; exceeding it throws BudgetExceeded.
      this.budgetTracker?.consumeToolCall();
      return this.withTimeout(`tool:${name}`, async () => impl(args));
    };
    try {
      const result = this.toolRetryPolicy
        ? await withRetryBudget(attempt, {
            policy: this.toolRetryPolicy,
            clock: this.clock,
            ...(this.options.retryRand ? { rand: this.options.retryRand } : {}),
            ...(this.options.retrySleep ? { sleep: this.options.retrySleep } : {}),
            isRetryable: (err: unknown) => {
              const kind = classifyFailure(err);
              // §25 guard: choosing to retry after a permission denial
              // IS a bypass attempt — throws PermissionBypassAttempt.
              assertNoPermissionBypass(kind, `retry tool '${name}'`);
              return isAutoRetryAllowed(kind);
            },
          })
        : await attempt();
      // §33 — an empty result is not an error (the run continues, the
      // tool is not retried), but it is not a substantive success either:
      // the evidence says so in its title and payload, and the intent's
      // committed result carries `empty: true` so its resultHash commits
      // to the empty outcome instead of a plain { ok: true }.
      const empty = isEmptyToolResult(result);
      if (intent) {
        this.stepIntentStore?.recordResult(
          intent.id,
          true,
          empty ? { ok: true, empty: true } : { ok: true },
        );
      }
      this.collectEvidence({
        type: 'tool_result',
        title: empty ? `tool ${name} returned empty` : `tool ${name} ok`,
        payload: empty
          ? { tool: name, ok: true, empty: true }
          : { tool: name, ok: true },
      });
      this.trace('HARNESS', `tool:${name}`, empty ? 'ok (empty)' : 'ok');
      return result;
    } catch (err) {
      if (intent) this.stepIntentStore?.recordResult(intent.id, false, { ok: false });
      const message = err instanceof Error ? err.message : String(err);
      this.audit('tool.failed', `${name}: ${message}`);
      this.trace('HARNESS', `tool:${name}`, `fail: ${message}`);
      throw err;
    }
  }

  /** §26 Evidence Collection — forwarded to the caller's sink. */
  collectEvidence(evidence: EvidenceInput): void {
    const record: EvidenceRecord = { ...evidence, t: this.clock.now() };
    this.evidenceLog.push(record);
    this.options.evidence.collect(evidence);
  }

  private audit(action: string, detail: string): void {
    this.options.onAudit?.({ t: this.clock.now(), action, detail });
  }

  private trace(phase: string, action: string, result: string): void {
    const step: TraceStep = { t: this.clock.now(), phase, action, result };
    this.traceLog.push(step);
    this.options.onTrace?.(step);
  }
}

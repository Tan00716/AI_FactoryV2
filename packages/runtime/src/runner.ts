/**
 * runAgent — assembles one agent run: model routing (§27–§30), the agent loop
 * (§24–§25), the harness (§26), and a runtime adapter (§27).
 *
 * Callers may supply their own StepFn to script loop behavior (tests, demos);
 * otherwise a default StepFn drives the loop through the adapter: OBSERVE
 * assembles context, ACT invokes the adapter and routes each tool call through
 * the harness (permission check + timeout + evidence), VERIFY checks the tool
 * results, EVALUATE completes.
 */
import type { Agent, Task } from '@ai-factory/core';
import { route, type RouteDecision, type RouteRequest } from '@ai-factory/model-router';
import { AgentLoop } from './loop';
import { Harness, type ToolImpl } from './harness';
import type { RuntimeAdapter } from './adapters';
import {
  BudgetExceeded,
  Clock,
  EvidenceRecord,
  FactoryError,
  LoopPhase,
  LoopStagnation,
  PhaseResult,
  RunResult,
  StepFn,
  TraceStep,
  systemClock,
} from './types';
import {
  BudgetTracker,
  DEFAULT_EXTENDED_BUDGETS,
  type ExtendedBudgets,
  type RetryPolicy,
} from './limits';
import { StepIntentStore } from './durable';

export interface RunAgentOptions {
  agent: Agent;
  task: Task;
  harness: Harness;
  adapter: RuntimeAdapter;
  /** Defaults to a fresh AgentLoop with modest budgets. */
  loop?: AgentLoop;
  /** Scripted behavior; defaults to the adapter-driven StepFn below. */
  stepFn?: StepFn;
  /** When provided, the run is routed through @ai-factory/model-router. */
  routeRequest?: RouteRequest;
  /** Tool implementations available to the default StepFn's ACT phase. */
  tools?: Record<string, ToolImpl>;
  clock?: Clock;
  /**
   * §25 (G-51) — extended budgets for this run. Any field omitted takes
   * the DEFAULT_EXTENDED_BUDGETS value from limits.ts: the default path
   * wires ALL 8 limits into one BudgetTracker (steps, wall time, retries,
   * model calls, tool calls, repair loops, context chars, no-progress
   * steps) — not just steps/time/retries as before.
   */
  extendedBudgets?: Partial<ExtendedBudgets>;
  /** Pre-built tracker (tests / advanced callers); wins over extendedBudgets. */
  budgetTracker?: BudgetTracker;
  /**
   * §28.1 (G-53) — step-intent store for this run. When omitted, runAgent
   * creates one and attaches it to the harness, so tool-call intents are
   * persisted BEFORE execution on the default path too (previously the
   * store existed but no run path ever supplied one). A store the
   * harness was constructed with wins over this option — same priority
   * rule as budgetTracker.
   */
  intentStore?: StepIntentStore;
}

function buildPrompt(agent: Agent, task: Task): string {
  return [
    `You are ${agent.name} (${agent.jobTitle}).`,
    `Mission: ${agent.mission}`,
    `Task: ${task.title}`,
    `Goal: ${task.goal}`,
    `Acceptance criteria: ${task.acceptanceCriteria.join('; ') || 'none'}`,
  ].join('\n');
}

interface DefaultStepContext {
  agent: Agent;
  task: Task;
  harness: Harness;
  adapter: RuntimeAdapter;
  tools: Record<string, ToolImpl>;
  routing?: RouteDecision;
  /** §25 — the run's extended-budget tracker (all 8 limits). */
  tracker: BudgetTracker;
}

/** Adapter-driven StepFn used when the caller does not script behavior. */
function defaultStepFn(ctx: DefaultStepContext): StepFn {
  const { agent, task, harness, adapter, tools, routing, tracker } = ctx;
  let adapterNote = '';

  return async (phase: LoopPhase): Promise<PhaseResult> => {
    switch (phase) {
      case 'OBSERVE': {
        // §25 (G-51): the assembled context counts against maxContextChars.
        tracker.checkContext(buildPrompt(agent, task).length);
        harness.collectEvidence({
          type: 'context',
          title: 'context assembled',
          payload: {
            agentId: agent.id,
            taskId: task.id,
            model: routing?.primary?.model ?? adapter.name,
          },
        });
        return { ok: true, note: `observing task ${task.id}` };
      }

      case 'UNDERSTAND':
        return { ok: true, note: `goal: ${task.goal.slice(0, 120)}` };

      case 'PLAN':
        return {
          ok: true,
          note: `plan via ${routing?.primary?.model ?? adapter.name}`,
        };

      case 'ACT': {
        // §25 (G-51): every adapter invocation is a model call; exceeding
        // maxModelCalls throws BudgetExceeded OUT of the StepFn (the loop
        // treats BUDGET_EXCEEDED as terminal — never retried into success).
        tracker.consumeModelCall();
        let output;
        try {
          output = await harness.withTimeout('adapter.invoke', () =>
            adapter.invoke({ prompt: buildPrompt(agent, task), tools: Object.keys(tools) }),
          );
        } catch (err) {
          if (err instanceof BudgetExceeded) throw err;
          const message = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            error: `adapter invoke failed: ${message}`,
            errorSignature: `adapter:${adapter.name}:fail`,
            note: 'adapter failed',
          };
        }
        adapterNote = output.text.slice(0, 120);
        for (const tc of output.toolCalls) {
          const impl = tools[tc.tool];
          if (!impl) {
            return {
              ok: false,
              error: `unknown tool '${tc.tool}' requested by adapter`,
              errorSignature: 'adapter:unknown-tool',
            };
          }
          try {
            await harness.runTool(tc.tool, tc.args, impl);
          } catch (err) {
            // §25: budget exhaustion and bypass attempts are terminal —
            // rethrow so the run fails/escalates explicitly instead of
            // looping until an unrelated stagnation/retry limit fires.
            if (err instanceof BudgetExceeded) throw err;
            if (err instanceof Error && (err as { code?: string }).code === 'PERMISSION_BYPASS_ATTEMPT') throw err;
            const message = err instanceof Error ? err.message : String(err);
            return {
              ok: false,
              error: `tool '${tc.tool}' failed: ${message}`,
              errorSignature: `tool:${tc.tool}:fail`,
            };
          }
        }
        return { ok: true, note: `${output.toolCalls.length} tool call(s)` };
      }

      case 'VERIFY':
        harness.collectEvidence({
          type: 'verify',
          title: 'verification passed',
          payload: { note: adapterNote },
        });
        return { ok: true, note: 'verified' };

      case 'EVALUATE':
        return { ok: true, decision: 'COMPLETE', note: 'task complete' };
    }
  };
}

export async function runAgent(options: RunAgentOptions): Promise<RunResult> {
  const { agent, task, harness, adapter } = options;
  const clock: Clock = options.clock ?? systemClock;

  const trace: TraceStep[] = [];
  const evidence: EvidenceRecord[] = [];
  const handoffs: string[] = [];
  const pushTrace = (phase: string, action: string, result: string): void => {
    trace.push({ t: clock.now(), phase, action, result });
  };

  // §27: Agent → Model Router → Runtime Adapter.
  let routing: RouteDecision | undefined;
  if (options.routeRequest) {
    routing = route(options.routeRequest);
    evidence.push({
      t: clock.now(),
      type: 'model_routing',
      title: 'model routing decision',
      payload: {
        primary: routing.primary?.model ?? null,
        fallback: routing.fallback?.model ?? null,
        emergency: routing.emergency?.model ?? null,
        unavailable: routing.unavailable,
        reason: routing.reason,
      },
    });
    // INV-29: report unavailability explicitly — never simulate success with
    // an unsuitable model.
    if (routing.unavailable || routing.primary === null) {
      throw new Error(`no model available for route request: ${routing.reason}`);
    }
    pushTrace('RUNNER', 'model routing', `primary=${routing.primary.model}`);
  }

  // §25 (G-51): ONE BudgetTracker for the whole run, built from all 8
  // extended limits (defaults from limits.ts DEFAULT_EXTENDED_BUDGETS).
  // If the caller's harness already carries a tracker it wins, so tool
  // accounting and loop accounting can never diverge.
  const budgets: ExtendedBudgets = { ...DEFAULT_EXTENDED_BUDGETS, ...options.extendedBudgets };
  const tracker: BudgetTracker =
    options.budgetTracker ?? harness.tracker ?? new BudgetTracker(budgets, clock);
  // Tool retries (§25 G-52): bounded by maxRetries (attempts = retries + 1)
  // AND by a total budget equal to the run's wall-time budget.
  const toolRetryPolicy: RetryPolicy = {
    maxAttempts: budgets.maxRetries + 1,
    baseMs: 100,
    capMs: 1_000,
    totalBudgetMs: budgets.maxWallTimeMs,
  };
  harness.attachBudgetTracker(tracker, toolRetryPolicy);

  // §28.1 (G-53): ONE StepIntentStore for the whole run. Priority mirrors
  // the BudgetTracker rule above: an explicitly passed store wins over
  // the default, and a store the harness was constructed with wins over
  // both (attachIntentStore is a no-op then). The summary is read back
  // from the harness's EFFECTIVE store, so it can never diverge from
  // what Harness.runTool actually wrote. The default store created here
  // is the in-memory StepIntentStore; the server injects the SQLite-backed
  // SqliteStepIntentStore (packages/db, G-59), so on the server path
  // intents persist across restarts and the startup scan reports
  // interrupted ones (see docs/KNOWN_LIMITATIONS.md).
  const intentStore: StepIntentStore =
    options.intentStore ?? harness.intentStore ?? new StepIntentStore(clock);
  harness.attachIntentStore(intentStore);
  const effectiveIntentStore: StepIntentStore = harness.intentStore ?? intentStore;
  const intentIdsBefore = new Set(effectiveIntentStore.listIntents().map((i) => i.id));
  const intentSummary = (): RunResult['intentSummary'] => {
    const mine = effectiveIntentStore
      .listIntents()
      .filter((i) => !intentIdsBefore.has(i.id));
    return {
      count: mine.length,
      intentIds: mine.map((i) => i.id),
      executed: mine.filter((i) => i.status === 'EXECUTED').length,
      failed: mine.filter((i) => i.status === 'FAILED').length,
      pending: mine.filter((i) => i.status === 'PENDING').length,
      // §28.1 — permission-denied calls are their own bucket: the tool
      // never ran, so they are neither executed nor failed executions.
      denied: mine.filter((i) => i.status === 'DENIED').length,
    };
  };

  const loop =
    options.loop ??
    new AgentLoop({
      budgets: {
        maxSteps: budgets.maxSteps,
        timeMs: budgets.maxWallTimeMs,
        maxRetries: budgets.maxRetries,
      },
      clock,
      budgetTracker: tracker,
    });
  if (options.loop) options.loop.attachBudgetTracker(tracker);
  const stepFn =
    options.stepFn ??
    defaultStepFn({
      agent,
      task,
      harness,
      adapter,
      tools: options.tools ?? {},
      routing,
      tracker,
    });

  pushTrace('RUNNER', 'run start', `agent=${agent.id} task=${task.id} adapter=${adapter.name}`);

  try {
    const outcome = await loop.run(stepFn);
    trace.push(...outcome.trace);
    trace.push(...harness.drainTrace());
    evidence.push(...harness.drainEvidence());
    if (outcome.handoffTo) handoffs.push(outcome.handoffTo);
    const runOutcome = outcome.decision === 'ESCALATE' ? 'escalated' : 'completed';
    pushTrace('RUNNER', 'run end', `${outcome.decision} after ${outcome.steps} steps`);
    return {
      outcome: runOutcome,
      steps: outcome.steps,
      evidence,
      handoffs,
      trace,
      reason: `loop decision: ${outcome.decision}`,
      budgetUsage: tracker.usage,
      intentSummary: intentSummary(),
    };
  } catch (err) {
    // Recover the partial loop trace when run() threw (budget/stagnation).
    trace.push(...loop.trace);
    trace.push(...harness.drainTrace());
    evidence.push(...harness.drainEvidence());
    const steps = loop.snapshot.totalSteps;
    // Batch 38 — carry the machine-readable error code through so the
    // server can classify §81 emissions determinately (BUDGET_EXCEEDED →
    // 'budget-exceeded', LOOP_STAGNATION → 'repeated-failure') instead of
    // matching on the human-readable message.
    const reasonCode = err instanceof FactoryError ? err.code : null;
    // §25: stagnation auto-escalates instead of failing the run.
    if (err instanceof LoopStagnation) {
      pushTrace('RUNNER', 'auto-escalate', err.message);
      return { outcome: 'escalated', steps, evidence, handoffs, trace, reason: err.message, reasonCode, budgetUsage: tracker.usage, intentSummary: intentSummary() };
    }
    const reason = err instanceof Error ? err.message : String(err);
    pushTrace('RUNNER', 'run failed', reason);
    return { outcome: 'failed', steps, evidence, handoffs, trace, reason, reasonCode, budgetUsage: tracker.usage, intentSummary: intentSummary() };
  }
}

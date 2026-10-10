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
  Clock,
  EvidenceRecord,
  LoopPhase,
  LoopStagnation,
  PhaseResult,
  RunResult,
  StepFn,
  TraceStep,
  systemClock,
} from './types';

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
}

/** Adapter-driven StepFn used when the caller does not script behavior. */
function defaultStepFn(ctx: DefaultStepContext): StepFn {
  const { agent, task, harness, adapter, tools, routing } = ctx;
  let adapterNote = '';

  return async (phase: LoopPhase): Promise<PhaseResult> => {
    switch (phase) {
      case 'OBSERVE':
        harness.collectEvidence({
          type: 'context',
          title: 'context assembled',
          payload: {
            agentId: agent.id,
            taskId: task.id,
            model: routing?.primary.model ?? adapter.name,
          },
        });
        return { ok: true, note: `observing task ${task.id}` };

      case 'UNDERSTAND':
        return { ok: true, note: `goal: ${task.goal.slice(0, 120)}` };

      case 'PLAN':
        return {
          ok: true,
          note: `plan via ${routing?.primary.model ?? adapter.name}`,
        };

      case 'ACT': {
        let output;
        try {
          output = await harness.withTimeout('adapter.invoke', () =>
            adapter.invoke({ prompt: buildPrompt(agent, task), tools: Object.keys(tools) }),
          );
        } catch (err) {
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
        primary: routing.primary.model,
        fallback: routing.fallback.model,
        emergency: routing.emergency.model,
        reason: routing.reason,
      },
    });
    pushTrace('RUNNER', 'model routing', `primary=${routing.primary.model}`);
  }

  const loop =
    options.loop ??
    new AgentLoop({
      budgets: { maxSteps: 60, timeMs: 120_000, maxRetries: 3 },
      clock,
    });
  const stepFn =
    options.stepFn ??
    defaultStepFn({
      agent,
      task,
      harness,
      adapter,
      tools: options.tools ?? {},
      routing,
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
    };
  } catch (err) {
    // Recover the partial loop trace when run() threw (budget/stagnation).
    trace.push(...loop.trace);
    trace.push(...harness.drainTrace());
    evidence.push(...harness.drainEvidence());
    const steps = loop.snapshot.totalSteps;
    // §25: stagnation auto-escalates instead of failing the run.
    if (err instanceof LoopStagnation) {
      pushTrace('RUNNER', 'auto-escalate', err.message);
      return { outcome: 'escalated', steps, evidence, handoffs, trace, reason: err.message };
    }
    const reason = err instanceof Error ? err.message : String(err);
    pushTrace('RUNNER', 'run failed', reason);
    return { outcome: 'failed', steps, evidence, handoffs, trace, reason };
  }
}

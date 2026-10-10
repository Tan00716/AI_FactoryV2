/**
 * Orchestrator — spec §92, the central control engine.
 *
 * Responsibility list from the spec (read task, determine next action, find
 * suitable agent, create squad, start agent, monitor, collect artifacts,
 * evaluate evidence, trigger workflow, handle failure, retry, escalate...).
 *
 * The decision core is a PURE function `decideNextAction`: task state in,
 * action out. Per §92, state transitions, permissions, gate checks, retries,
 * scheduling and audit are code — never LLM-owned. AI is used only for
 * decisions that require reasoning (e.g. "is this evidence sufficient?"),
 * and this package documents that boundary in README.md.
 */
import type { TaskStatus } from '@ai-factory/core';
import type { Clock } from './scheduler';

const defaultClock: Clock = { now: () => Date.now() };

/** Actions the orchestrator can take on a task. */
export type NextAction =
  | 'decompose' // TODO → break into subtasks (§95)
  | 'assign' // PLANNING → pick agent via selection (§94)
  | 'run' // IN_PROGRESS → execute / continue monitoring
  | 'request-review' // CODE_REVIEW → route to reviewer
  | 'request-qa' // PENDING_QA / QA → run QA loop
  | 'merge' // PENDING_UAT_MERGE → merge to release branch
  | 'verify' // UAT / PROD_VERIFICATION → verify evidence
  | 'deploy' // PENDING_PROD / PROD_DEPLOYING → deploy
  | 'retry' // failure states with retries left
  | 'escalate' // blocked / retries exhausted / rollback
  | 'complete' // DONE → close out
  | 'noop'; // terminal non-DONE states or already escalated

export interface TaskStateSnapshot {
  status: TaskStatus;
  /** Sealed evidence ids / types collected so far. */
  evidence: string[];
  /** Consecutive failure count. */
  failures: number;
}

export interface DecideOptions {
  /** Max consecutive failures before escalation. Default: 3. */
  maxRetries?: number;
}

/**
 * Pure state → action mapping following the §11 workflow.
 *
 * - Happy path: TODO → decompose → assign → run → request-review →
 *   request-qa → merge → verify → deploy → verify → complete.
 * - Exception path: BLOCKED → escalate; QA/UAT/PROD failures → retry while
 *   retries remain, then escalate; ROLLBACK → escalate; terminal states →
 *   complete (DONE) or noop.
 */
export function decideNextAction(
  state: TaskStateSnapshot,
  options: DecideOptions = {},
): NextAction {
  const maxRetries = options.maxRetries ?? 3;

  switch (state.status) {
    case 'TODO':
      return 'decompose';
    case 'PLANNING':
      return 'assign';
    case 'IN_PROGRESS':
      return 'run';
    case 'CODE_REVIEW':
      return 'request-review';
    case 'PENDING_QA':
    case 'QA':
      return 'request-qa';
    case 'PENDING_UAT_MERGE':
      return 'merge';
    case 'UAT':
    case 'PROD_VERIFICATION':
      return 'verify';
    case 'PENDING_PROD':
    case 'PROD_DEPLOYING':
      return 'deploy';
    case 'DONE':
      return 'complete';
    case 'BLOCKED':
      return 'escalate';
    case 'ROLLBACK':
      return 'escalate';
    case 'ESCALATED':
      return 'noop';
    case 'QA_FAILED':
    case 'UAT_FAILED':
    case 'PROD_FAILED':
      return state.failures >= maxRetries ? 'escalate' : 'retry';
    case 'CANCELLED':
    case 'REJECTED':
      return 'noop';
  }
}

/** §22 — structured handoff between agents (never free-form chat). */
export interface Handoff {
  from: string;
  to: string;
  taskId: string;
  /** Why responsibility is moving. */
  reason: string;
  /** Summary of context the next owner needs. */
  contextSummary: string;
  /** ISO-8601 timestamp. */
  at: string;
}

export interface HandoffInput {
  from: string;
  to: string;
  taskId: string;
  reason: string;
  contextSummary: string;
}

/** Create an immutable handoff record. Timestamp comes from an injectable clock. */
export function createHandoff(input: HandoffInput, clock: Clock = defaultClock): Handoff {
  return {
    ...input,
    at: new Date(clock.now()).toISOString(),
  };
}

export interface OrchestratorOptions {
  clock?: Clock;
  maxRetries?: number;
}

/**
 * Orchestrator control engine. Thin deterministic shell: decides the next
 * action for a task snapshot, creates handoff records, and appends audit
 * entries. All reasoning-adjacent inputs (evidence sufficiency, agent
 * choice) arrive pre-computed from the AI layer or the selection module —
 * the engine itself never asks an LLM what to do with a state.
 */
export class Orchestrator {
  private readonly clock: Clock;
  private readonly maxRetries: number;
  private readonly audit: Array<{ at: string; taskId: string; action: NextAction; detail: string }> = [];

  constructor(options: OrchestratorOptions = {}) {
    this.clock = options.clock ?? defaultClock;
    this.maxRetries = options.maxRetries ?? 3;
  }

  decideNextAction(state: TaskStateSnapshot): NextAction {
    const action = decideNextAction(state, { maxRetries: this.maxRetries });
    return action;
  }

  /** Decide and record the decision in the audit trail. */
  decideAndAudit(taskId: string, state: TaskStateSnapshot, detail = ''): NextAction {
    const action = this.decideNextAction(state);
    this.audit.push({
      at: new Date(this.clock.now()).toISOString(),
      taskId,
      action,
      detail,
    });
    return action;
  }

  createHandoff(input: HandoffInput): Handoff {
    return createHandoff(input, this.clock);
  }

  auditTrail(): ReadonlyArray<{ at: string; taskId: string; action: NextAction; detail: string }> {
    return this.audit;
  }
}

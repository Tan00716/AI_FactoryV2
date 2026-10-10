/**
 * Shared types for the evaluation engine (spec §57–§58).
 *
 * Zero external dependencies; all time flows through an injected clock.
 */

/** Injectable clock — `{ now: () => number }` (ms epoch). */
export interface Clock {
  now(): number;
}

/** The 11 measurable metrics from spec §57 (rates are 0..1). */
export interface EvaluationMetrics {
  /** 1 = task fully succeeded, 0 = failed. */
  taskSuccess: number;
  /** Fraction of tests passing. */
  testPassRate: number;
  /** Fraction of tests that are regressions. */
  regressionRate: number;
  /** reviewRejections / reviewRounds. */
  reviewRejectionRate: number;
  /** 1 = done in a single pass, decays with each repair loop. */
  loopEfficiency: number;
  /** Wall-clock time for the task. */
  durationMs: number;
  /** Total tokens consumed by the agent(s). */
  tokenUsage: number;
  /** Fraction of tool calls that errored. */
  toolErrorRate: number;
  /** Fraction of "done" claims that were not actually done. */
  falseCompletionRate: number;
  /** Fraction of deployments rolled back. */
  rollbackRate: number;
  /** Fraction of decisions escalated to a human. */
  humanEscalationRate: number;
}

/** Overall quality verdict derived from the weighted metric score. */
export type Verdict = 'EXCELLENT' | 'GOOD' | 'ACCEPTABLE' | 'POOR' | 'FAIL';

/** Raw observed facts a caller supplies so the engine can compute §57 metrics. */
export interface TaskEvidence {
  /** Did the task meet its acceptance criteria? */
  success: boolean;
  /** Test outcome. */
  tests: { passed: number; total: number };
  /** Tests that regressed (broke something that used to pass). */
  regressions: number;
  /** Reviewer rounds and how many rejected the work. */
  reviewRounds: number;
  reviewRejections: number;
  /** QA/fix/retry loops needed before the task finished. */
  fixLoops: number;
  /** wall-clock time for the task in ms. */
  durationMs: number;
  /** Total tokens the agent consumed. */
  tokensUsed: number;
  /** Tool-call counts. */
  toolCalls: number;
  toolErrors: number;
  /** "Done" claims and how many were false. */
  completionClaims: number;
  falseCompletions: number;
  /** Deployments and rollbacks. */
  deployments: number;
  rollbacks: number;
  /** Decisions and how many were escalated to a human. */
  decisions: number;
  escalations: number;
}

/** Input to `EvaluationEngine.evaluateTask`. */
export interface TaskEvaluationInput extends TaskEvidence {
  taskId: string;
  /** Agent/employee that ran the task. */
  agentId: string;
  /** Human/LLM-written summary of what happened. */
  summary: string;
  /** Evidence ids (test runs, reviews, logs) backing this evaluation. */
  evidenceIds: string[];
}

/** Result of one task evaluation (§57). */
export interface EvaluationResult {
  evaluationId: string;
  taskId: string;
  agentId: string;
  summary: string;
  evidenceIds: string[];
  metrics: EvaluationMetrics;
  /** 0..1 weighted score. */
  score: number;
  verdict: Verdict;
  /** Repair loops observed — kept for agent-profile aggregation. */
  repairLoops: number;
  evaluatedAt: number;
}

/** Aggregated picture of one agent across many evaluations (§57 agent profile). */
export interface AgentProfile {
  agentId: string;
  /** Number of evaluations aggregated. */
  evaluations: number;
  /** Fraction of evaluations with taskSuccess === 1. */
  successRate: number;
  /** Fraction of evaluations that passed QA first try (0 repair loops). */
  firstPassQaRate: number;
  /** Mean reviewRejectionRate across evaluations. */
  reviewRejectionRate: number;
  /** Mean repair loops per evaluation. */
  avgRepairLoops: number;
  /** Mean falseCompletionRate across evaluations. */
  falseCompletionRate: number;
  lastEvaluatedAt: number | null;
}

/** A lesson extracted from failure analysis (§58). */
export interface Lesson {
  lessonId: string;
  taskId: string;
  agentId: string;
  title: string;
  content: string;
  severity: 'info' | 'warning' | 'critical';
  /** 0..1 — how confident we are this lesson is correct/actionable. */
  confidence: number;
  evidenceIds: string[];
  createdAt: number;
}

/**
 * Decoupling seam for lesson persistence (§58: Task → Evaluation →
 * Failure Analysis → Lesson → Memory). Implementations persist however they
 * want — the engine never hard-depends on @ai-factory/memory.
 */
export interface LessonSink {
  saveLesson(lesson: Lesson): void;
}

/** What kind of change an improvement proposal asks for. */
export type ProposalKind =
  | 'skill-improvement'
  | 'agent-config'
  | 'org-rule'
  | 'process';

/**
 * Proposal lifecycle (§58): PROPOSED → APPROVED → APPLIED,
 * PROPOSED → REJECTED, APPROVED → REJECTED (revoke). APPLIED and REJECTED
 * are terminal. Nothing may APPLY without passing APPROVED first — the
 * engine never silently modifies critical organization rules.
 */
export type ProposalStatus = 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'APPLIED';

export interface ImprovementProposal {
  proposalId: string;
  kind: ProposalKind;
  title: string;
  description: string;
  /**
   * True when the proposal touches critical organization rules
   * (§58: must be approved before APPLIED, never silently modified).
   */
  criticalOrgRule: boolean;
  status: ProposalStatus;
  proposedBy: string;
  /** Lesson ids that motivated this proposal. */
  lessonIds: string[];
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
  appliedAt?: number;
}

/** Input to `ProposalBoard.propose`. */
export interface NewProposal {
  kind: ProposalKind;
  title: string;
  description: string;
  criticalOrgRule?: boolean;
  proposedBy: string;
  lessonIds?: string[];
}

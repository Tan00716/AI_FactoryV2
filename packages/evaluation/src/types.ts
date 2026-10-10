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
  /**
   * The policy domains this proposal would modify, if any.
   * LOCKED domains (lock rules, human authority, permission ceilings,
   * access control, gate standards) are rejected at CREATION with
   * LOCKED_DOMAIN — before any approval step, regardless of the approver.
   */
  targetDomains?: string[];
}

/* ------------------------------------------------------------------ */
/* §45 locked domains: not directly modifiable by improvement proposals */
/* ------------------------------------------------------------------ */

/**
 * Locked domains [§45.2]: Lock Rules, Human Authority, permission ceilings,
 * Access Control (AC), Gate Standards. No improvement proposal may directly
 * modify these — attempts are rejected at proposal creation (LOCKED_DOMAIN).
 * Changing them requires a policy change by an authorized human.
 */
export const LOCKED_DOMAINS = [
  'lock-rules',
  'human-authority',
  'permission-ceiling',
  'access-control',
  'gate-standards',
] as const;

export type LockedDomain = (typeof LOCKED_DOMAINS)[number];

/* ------------------------------------------------------------------ */
/* §45.3 independent evaluation: train/holdout separation, full attempts */
/* ------------------------------------------------------------------ */

/** Which side of the train/holdout boundary an eval sample sits on. */
export type EvalSplit = 'train' | 'holdout';

/** One evaluation sample, explicitly marked with its split [§45.3]. */
export interface EvalSample {
  sampleId: string;
  /** Task this sample was drawn from, if any. */
  taskId?: string;
  /** The material being evaluated (prompt, transcript, trace, …). */
  content: string;
  /** train = may select/improve on; holdout = benchmark only, never training. */
  split: EvalSplit;
  /** Where the sample came from (task run id, benchmark set name, …). */
  source: string;
}

/** Why an evaluation is being run. */
export type EvaluationPurpose =
  | 'training_selection' // tuning/selecting on samples — holdout FORBIDDEN
  | 'benchmark' // holdout benchmark — holdout allowed
  | 'independent_check'; // §45.2 independent regression/security eval

/** One recorded execution attempt — ALL attempts are kept, not just the best [§45.3]. */
export interface EvaluationAttempt {
  attemptId: string;
  at: number;
  /** Wall-clock ms and token cost of this attempt. */
  cost: { durationMs: number; tokensUsed: number };
  success: boolean;
  score?: number;
  /** Why this attempt failed (present when success === false). */
  failureReason?: string;
  /** Side effects observed during the attempt (files written, tools called, …). */
  sideEffects: string[];
}

/** Full record of an evaluation: every attempt, cost, failure and side effect [§45.3]. */
export interface EvaluationRun {
  runId: string;
  sampleId: string;
  purpose: EvaluationPurpose;
  /** Every attempt in order — never pruned to "best only". */
  attempts: EvaluationAttempt[];
  totalCost: { durationMs: number; tokensUsed: number };
  /** Best score across attempts (informational; attempts are not dropped). */
  bestScore: number | null;
  passed: boolean;
  executedAt: number;
}

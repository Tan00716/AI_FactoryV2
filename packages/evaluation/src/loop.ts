/**
 * @ai-factory/evaluation — improvement closed loop (spec §45.2).
 *
 *   VERIFIED_TASK → OUTCOME_EVAL → LESSON → PROPOSAL
 *     → INDEPENDENT_EVAL → VERSION → POLICY_APPROVAL
 *     → LIMITED_ACTIVATION → OBSERVE → PROMOTE | REVERT
 *
 * Every stage transition records an ADMISSION CHECK (who/what admitted the
 * case into the stage, what was verified, when) — nothing moves forward
 * silently.
 *
 * Hardened boundaries:
 *  - PROPOSAL goes through ProposalBoard.propose: a proposal that would
 *    modify a locked domain (lock rules, human authority, permission
 *    ceilings, access control, gate standards) is rejected AT CREATION with
 *    LOCKED_DOMAIN, before any approval and regardless of the approver.
 *  - INDEPENDENT_EVAL requires runs executed for an independent purpose
 *    ('independent_check' or 'benchmark'): a run done for training
 *    selection is refused as the admission check.
 *  - LIMITED_ACTIVATION pins an explicit limited scope (canary employees);
 *    running tasks stay on pinned versions or are explicitly migrated.
 *  - PROMOTE requires passing observations; REVERT keeps the effect record.
 */
import { randomUUID } from 'node:crypto';
import type {
  EvaluationResult,
  EvaluationRun,
  Lesson,
  NewProposal,
} from './types';
import { ProposalBoard } from './proposals';

export type LoopStage =
  | 'VERIFIED_TASK'
  | 'OUTCOME_EVAL'
  | 'LESSON'
  | 'PROPOSAL'
  | 'INDEPENDENT_EVAL'
  | 'VERSION'
  | 'POLICY_APPROVAL'
  | 'LIMITED_ACTIVATION'
  | 'OBSERVE'
  | 'PROMOTE'
  | 'REVERT';

export const LOOP_STAGES: readonly LoopStage[] = [
  'VERIFIED_TASK',
  'OUTCOME_EVAL',
  'LESSON',
  'PROPOSAL',
  'INDEPENDENT_EVAL',
  'VERSION',
  'POLICY_APPROVAL',
  'LIMITED_ACTIVATION',
  'OBSERVE',
  'PROMOTE',
  'REVERT',
];

/** One admission check recorded when a case enters a stage [§45.2]. */
export interface AdmissionCheck {
  stage: LoopStage;
  at: number;
  passed: boolean;
  checkedBy: string;
  details: string;
}

/** A case walking the improvement loop. */
export interface LoopCase {
  caseId: string;
  taskId: string;
  stage: LoopStage;
  admissionChecks: AdmissionCheck[];
  evaluationId?: string;
  lessonIds: string[];
  proposalId?: string;
  independentRunIds: string[];
  version?: string;
  limitedScope?: { employees: string[]; note: string };
  observations: Array<{ at: number; by: string; note: string; success: boolean }>;
  outcome?: 'PROMOTED' | 'REVERTED';
  outcomeReason?: string;
  createdAt: number;
  updatedAt: number;
}

export class LoopError extends Error {
  readonly code = 'LOOP_STAGE_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'LoopError';
  }
}

export interface ImprovementLoopOptions {
  /** Shared proposal board (a fresh one is created by default). */
  board?: ProposalBoard;
  /** Defaults to `Date.now`; inject a fake clock in tests/demos. */
  now?: () => number;
}

export class ImprovementLoop {
  private readonly cases = new Map<string, LoopCase>();
  private readonly board: ProposalBoard;
  private readonly nowFn: () => number;

  constructor(options: ImprovementLoopOptions = {}) {
    this.board = options.board ?? new ProposalBoard({ now: options.now });
    this.nowFn = options.now ?? Date.now;
  }

  /** Read-only view of a case, including its full admission-check trail. */
  status(caseId: string): LoopCase {
    return { ...this.require(caseId), admissionChecks: [...this.require(caseId).admissionChecks] };
  }

  all(): LoopCase[] {
    return [...this.cases.values()].map((c) => this.status(c.caseId));
  }

  /** VERIFIED_TASK: open a case from a verified task/incident. */
  start(taskId: string, opts: { verifiedBy: string; evidenceIds?: string[] }): LoopCase {
    const now = this.nowFn();
    const c: LoopCase = {
      caseId: `loop_${randomUUID()}`,
      taskId,
      stage: 'VERIFIED_TASK',
      admissionChecks: [
        {
          stage: 'VERIFIED_TASK',
          at: now,
          passed: true,
          checkedBy: opts.verifiedBy,
          details: `task verified with ${opts.evidenceIds?.length ?? 0} evidence id(s)`,
        },
      ],
      lessonIds: [],
      independentRunIds: [],
      observations: [],
      createdAt: now,
      updatedAt: now,
    };
    this.cases.set(c.caseId, c);
    return this.status(c.caseId);
  }

  /** OUTCOME_EVAL: attach the outcome evaluation of the verified task. */
  recordOutcomeEval(caseId: string, result: EvaluationResult, by: string): LoopCase {
    const c = this.requireAt(caseId, 'VERIFIED_TASK');
    this.admit(c, {
      stage: 'OUTCOME_EVAL',
      passed: true,
      checkedBy: by,
      details: `evaluation ${result.evaluationId}: score=${result.score} verdict=${result.verdict}`,
    });
    c.evaluationId = result.evaluationId;
    c.stage = 'OUTCOME_EVAL';
    return this.save(c);
  }

  /** LESSON: attach a root-cause lesson from the evaluation. */
  addLesson(caseId: string, lesson: Lesson, by: string): LoopCase {
    const c = this.requireAt(caseId, 'OUTCOME_EVAL');
    this.admit(c, {
      stage: 'LESSON',
      passed: true,
      checkedBy: by,
      details: `lesson ${lesson.lessonId}: ${lesson.title}`,
    });
    c.lessonIds.push(lesson.lessonId);
    c.stage = 'LESSON';
    return this.save(c);
  }

  /**
   * PROPOSAL: file an improvement proposal from the lessons.
   * The locked-domain screen runs at creation: locked proposals throw
   * LockedDomainError (code LOCKED_DOMAIN) here — never approved later.
   */
  fileProposal(caseId: string, input: NewProposal): LoopCase {
    const c = this.requireAt(caseId, 'LESSON');
    if (c.lessonIds.length === 0) {
      throw new LoopError(`case ${caseId}: cannot file a proposal without lessons`);
    }
    const proposal = this.board.propose({
      ...input,
      lessonIds: [...(input.lessonIds ?? []), ...c.lessonIds],
    });
    this.admit(c, {
      stage: 'PROPOSAL',
      passed: true,
      checkedBy: input.proposedBy,
      details: `proposal ${proposal.proposalId} filed (${proposal.kind}); locked-domain screen passed`,
    });
    c.proposalId = proposal.proposalId;
    c.stage = 'PROPOSAL';
    return this.save(c);
  }

  /**
   * INDEPENDENT_EVAL: attach independent regression + security evaluations.
   * Admission: runs must be independent-purpose ('independent_check' or
   * 'benchmark'); training-selection runs are refused at the gate.
   */
  runIndependentEval(
    caseId: string,
    opts: { regression: EvaluationRun; security: EvaluationRun; by: string },
  ): LoopCase {
    const c = this.requireAt(caseId, 'PROPOSAL');
    for (const [label, run] of [
      ['regression', opts.regression],
      ['security', opts.security],
    ] as const) {
      if (run.purpose === 'training_selection') {
        throw new LoopError(
          `case ${caseId}: ${label} evaluation was run for training_selection — ` +
            'independent regression/security evaluation must use an independent purpose',
        );
      }
    }
    this.admit(c, {
      stage: 'INDEPENDENT_EVAL',
      passed: opts.regression.passed && opts.security.passed,
      checkedBy: opts.by,
      details:
        `regression run ${opts.regression.runId} passed=${opts.regression.passed} ` +
        `(${opts.regression.attempts.length} attempts kept); ` +
        `security run ${opts.security.runId} passed=${opts.security.passed} ` +
        `(${opts.security.attempts.length} attempts kept)`,
    });
    c.independentRunIds.push(opts.regression.runId, opts.security.runId);
    c.stage = 'INDEPENDENT_EVAL';
    return this.save(c);
  }

  /** VERSION: pin a version for the improvement. */
  versionProposal(caseId: string, version: string, by: string): LoopCase {
    const c = this.requireAt(caseId, 'INDEPENDENT_EVAL');
    this.admit(c, {
      stage: 'VERSION',
      passed: true,
      checkedBy: by,
      details: `improvement versioned as ${version}`,
    });
    c.version = version;
    c.stage = 'VERSION';
    return this.save(c);
  }

  /** POLICY_APPROVAL: approve the proposal via the governance board. */
  approvePolicy(caseId: string, approver: string): LoopCase {
    const c = this.requireAt(caseId, 'VERSION');
    if (!c.proposalId) throw new LoopError(`case ${caseId}: no proposal filed`);
    const approved = this.board.approve(c.proposalId, approver);
    this.admit(c, {
      stage: 'POLICY_APPROVAL',
      passed: true,
      checkedBy: approver,
      details: `proposal ${approved.proposalId} approved by ${approved.decidedBy}`,
    });
    c.stage = 'POLICY_APPROVAL';
    return this.save(c);
  }

  /**
   * LIMITED_ACTIVATION: activate the improvement on a limited canary scope.
   * Running tasks stay on pinned versions unless explicitly migrated [§45.4].
   */
  activateLimited(
    caseId: string,
    opts: { employees: string[]; note: string; by: string },
  ): LoopCase {
    const c = this.requireAt(caseId, 'POLICY_APPROVAL');
    if (opts.employees.length === 0) {
      throw new LoopError(`case ${caseId}: limited activation requires a non-empty canary scope`);
    }
    this.admit(c, {
      stage: 'LIMITED_ACTIVATION',
      passed: true,
      checkedBy: opts.by,
      details: `activated for canary employees: ${opts.employees.join(', ')} — ${opts.note}`,
    });
    c.limitedScope = { employees: [...opts.employees], note: opts.note };
    c.stage = 'LIMITED_ACTIVATION';
    return this.save(c);
  }

  /** OBSERVE: record one observation from the limited activation. */
  observe(
    caseId: string,
    opts: { note: string; success: boolean; by: string },
  ): LoopCase {
    const c = this.requireAt(caseId, 'LIMITED_ACTIVATION', 'OBSERVE');
    c.observations.push({ at: this.nowFn(), by: opts.by, note: opts.note, success: opts.success });
    if (c.stage === 'LIMITED_ACTIVATION') {
      this.admit(c, {
        stage: 'OBSERVE',
        passed: true,
        checkedBy: opts.by,
        details: `first observation recorded: ${opts.note}`,
      });
      c.stage = 'OBSERVE';
    }
    return this.save(c);
  }

  /**
   * PROMOTE: promote after passing observations. Failing observations block
   * promotion — the case must be reverted instead.
   */
  promote(caseId: string, by: string): LoopCase {
    const c = this.requireAt(caseId, 'OBSERVE');
    if (c.observations.length === 0 || c.observations.some((o) => !o.success)) {
      throw new LoopError(
        `case ${caseId}: cannot promote with ${c.observations.length} observation(s) ` +
          'containing failures — revert instead',
      );
    }
    this.admit(c, {
      stage: 'PROMOTE',
      passed: true,
      checkedBy: by,
      details: `${c.observations.length} passing observation(s); version ${c.version ?? '(unversioned)'} promoted`,
    });
    c.stage = 'PROMOTE';
    c.outcome = 'PROMOTED';
    return this.save(c);
  }

  /** REVERT: roll back the limited activation; the effect record is kept. */
  revert(caseId: string, opts: { by: string; reason: string }): LoopCase {
    const c = this.require(caseId);
    if (!['LIMITED_ACTIVATION', 'OBSERVE'].includes(c.stage)) {
      throw new LoopError(`case ${caseId}: can only revert from LIMITED_ACTIVATION/OBSERVE, not ${c.stage}`);
    }
    this.admit(c, {
      stage: 'REVERT',
      passed: true,
      checkedBy: opts.by,
      details: `reverted: ${opts.reason} — effect record retained (${c.observations.length} observation(s))`,
    });
    c.stage = 'REVERT';
    c.outcome = 'REVERTED';
    c.outcomeReason = opts.reason;
    return this.save(c);
  }

  /* --------------------------------------------------------------- */
  private require(caseId: string): LoopCase {
    const c = this.cases.get(caseId);
    if (!c) throw new LoopError(`Unknown loop case: ${caseId}`);
    return c;
  }

  private requireAt(caseId: string, ...stages: LoopStage[]): LoopCase {
    const c = this.require(caseId);
    if (!stages.includes(c.stage)) {
      throw new LoopError(
        `case ${caseId}: expected stage ${stages.join('/')} but is ${c.stage}`,
      );
    }
    return c;
  }

  private admit(
    c: LoopCase,
    check: Omit<AdmissionCheck, 'at'>,
  ): void {
    c.admissionChecks.push({ ...check, at: this.nowFn() });
  }

  private save(c: LoopCase): LoopCase {
    c.updatedAt = this.nowFn();
    this.cases.set(c.caseId, c);
    return this.status(c.caseId);
  }
}

/**
 * @ai-factory/evaluation — evaluation engine + improvement loop (spec §45).
 *
 * Modules:
 *  - types      metrics, results, profiles, lessons, proposals, locked
 *               domains, eval splits, attempt/run records                 [§45]
 *  - engine     TaskEvidence → §45.1 metrics → weighted score → verdict    [§45.1]
 *  - profiles   per-agent incremental profiles                            [§45.1]
 *  - lessons    failure analysis → Lesson, persisted via LessonSink        [§45.2]
 *  - proposals  PROPOSED → APPROVED → APPLIED governance state machine;
 *               locked domains rejected at creation (LOCKED_DOMAIN)       [§45.2]
 *  - harness    independent Eval Harness: sealed scoring policy, no write
 *               path for executors, train/holdout separation, full attempt
 *               retention                                                  [§45.3]
 *  - loop       improvement closed loop: VERIFIED_TASK → OUTCOME_EVAL →
 *               LESSON → PROPOSAL → INDEPENDENT_EVAL → VERSION →
 *               POLICY_APPROVAL → LIMITED_ACTIVATION → OBSERVE →
 *               PROMOTE | REVERT, with admission checks per stage          [§45.2]
 */
export * from './types';
export * from './engine';
export * from './profiles';
export * from './lessons';
export * from './proposals';
export * from './disagreement';
export * from './harness';
export * from './loop';

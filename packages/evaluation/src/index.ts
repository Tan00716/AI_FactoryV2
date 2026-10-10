/**
 * @ai-factory/evaluation — evaluation engine + improvement loop (spec §57–§58).
 *
 * Modules:
 *  - types      metrics, results, profiles, lessons, proposals        [§57–§58]
 *  - engine     TaskEvidence → §57 metrics → weighted score → verdict [§57]
 *  - profiles   per-agent incremental profiles                       [§57]
 *  - lessons    failure analysis → Lesson, persisted via LessonSink   [§58]
 *  - proposals  PROPOSED → APPROVED → APPLIED governance state machine [§58]
 */
export * from './types';
export * from './engine';
export * from './profiles';
export * from './lessons';
export * from './proposals';
export * from './disagreement';

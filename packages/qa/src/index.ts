/**
 * @ai-factory/qa — automated QA engine (spec §36–§38).
 *
 * Modules:
 *  - types     test categories, results, failure classes   [§37, §38]
 *  - org       QA lead + on-demand specialists             [§36]
 *  - classify  failure analyzer heuristics                 [§38]
 *  - runner    suite runners + TAP parsing + aggregation   [§37]
 *  - loop      the QA failure loop                         [§38]
 */
export * from './types';
export * from './org';
export * from './classify';
export * from './runner';
export * from './loop';

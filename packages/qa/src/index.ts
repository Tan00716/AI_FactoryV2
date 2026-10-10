/**
 * @ai-factory/qa — automated QA engine (spec §36–§38; v2 §38 hardening).
 *
 * Modules:
 *  - types     test categories, results, failure classes   [§37, §38]
 *  - org       QA lead + on-demand specialists             [§36]
 *  - classify  failure analyzer heuristics                 [§38]
 *  - runner    suite runners + TAP parsing + aggregation   [§37]
 *  - loop      the QA failure loop                         [§38]
 *  - report    machine-readable report + gate verdict       [v2 §38.2]
 *  - flaky     flake quarantine (owner+expiry+policy)       [v2 §38.2]
 *  - repair    stagnation + budget + test-change review    [v2 §38.3]
 *  - uat       business-scenario acceptance                [v2 §38.4]
 */
export * from './types';
export * from './org';
export * from './classify';
export * from './runner';
export * from './loop';
export * from './report';
export * from './flaky';
export * from './repair';
export * from './uat';

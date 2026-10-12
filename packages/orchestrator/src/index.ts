/**
 * @ai-factory/orchestrator — orchestration control plane (spec §92–§95, §21).
 *
 * Modules:
 *  - auto-decomposition  rule-based task → subtask templates (heuristic)  [§95]
 *  - scheduler           dependency/priority/concurrency scheduling        [§93]
 *  - selection           weighted agent scoring + ranking                 [§94]
 *  - orchestrator        state → next-action decisions, handoffs           [§92]
 *  - patterns            manager vs handoff pattern chooser               [§21]
 *  - delegation          §12.2 delegation records: scope/budget/depth/cycle enforcement
 */
export * from './auto-decomposition';
export * from './scheduler';
export * from './optimizer';
export * from './selection';
export * from './orchestrator';
export * from './patterns';
export * from './delegation';

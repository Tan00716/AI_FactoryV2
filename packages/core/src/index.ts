/**
 * @ai-factory/core — pure TypeScript domain layer for the AI Engineering
 * Factory IDE prototype. No I/O, no Electron, no DOM: fully unit-testable.
 *
 * Modules (spec section in brackets):
 *  - types      shared domain types            [§8, §11, §15, §17, §42, §44]
 *  - workflow   state machine + gate checks    [§11, §12]
 *  - tasks      task system + dependencies     [§8, §60]
 *  - evidence   evidence engine (immutability) [§42]
 *  - agents     agent registry + org tree      [§15–§17, §44, §84]
 *  - audit      append-only audit log          [§70]
 *  - engine     transition orchestration       [§12, §13, §92]
 *  - reason-codes 16 machine reason codes      [SPEC_V2 §49; local stand-in for @ai-factory/api-contracts]
 *  - workflow-v2  three-state separation       [SPEC_V2 §18]
 *  - engine-v2    v2 engine: finalize/rollback [SPEC_V2 §18, §19, §20.1]
 *  - evidence-v2  18-field evidence contract, gates, disputes [SPEC_V2 §39]
 */
export * from './types';
export * from './workflow';
export * from './tasks';
export * from './evidence';
export * from './agents';
export * from './audit';
export * from './engine';
export * from './reason-codes';
export * from './workflow-v2';
export * from './engine-v2';
export * from './evidence-v2';

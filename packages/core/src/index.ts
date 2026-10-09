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
 */
export * from './types';
export * from './workflow';
export * from './tasks';
export * from './evidence';
export * from './agents';
export * from './audit';
export * from './engine';

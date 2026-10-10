/**
 * @ai-factory/runtime — agent runtime (spec §24–§27).
 *
 * Modules:
 *  - types     loop phases/decisions, budgets, errors, trace, evidence sink [§24–§26]
 *  - loop      AgentLoop state machine: budgets, stagnation, checkpoint      [§24, §25]
 *  - harness   permissions, filesystem boundary, timeout, evidence, tracing  [§26]
 *  - adapters  RuntimeAdapter, StubAdapter, CodexAdapter placeholder          [§27]
 *  - runner    runAgent(): routing → loop → harness → adapter                [§24–§27]
 */
export * from './types';
export * from './loop';
export * from './harness';
export * from './adapters';
export * from './runner';

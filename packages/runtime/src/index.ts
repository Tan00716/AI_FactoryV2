/**
 * @ai-factory/runtime — agent runtime (spec §24–§27, v2 hardening §25/§28).
 *
 * Modules:
 *  - types      loop phases/decisions, budgets, errors, trace, evidence sink [§24–§26]
 *  - loop       AgentLoop state machine: budgets, stagnation, checkpoint      [§24, §25]
 *  - harness    permissions, filesystem boundary, timeout, evidence, tracing  [§26]
 *  - adapters   RuntimeAdapter, StubAdapter, CodexAdapter (app-server)         [§27]
 *  - codex-transport  JSON-RPC transport for `codex app-server` (stdio/ws)    [§27/§28]
 *  - runner     runAgent(): routing → loop → harness → adapter                [§24–§27]
 *  - run-states RunState machine: 12 states, SUCCEEDED ≠ task DONE              [§25]
 *  - failures   failure classification; permission-denial no-bypass guard     [§25]
 *  - limits     extended budgets, BudgetTracker, jittered retry w/ total cap  [§25]
 *  - durable    external ops (PREPARED→…→UNKNOWN), ledger reconcile,          [§28]
 *               checkpoints, step-intent store, disk safe-mode
 *  - pty        concrete shell execution: pipe mode + real PTY mode        [§33, §50.1]
 *               (python3 supervisor backend), createShellTool ToolImpl
 *  - pty-session interactive PTY sessions (human/ai principals, resize   [§50.1]
 *               over a control pipe, AI line-gated input), PtySessionManager
 */
export * from './types';
export * from './loop';
export * from './harness';
export * from './pty';
export * from './pty-session';
export * from './adapters';
export * from './adapter-contract';
export * from './runner';
export * from './run-states';
export * from './failures';
export * from './limits';
export * from './durable';

/**
 * @ai-factory/review — deterministic Code Review Agent (spec §35).
 *
 * Modules:
 *  - types       dimensions, severities, verdicts, findings      [§35]
 *  - dimensions  the 10 static heuristic checkers               [§35]
 *  - reviewer    reviewCode() + verdict aggregation             [§35]
 *  - gate        §12 workflow-gate evidence + meetsGate         [§12]
 *  - independence §37 verification-independence enforcement     [v2 §37]
 */
export * from './types';
export * from './dimensions';
export * from './reviewer';
export * from './gate';
export * from './independence';

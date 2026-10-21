/**
 * @ai-factory/mutation — deterministic text-level mutation testing.
 *
 * Modules:
 *  - types      shared types (mutants, verdicts, reports)
 *  - rng        seeded RNG (mulberry32) for reproducible sampling
 *  - operators  7 text-level mutation operators + string/comment-aware segmentation
 *  - sampling   seeded, budgeted mutant sampling
 *  - runner     scratch-isolated mutant execution with timeout circuit breaker
 *  - report     aggregation, mutation score, markdown rendering
 *
 * Honest boundaries: template-literal interpolations are not mutated (v1);
 * full-repo full-mutation is deliberately unsupported (sampling only);
 * timeouts and syntax-invalid mutants are reported separately and never
 * counted as killed.
 */
export * from './types';
export * from './rng';
export * from './operators';
export * from './sampling';
export * from './runner';
export * from './report';

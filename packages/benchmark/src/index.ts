/**
 * @ai-factory/benchmark — model quality benchmark harness (task 10).
 *
 * Fixed task set + metric collection + baseline diff + CI gate.
 * Default adapter is the scripted stub (deterministic); set
 * FACTORY_BENCH_ADAPTER=codex (plus the FACTORY_BENCH_CODEX_* env vars)
 * to benchmark a real model with zero harness changes.
 */
export * from './types';
export * from './tasks';
export * from './adapters';
export * from './runner';
export * from './baseline';
export * from './report';

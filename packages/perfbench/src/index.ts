/**
 * @ai-factory/perfbench — IDE performance benchmark suite + CI gate.
 * This package is NOT packages/benchmark (model-quality benchmarks):
 * it measures IDE-side costs (boot, index, repomap, search, SQLite,
 * large-file scan, harness overhead) on synthetic repos.
 */
export type {
  GateConfig,
  GateItem,
  GateMode,
  GateVerdict,
  PerfBaseline,
  PerfEnv,
  PerfResult,
  PerfTaskResult,
} from './types.js';
export { generateLargeFile, generateRepo, mulberry32 } from './seed.js';
export { mean, percentile, sorted, summarize } from './stats.js';
export type { LatencySummary } from './stats.js';
export { checkGate, defaultGateConfig, loadBaseline, DEFAULT_THRESHOLD_PCT } from './gate.js';
export { renderMarkdown, writeReportAtomic } from './report.js';
export {
  bootServer,
  gitRev,
  indexRepo,
  largeFileScan,
  productWalMode,
  repomapFor,
  searchRepo,
  sqliteBench,
  unitSample,
  viteBuild,
} from './tasks.js';
export { runSuite, PERFBENCH_VERSION } from './run.js';
export type { SuiteOptions } from './run.js';

#!/usr/bin/env node
/**
 * ai-factory-benchmark — one-command model quality benchmark.
 *
 *   npm run benchmark
 *   npm run benchmark -- --adapter codex --update-baseline
 *
 * Flags:
 *   --adapter stub|codex        adapter under test (default: FACTORY_BENCH_ADAPTER or stub)
 *   --baseline <path>           baseline JSON (default: baselines/<adapter>.json)
 *   --update-baseline           write the current run as the new baseline (atomic)
 *   --out <path>                JSON report path (default: reports/benchmark-<ts>.json)
 *   --min-pass-rate <0..1>       override the gate floor (default: baseline pass rate)
 *   --no-gate                   skip the CI gate (report only)
 *   --cases <id,id,..>          run a subset of cases
 *   --timeout-ms <n>            per-case wall-clock budget override
 *   --runs <n>                  repeat each case n times and aggregate
 *                               (mean/median/approx 95% CI; default 1)
 *
 * Exit codes: 0 = gate passed (or --no-gate), 1 = gate failed, 2 = usage error.
 */
import { join } from 'node:path';
import { resolveAdapterName } from './adapters';
import { defaultBaselinePath, diffBaseline, loadBaseline, reportToBaseline, saveBaseline } from './baseline';
import { checkGate, formatSummaryTable, writeReportJson } from './report';
import { runBenchmark } from './runner';
import { BENCHMARK_CASES } from './tasks';

const PACKAGE_DIR = join(__dirname, '..', '..');

function usage(): string {
  return [
    'ai-factory-benchmark — model quality benchmark harness',
    '',
    '  --adapter stub|codex        adapter under test (default: FACTORY_BENCH_ADAPTER or stub)',
    '  --baseline <path>           baseline JSON (default: baselines/<adapter>.json)',
    '  --update-baseline           write this run as the new baseline (atomic)',
    '  --out <path>                JSON report path (default: reports/benchmark-<ts>.json)',
    '  --min-pass-rate <0..1>       gate floor override (default: baseline pass rate)',
    '  --no-gate                   report only, always exit 0',
    '  --cases <id,id,..>          run a subset of cases',
    '  --timeout-ms <n>            per-case wall-clock budget override',
    '  --runs <n>                  repeat each case n times and aggregate',
    '                              (mean/median/approx 95% CI; default 1)',
  ].join('\n');
}

interface CliArgs {
  adapter: 'stub' | 'codex';
  baselinePath: string;
  updateBaseline: boolean;
  outPath: string;
  minPassRate?: number;
  noGate: boolean;
  cases?: string[];
  timeoutMs?: number;
  runs: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i === -1 || i + 1 >= args.length) return undefined;
    return args[i + 1];
  };
  const has = (flag: string): boolean => args.includes(flag);
  if (has('--help') || has('-h')) {
    console.log(usage());
    process.exit(0);
  }
  const adapter = resolveAdapterName({
    ...process.env,
    ...(get('--adapter') ? { FACTORY_BENCH_ADAPTER: get('--adapter') } : {}),
  });
  const minRaw = get('--min-pass-rate');
  const minPassRate = minRaw === undefined ? undefined : Number(minRaw);
  if (minPassRate !== undefined && (!Number.isFinite(minPassRate) || minPassRate < 0 || minPassRate > 1)) {
    console.error(`error: --min-pass-rate must be between 0 and 1 (got '${minRaw}')`);
    process.exit(2);
  }
  const timeoutRaw = get('--timeout-ms');
  const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    console.error(`error: --timeout-ms must be a positive number (got '${timeoutRaw}')`);
    process.exit(2);
  }
  const runsRaw = get('--runs');
  const runs = runsRaw === undefined ? 1 : Number(runsRaw);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(`error: --runs must be a positive integer (got '${runsRaw}')`);
    process.exit(2);
  }
  const casesRaw = get('--cases');
  const cases = casesRaw === undefined ? undefined : casesRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (cases) {
    const known = new Set(BENCHMARK_CASES.map((c) => c.id));
    for (const id of cases) {
      if (!known.has(id)) {
        console.error(`error: unknown case id '${id}' (known: ${[...known].join(', ')})`);
        process.exit(2);
      }
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    adapter,
    baselinePath: get('--baseline') ?? defaultBaselinePath(adapter, PACKAGE_DIR),
    updateBaseline: has('--update-baseline'),
    outPath: get('--out') ?? join(PACKAGE_DIR, 'reports', `benchmark-${stamp}.json`),
    minPassRate,
    noGate: has('--no-gate'),
    cases,
    timeoutMs,
    runs,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const selected = opts.cases
    ? BENCHMARK_CASES.filter((c) => opts.cases!.includes(c.id))
    : BENCHMARK_CASES;
  console.log(`running ${selected.length} benchmark cases with adapter '${opts.adapter}'…`);
  if (opts.runs > 1) console.log(`repeated runs: ${opts.runs} per case (aggregating mean/median/approx 95% CI)`);
  const report = await runBenchmark({
    adapter: opts.adapter,
    cases: selected,
    defaultTimeoutMs: opts.timeoutMs,
    runs: opts.runs,
  });
  const outPath = writeReportJson(opts.outPath, report);
  console.log(formatSummaryTable(report));
  console.log(`\nJSON report: ${outPath}`);

  if (opts.updateBaseline) {
    saveBaseline(opts.baselinePath, reportToBaseline(report));
    console.log(`baseline written: ${opts.baselinePath}`);
  }

  if (opts.noGate) {
    console.log('gate skipped (--no-gate)');
    return;
  }
  const baseline = loadBaseline(opts.baselinePath);
  const comparison = baseline ? diffBaseline(baseline, report) : null;
  if (!baseline) {
    console.log(`no baseline at ${opts.baselinePath} — gate uses --min-pass-rate or 100% floor`);
  }
  const gate = checkGate(report, baseline, comparison, { minPassRate: opts.minPassRate });
  for (const w of gate.warnings) console.log(`warning: ${w}`);
  if (gate.pass) {
    console.log('GATE PASS');
  } else {
    for (const r of gate.reasons) console.log(`gate failure: ${r}`);
    console.log('GATE FAIL');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`benchmark crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});

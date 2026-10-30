#!/usr/bin/env node
/**
 * IDE performance benchmark runner (V3-#4).
 *
 * Runs the @ai-factory/perfbench suite against synthetic repos and
 * writes a JSON report. Optionally applies the CI gate against a
 * baseline and/or archives the run as the new baseline.
 *
 *   node scripts/perfbench.mjs [--scale small,medium] [--with-vite]
 *     [--out <path>] [--gate <baseline.json>] [--gate-mode warn|block]
 *     [--save-baseline <path>] [--keep-workdir] [--seed 42]
 *
 * Defaults: scales small+medium, out = packages/perfbench/baselines/
 * run-<timestamp>.json, gate mode warn, workdir under $HOME
 * (PERFBENCH_WORKDIR override) — never /tmp, never inside the repo.
 * The compiled server must exist for the server-boot task (run
 * `npm run build -w @ai-factory/server` first); if it is absent the
 * task reports skipped instead of failing the suite.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const perfbenchMain = join(root, 'packages', 'perfbench', 'dist', 'src', 'index.js');
if (!existsSync(perfbenchMain)) {
  console.error('[perfbench] FAIL: package not built — run `npm run build -w @ai-factory/perfbench` first');
  process.exit(1);
}
const perf = await import(perfbenchMain);

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? (args[i + 1] ?? def) : def;
}
function has(name) {
  return args.includes(name);
}

const scales = (flag('--scale', 'small,medium')).split(',').map((s) => s.trim()).filter(Boolean);
const out = flag('--out', join(root, 'packages', 'perfbench', 'baselines', `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
const gatePath = flag('--gate', '');
const gateMode = flag('--gate-mode', 'warn');
const saveBaseline = flag('--save-baseline', '');
const seed = Number(flag('--seed', '42')) || 42;
const workDir = process.env.PERFBENCH_WORKDIR ?? join(homedir(), `perfbench-work-${process.pid}`);
// NOTE: the default workdir is per-process on purpose. Two concurrent
// runs sharing one workdir corrupt each other (one run's end-of-run
// cleanup deletes the other's repo mid-run — observed 2026-10-30: a
// stale run's cleanup made search-medium scan 0 files). PERFBENCH_WORKDIR
// still overrides for debugging.
const serverMain = join(root, 'apps', 'server', 'dist', 'index.js');

const result = await perf.runSuite({
  repoRoot: root,
  workDir,
  seed,
  scales,
  withVite: has('--with-vite'),
  serverMain: existsSync(serverMain) ? serverMain : undefined,
  productDbPath: join(root, 'apps', 'server', 'data', 'factory.db'),
  keepWorkdir: has('--keep-workdir'),
});
perf.writeReportAtomic(out, result);
console.log(`[perfbench] report: ${out}`);
for (const t of result.tasks) {
  if (t.skipped) console.log(`  ${t.task}: SKIPPED (${t.skipReason ?? 'n/a'})`);
  else console.log(`  ${t.task}: ${t.ms.toFixed(0)}ms${t.value !== undefined ? ` (${t.value.toFixed(1)} ${t.unit ?? ''})`.trimEnd() : ''}${t.p95Ms !== undefined ? ` p95=${t.p95Ms.toFixed(2)}ms` : ''}`);
}

if (gatePath) {
  const baseline = perf.loadBaseline(existsSync(gatePath) ? readFileSync(gatePath, 'utf8') : null);
  const verdict = perf.checkGate(result, baseline, { thresholdPct: 20, mode: gateMode === 'block' ? 'block' : 'warn' });
  console.log(`[perfbench] gate (${verdict.mode}, 20%): ${verdict.passed ? 'PASS' : 'FAIL'}`);
  for (const w of verdict.warnings) console.log(`  WARN: ${w}`);
  for (const f of verdict.failures) console.log(`  FAIL: ${f}`);
  if (saveBaseline) {
    perf.writeReportAtomic(saveBaseline, result);
    console.log(`[perfbench] baseline saved: ${saveBaseline}`);
  }
  if (!verdict.passed) process.exit(1);
} else if (saveBaseline) {
  perf.writeReportAtomic(saveBaseline, result);
  console.log(`[perfbench] baseline saved: ${saveBaseline}`);
}

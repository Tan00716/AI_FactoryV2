#!/usr/bin/env node
/**
 * Standalone CI gate for IDE performance results (V3-#4).
 *
 *   node scripts/perf-gate.mjs --result <run.json> --baseline <baseline.json> [--mode warn|block] [--threshold 20]
 *
 * Exit 0 when the gate passes; exit 1 only in block mode with a
 * regression above threshold. Warn mode (default) never fails: wall
 * clock timings are environment-sensitive and a first-landing gate
 * must not red-flag CI on a busy runner. Tighten to block once the
 * baseline has proven stable (see packages/perfbench/baselines/README).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const perfbenchMain = join(root, 'packages', 'perfbench', 'dist', 'src', 'index.js');
if (!existsSync(perfbenchMain)) {
  console.error('[perf-gate] FAIL: package not built — run `npm run build -w @ai-factory/perfbench` first');
  process.exit(1);
}
const perf = await import(perfbenchMain);

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? (args[i + 1] ?? def) : def;
}
const resultPath = flag('--result', '');
const baselinePath = flag('--baseline', '');
const mode = flag('--mode', 'warn') === 'block' ? 'block' : 'warn';
const threshold = Number(flag('--threshold', '20')) || 20;
if (!resultPath || !baselinePath) {
  console.error('[perf-gate] usage: node scripts/perf-gate.mjs --result <run.json> --baseline <baseline.json> [--mode warn|block] [--threshold 20]');
  process.exit(2);
}
const result = JSON.parse(readFileSync(resultPath, 'utf8'));
const baseline = perf.loadBaseline(existsSync(baselinePath) ? readFileSync(baselinePath, 'utf8') : null);
const verdict = perf.checkGate(result, baseline, { thresholdPct: threshold, mode });
console.log(`[perf-gate] ${verdict.mode} @ ${verdict.thresholdPct}%: ${verdict.passed ? 'PASS' : 'FAIL'}`);
for (const w of verdict.warnings) console.log(`  WARN: ${w}`);
for (const f of verdict.failures) console.log(`  FAIL: ${f}`);
if (!verdict.passed) process.exit(1);

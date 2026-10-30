/**
 * CI gate for IDE performance results (V3-#4).
 *
 * Semantics (warn-first, per the V3-#4 brief and the report's step 5):
 * - A task regresses when current.ms > baseline.ms * (1 + thresholdPct/100).
 * - In `warn` mode (the default for first landing) regressions only
 *   produce warnings; the verdict still passes, so a noisy runner never
 *   red-flags CI on wall-clock jitter. Tighten to `block` mode once the
 *   baseline has proven stable across several runs (see baselines/README).
 * - Tasks present in only one side are ignored (new tasks get a free
 *   first run; removed tasks do not fail the gate).
 * - A missing or corrupt baseline yields passed=true with noBaseline=true
 *   and a warning — never "everything regressed" (same fail-closed
 *   choice as packages/benchmark's baseline loader).
 */
import type { GateConfig, GateVerdict, PerfResult } from './types.js';

export const DEFAULT_THRESHOLD_PCT = 20;

export function defaultGateConfig(): GateConfig {
  return { thresholdPct: DEFAULT_THRESHOLD_PCT, mode: 'warn' };
}

export function checkGate(
  current: PerfResult,
  baseline: PerfResult | null,
  config: GateConfig = defaultGateConfig(),
): GateVerdict {
  if (baseline === null) {
    return {
      mode: config.mode,
      thresholdPct: config.thresholdPct,
      passed: true,
      warnings: ['no baseline found: gate passes, archive this run as the baseline'],
      failures: [],
      items: [],
      noBaseline: true,
    };
  }
  const baseByTask = new Map(baseline.tasks.map((t) => [t.task, t]));
  const warnings: string[] = [];
  const failures: string[] = [];
  const items: GateVerdict['items'] = [];
  for (const cur of current.tasks) {
    if (cur.skipped) continue;
    const base = baseByTask.get(cur.task);
    if (!base || base.skipped) continue;
    const changePct = base.ms === 0 ? 0 : ((cur.ms - base.ms) / base.ms) * 100;
    const regressed = changePct > config.thresholdPct;
    items.push({ task: cur.task, baselineMs: base.ms, currentMs: cur.ms, changePct, regressed });
    if (regressed) {
      const msg = `${cur.task}: ${cur.ms.toFixed(0)}ms vs baseline ${base.ms.toFixed(0)}ms (+${changePct.toFixed(1)}% > ${config.thresholdPct}%)`;
      if (config.mode === 'block') failures.push(msg);
      else warnings.push(msg);
    }
  }
  return {
    mode: config.mode,
    thresholdPct: config.thresholdPct,
    passed: failures.length === 0,
    warnings,
    failures,
    items,
    noBaseline: false,
  };
}

/** Load a baseline JSON file; null when absent or corrupt (fail-closed). */
export function loadBaseline(raw: string | null): PerfResult | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as PerfResult;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

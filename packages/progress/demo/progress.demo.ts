/**
 * Progress demo — SPEC_V2 §20.
 *
 *  1. Default weight plan; Planning 100% + Implementation 80% → 34% (spec example).
 *  2. Show the formula inputs: numerator / denominator / calculation version.
 *  3. Evidence invalidation: implementation evidence superseded → c drops
 *     0.8 → 0.4 → progress drops 34% → 22%, reason recorded (no fake monotonicity).
 *  4. Final seal pending: even everything else at 100% cannot show 100%.
 *
 * Run after building the package:
 *   npx tsc -p packages/progress/tsconfig.json
 *   node packages/progress/dist/demo/progress.demo.js
 */
import {
  CompletionEntry,
  CompletionLedger,
  applyInvalidation,
  computeProgress,
  defaultWeightPlan,
} from '../src/index';

function main(): void {
  const plan = defaultWeightPlan();
  const completions = new Map<string, CompletionEntry>([
    ['planning', { itemId: 'planning', c: 1, evidenceRef: 'ev-plan' }],
    ['implementation', { itemId: 'implementation', c: 0.8, evidenceRef: 'ev-impl' }],
  ]);

  const r1 = computeProgress(plan, completions);
  console.log('progress = 100 × Σ(wᵢcᵢ) / Σwᵢ');
  console.log(`[1] Planning 100% + Implementation 80% → ${r1.percent}% ` +
    `(numerator=${r1.numerator}, denominator=${r1.denominator}, calc=${r1.calculationVersion})`);
  for (const i of r1.items.filter((x) => x.c > 0)) {
    console.log(`    ${i.label}: w=${i.weight} c=${i.c} → ${i.contribution}`);
  }

  const ledger = new CompletionLedger();
  applyInvalidation(completions, ledger, 'implementation', 0.4,
    'ev-impl superseded: rework invalidated 40% of checkpoints', 'qa-lead');
  const r2 = computeProgress(plan, completions);
  console.log(`\n[2] evidence invalidated → progress ${r1.percent}% → ${r2.percent}% (honest decrease)`);
  console.log(`    ledger: ${ledger.list('implementation').map((e) => `${e.from}→${e.to} (${e.reason})`).join('; ')}`);

  const almost = new Map<string, CompletionEntry>(
    plan.items.filter((i) => i.kind !== 'seal').map((i) => [i.id, { itemId: i.id, c: 1, evidenceRef: 'ev' }]),
  );
  const r3 = computeProgress(plan, almost);
  console.log(`\n[3] everything but the seal at 100% → ${r3.percent}% (sealFinalized=${r3.sealFinalized})`);
  console.log('    DONE before 100% is impossible: the seal is a weighted item.');

  console.log('\ndemo complete.');
}

main();

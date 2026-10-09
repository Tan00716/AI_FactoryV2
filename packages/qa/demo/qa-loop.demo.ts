/**
 * QA failure-loop demo — spec §38 end to end.
 *
 *  1. Copies demo/sample (buggy calc.ts) into a temp dir so the repo is
 *     never mutated.
 *  2. Runs the sample's node:test suite via shellRunner → FAIL.
 *  3. QaLoop classifies the failure (PRODUCT_FAILURE), assigns the owner
 *     ('coder'), and calls onFixNeeded → the demo applies the real fix
 *     (removes the off-by-one) to the temp copy.
 *  4. Re-runs the affected category → PASS, then a full regression → PASS.
 *
 * Run after building the package:
 *   npx tsc -p packages/qa/tsconfig.json
 *   node packages/qa/dist/demo/qa-loop.demo.js
 */
import { mkdtempSync, cpSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  FailureRecord,
  QaLoop,
  TestCategory,
  shellRunner,
} from '../src/index';

const here = __dirname;
// Compiled demo lives at <pkg>/dist/demo/; sources at <pkg>/demo/sample.
const sampleSrc = resolve(here, '..', '..', 'demo', 'sample');

const FIXED_CALC = `export function sum(a: number, b: number): number {
  return a + b;
}

export function mul(a: number, b: number): number {
  return a * b;
}
`;

function applyFix(dir: string): void {
  writeFileSync(join(dir, 'calc.ts'), FIXED_CALC);
  console.log('  🔧 fix applied: removed the off-by-one in sum()');
}

async function main(): Promise<void> {
  const workdir = mkdtempSync(join(tmpdir(), 'qa-demo-'));
  cpSync(sampleSrc, workdir, { recursive: true });
  const testFile = join(workdir, 'calc.test.ts');
  console.log(`QA loop demo — sample copied to ${workdir}\n`);

  const seenFix = new Set<string>();
  const loop = new QaLoop({
    maxAttempts: 3,
    taskAgent: 'coder',
    onFixNeeded: (f: FailureRecord) => {
      console.log(
        `  🛠  attempt ${f.attempt} failure: [${f.classification}] → owner ${f.owner}`,
      );
      console.log(`     ${f.message}`);
      const key = `${f.category}:${f.classification}`;
      if (f.classification === 'PRODUCT_FAILURE' && !seenFix.has(key)) {
        seenFix.add(key);
        applyFix(workdir);
      }
    },
  });

  const category: TestCategory = 'unit';
  const { payload, escalated, attempts } = await loop.execute((attempt) => [
    shellRunner(category, `calc suite (attempt ${attempt})`, process.execPath, [
      '--test',
      '--test-reporter=tap',
      testFile,
    ], workdir),
  ]);

  console.log(`\nQA loop finished: attempts=${attempts} escalated=${escalated}`);
  console.log(
    `verdict=${payload.verdict} total=${payload.total} passed=${payload.passed} failed=${payload.failed}`,
  );
  for (const c of payload.categories) {
    console.log(
      `  [${c.verdict}] ${c.category}: ${c.passed}/${c.total} passed, ${c.failed} failed (${c.durationMs}ms)`,
    );
  }
  if (payload.failures.length > 0) {
    console.log('failures:');
    for (const f of payload.failures) {
      console.log(`  attempt ${f.attempt} ${f.category} ${f.classification} owner=${f.owner}: ${f.message}`);
    }
  }
  if (payload.verdict !== 'PASS' || escalated) process.exitCode = 1;
  else console.log('\n✅ demo complete: failure detected → classified → fixed → green');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

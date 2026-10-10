/**
 * Code Review Agent demo — spec §35 end to end.
 *
 *  Case A (problem change): a new login module with a hardcoded API key and
 *           SQL built via string concatenation, and no test file.
 *           → findings (security errors + testCoverage warning)
 *           → verdict CHANGES_REQUESTED, gate denied.
 *  Case B (clean change): a small pure function plus its test file.
 *           → verdict PASS, gate open.
 *
 * Run after building the package:
 *   npm run build -w @ai-factory/review
 *   node packages/review/dist/demo/review.demo.js
 */
import {
  IndependenceRequiredError,
  assertReviewIndependence,
  meetsGate,
  planIndependentReview,
  reviewCode,
  reviewGateEvidence,
  ReviewInput,
} from '../src/index';

const PROBLEM: ReviewInput = {
  files: [
    {
      path: 'src/auth/login.ts',
      after: [
        'const API_KEY = "sk-live-9f8e7d6c5b4a3928";',
        '',
        'export async function login(username: string): Promise<string> {',
        '  const query = "SELECT * FROM users WHERE name = \'" + username + "\'";',
        '  return query + API_KEY;',
        '}',
        '',
      ].join('\n'),
      // no `before` → new file; no test file in this change either
    },
  ],
  projectConventions: ['no-console', 'kebab-case-filenames'],
};

const CLEAN: ReviewInput = {
  files: [
    {
      path: 'src/math/sum.ts',
      after: [
        'export function sum(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/math/sum.test.ts',
      after: [
        "import { sum } from './sum';",
        "import { strict as assert } from 'node:assert';",
        'assert.equal(sum(2, 3), 5);',
        '',
      ].join('\n'),
    },
  ],
};

function run(title: string, input: ReviewInput, expected: string): void {
  console.log(`\n=== ${title} ===`);
  const result = reviewCode(input);
  console.log(`verdict : ${result.verdict} (expected ${expected})`);
  console.log(`gate    : ${meetsGate(result.verdict) ? 'OPEN' : 'DENIED'}`);
  console.log(`findings: ${result.summary.total}`);
  for (const f of result.findings) {
    const loc = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : '';
    console.log(`  [${f.severity.toUpperCase()}] [${f.dimension}]${loc} — ${f.message}`);
  }
  const evidence = reviewGateEvidence(result);
  console.log(
    `evidence: { type: '${evidence.type}', verdict: '${evidence.verdict}', findings: ${evidence.findings.length} }`,
  );
  if (result.verdict !== expected) {
    console.error(`DEMO MISMATCH: expected ${expected}, got ${result.verdict}`);
    process.exitCode = 1;
  }
}

run('Case A — hardcoded key + SQL concat, no tests', PROBLEM, 'CHANGES_REQUESTED');
run('Case B — clean change with tests', CLEAN, 'PASS');

// Case C — v2 §37: self-review is refused with INDEPENDENCE_REQUIRED.
console.log('\n=== Case C — self-review refused (v2 §37) ===');
try {
  assertReviewIndependence({
    reviewerId: 'agent-coder-1',
    reviewerRunId: 'run-review-1',
    implementerId: 'agent-coder-1',
    implementerRunId: 'run-code-1',
    gateStoreWritableByImplementer: false,
    collectorWritableByImplementer: false,
  });
  console.error('DEMO MISMATCH: self-review was allowed!');
  process.exitCode = 1;
} catch (err) {
  const ok = err instanceof IndependenceRequiredError && err.code === 'INDEPENDENCE_REQUIRED';
  console.log(`self-review refused: ${ok} (code=${err instanceof IndependenceRequiredError ? err.code : '?'})`);
  if (!ok) process.exitCode = 1;
}

// Case D — v2 §37: no independent reviewer available → BLOCKED, never fabricated.
console.log('\n=== Case D — no independent reviewer → BLOCKED ===');
const plan = planIndependentReview(
  [{ reviewerId: 'agent-coder-1', reviewerRunId: 'run-x' }],
  {
    implementerId: 'agent-coder-1',
    implementerRunId: 'run-code-1',
    gateStoreWritableByImplementer: false,
    collectorWritableByImplementer: false,
  },
);
console.log(`plan status: ${plan.status} (expected BLOCKED)`);
if (plan.status !== 'BLOCKED') process.exitCode = 1;

console.log('\ndone.');

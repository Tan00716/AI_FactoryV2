/**
 * End-to-end sampled mutation flow on the calc fixture module:
 * generate → sample (fixed seed) → run → report.
 *
 * Asserts: fixed seed reproduces the identical sample; the weak
 * `isPositive` test lets its boundary mutant survive (proving the
 * survived verdict is real); strong tests kill their mutants.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMutant,
  buildReport,
  defaultTestCommand,
  generateMutants,
  mutationScore,
  prepareScratch,
  readTargetFile,
  renderMarkdown,
  runMutantTests,
  sampleMutants,
  summarize,
  type MutantRunResult,
} from '../src/index';

const TEST_DIR = __dirname;
// Fixtures are .ts sources; they are NOT copied to dist by tsc. The package
// test suite always runs in-repo, so resolve them from the source tree.
const FIXTURE_DIR = join(TEST_DIR, '..', '..', 'tests', 'fixtures', 'calc');
const SEED = 20261021;

interface FlowOutcome {
  ids: string[];
  results: MutantRunResult[];
  generated: number;
}

async function runFlow(seed: number): Promise<FlowOutcome> {
  const files = ['calc.ts'];
  const testFiles = ['calc.test.ts'];
  const sources = new Map(files.map((f) => [f, readTargetFile(FIXTURE_DIR, f)]));
  const all = files.flatMap((f) => generateMutants(sources.get(f)!, f));
  const sampled = sampleMutants(all, { seed, maxMutants: 10, perFileCap: 10 });
  const scratchRoot = mkdtempSync(join(tmpdir(), 'mutation-flow-'));
  const results: MutantRunResult[] = [];
  try {
    for (const mutant of sampled) {
      const prep = prepareScratch(FIXTURE_DIR, mutant, applyMutant(sources.get(mutant.file)!, mutant), scratchRoot);
      try {
        const r = await runMutantTests(
          mutant,
          { scratchDir: prep.scratchDir, mutatedFileAbs: prep.mutatedFileAbs },
          { testCommand: defaultTestCommand(testFiles), timeoutMs: 20_000, maxOutputBytes: 65536, nodeCheck: true },
        );
        results.push({ mutant, ...r });
      } finally {
        prep.cleanup();
      }
    }
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
  return { ids: sampled.map((m) => m.id), results, generated: all.length };
}

describe('sampled mutation flow (calc fixture)', () => {
  let flowA: FlowOutcome;
  let flowB: FlowOutcome;

  before(async () => {
    flowA = await runFlow(SEED);
    flowB = await runFlow(SEED);
  });

  it('fixed seed reproduces the identical sample and verdicts', () => {
    assert.deepEqual(flowA.ids, flowB.ids, 'same seed must select the same mutants');
    assert.deepEqual(
      flowA.results.map((r) => r.verdict),
      flowB.results.map((r) => r.verdict),
      'same seed must reproduce the same verdicts',
    );
    assert.ok(flowA.generated >= 8, `expected a decent mutant pool, got ${flowA.generated}`);
    assert.equal(flowA.ids.length, Math.min(10, flowA.generated));
  });

  it('produces both killed and survived verdicts (weak test demonstrated)', () => {
    const verdicts = new Set(flowA.results.map((r) => r.verdict));
    assert.ok(verdicts.has('killed'), 'strong tests must kill mutants');
    assert.ok(verdicts.has('survived'), 'weak isPositive test must let a mutant survive');
    // the surviving mutant should be the isPositive boundary mutant
    const survived = flowA.results.filter((r) => r.verdict === 'survived');
    assert.ok(
      survived.some((r) => r.mutant.operator === 'relational-boundary' && r.mutant.original === '>'),
      `expected the isPositive '>' → '>=' mutant to survive; survived: ${survived.map((r) => r.mutant.id).join(', ')}`,
    );
    const totals = summarize(flowA.results, flowA.generated, flowA.results.length);
    const score = mutationScore(totals);
    assert.ok(score !== null && score > 0 && score < 1, `score must be a proper fraction, got ${score}`);
  });

  it('report builds and renders', () => {
    const report = buildReport(
      {
        runId: 'flow-test',
        seed: SEED,
        targetDir: FIXTURE_DIR,
        files: ['calc.ts'],
        testFiles: ['calc.test.ts'],
        sampling: { maxMutants: 10, perFileCap: 10 },
        timeoutMs: 20_000,
      },
      flowA.results,
      flowA.generated,
    );
    assert.equal(report.totals.sampled, flowA.results.length);
    assert.equal(report.totals.generated, flowA.generated);
    const md = renderMarkdown(report);
    assert.ok(md.includes('mutation score:'));
    assert.ok(md.includes('| killed'));
  });
});

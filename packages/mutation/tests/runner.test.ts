/**
 * Tests for mutant execution: verdicts, timeout breaker, scratch isolation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMutant,
  buildReport,
  childEnv,
  defaultTestCommand,
  generateMutants,
  PERSISTED_OUTPUT_TAIL_NOTE,
  prepareScratch,
  readTargetFile,
  runMutantTests,
  stripReportForPersist,
  type Mutant,
} from '../src/index';

// Fixture sources live in the source tree (not copied to dist); the package
// test suite always runs in-repo.
const FIXTURE_DIR = join(__dirname, '..', '..', 'tests', 'fixtures', 'calc');
const TARGET_SRC = readTargetFile(FIXTURE_DIR, 'calc.ts');

function fakeMutant(over: Partial<Mutant> = {}): Mutant {
  return {
    id: 'calc.ts:2:12:arithmetic-plus',
    file: 'calc.ts',
    operator: 'arithmetic-plus',
    line: 2,
    column: 12,
    offset: TARGET_SRC.indexOf('+'),
    length: 1,
    original: '+',
    replacement: '-',
    description: '`+` → `-`',
    ...over,
  };
}

function makeTarget(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-target-'));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('prepareScratch', () => {
  it('never writes the mutant into the real target dir', () => {
    const { dir, cleanup } = makeTarget();
    try {
      const mutant = fakeMutant();
      const prep = prepareScratch(dir, mutant, applyMutant(TARGET_SRC, mutant));
      try {
        // real tree untouched
        assert.equal(readTargetFile(dir, 'calc.ts'), TARGET_SRC);
        // scratch has the mutant
        assert.ok(readFileSync(prep.mutatedFileAbs, 'utf8').includes('return a - b;'));
        assert.ok(prep.scratchDir !== dir);
      } finally {
        prep.cleanup();
      }
    } finally {
      cleanup();
    }
  });
});

describe('runMutantTests verdicts', () => {
  it('killed: strong test fails with the mutant', async () => {
    const { dir, cleanup } = makeTarget();
    try {
      const mutant = fakeMutant();
      const prep = prepareScratch(dir, mutant, applyMutant(TARGET_SRC, mutant));
      try {
        const r = await runMutantTests(
          mutant,
          { scratchDir: prep.scratchDir, mutatedFileAbs: prep.mutatedFileAbs },
          { testCommand: defaultTestCommand(['calc.test.ts']), timeoutMs: 15_000, maxOutputBytes: 65536, nodeCheck: true },
        );
        assert.equal(r.verdict, 'killed');
        assert.equal(r.timedOut, false);
        assert.ok(r.exitCode !== 0 || /not ok/.test(r.outputTail));
      } finally {
        prep.cleanup();
      }
    } finally {
      cleanup();
    }
  });

  it('survived: no-op mutant keeps tests green', async () => {
    const { dir, cleanup } = makeTarget();
    try {
      // mutant that changes nothing semantically: `a + b` → `a + b`
      const mutant = fakeMutant({ replacement: '+', description: 'no-op' });
      const prep = prepareScratch(dir, mutant, applyMutant(TARGET_SRC, mutant));
      try {
        const r = await runMutantTests(
          mutant,
          { scratchDir: prep.scratchDir, mutatedFileAbs: prep.mutatedFileAbs },
          { testCommand: defaultTestCommand(['calc.test.ts']), timeoutMs: 15_000, maxOutputBytes: 65536, nodeCheck: true },
        );
        assert.equal(r.verdict, 'survived');
      } finally {
        prep.cleanup();
      }
    } finally {
      cleanup();
    }
  });

  it('invalid: syntax-breaking mutant is excluded from the score', async () => {
    const { dir, cleanup } = makeTarget();
    try {
      const mutant = fakeMutant({ replacement: ';', description: 'break syntax' });
      const mutated = applyMutant(TARGET_SRC, mutant); // `return a ; b;` — wait, this is valid...
      // use a truly invalid splice instead:
      const bad = TARGET_SRC.replace('return a + b;', 'return a +;');
      const prep = prepareScratch(dir, mutant, bad);
      try {
        assert.equal(mutated.includes('return a ; b;'), true); // sanity: applyMutant spliced
        const r = await runMutantTests(
          mutant,
          { scratchDir: prep.scratchDir, mutatedFileAbs: prep.mutatedFileAbs },
          { testCommand: defaultTestCommand(['calc.test.ts']), timeoutMs: 15_000, maxOutputBytes: 65536, nodeCheck: true },
        );
        assert.equal(r.verdict, 'invalid');
        assert.ok(/parse|check/i.test(r.note), `note should explain invalidity, got: ${r.note}`);
      } finally {
        prep.cleanup();
      }
    } finally {
      cleanup();
    }
  });

  it('timeout: hanging test command trips the circuit breaker', async () => {
    const { dir, cleanup } = makeTarget();
    try {
      const mutant = fakeMutant();
      const prep = prepareScratch(dir, mutant, applyMutant(TARGET_SRC, mutant));
      try {
        const r = await runMutantTests(
          mutant,
          { scratchDir: prep.scratchDir, mutatedFileAbs: prep.mutatedFileAbs },
          {
            testCommand: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
            timeoutMs: 800,
            maxOutputBytes: 65536,
            nodeCheck: false,
          },
        );
        assert.equal(r.verdict, 'timeout');
        assert.equal(r.timedOut, true);
        assert.ok(r.durationMs < 30_000, `breaker fired promptly, took ${r.durationMs}ms`);
      } finally {
        prep.cleanup();
      }
    } finally {
      cleanup();
    }
  });
});

describe('generateMutants on a small target', () => {
  it('finds the + mutant at the expected site', () => {
    const src = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
    const mutants = generateMutants(src, 'calc.ts');
    assert.equal(mutants.length, 1);
    assert.equal(mutants[0].operator, 'arithmetic-plus');
  });
});

// Fake credential values used ONLY as leak markers in this test. They are
// invented here, never real secrets, and never leave the temp dirs.
const FAKE_TOKEN = 'PROOF-ONLY-7f3a9c-FAKETOKEN1234';
const FAKE_SECRET = 'PROOF-ONLY-7f3a9c-FAKESECRET12';

describe('R16 N2: credential scrub + persisted-report stripping', () => {
  it('childEnv drops ambient credentials and persisted reports omit outputTail', async () => {
    // --- (1) childEnv scrub ---
    const prevToken = process.env.FACTORY_API_TOKEN;
    const prevSecret = process.env.FACTORY_SECRET_ALPHA;
    process.env.FACTORY_API_TOKEN = FAKE_TOKEN;
    process.env.FACTORY_SECRET_ALPHA = FAKE_SECRET;
    try {
      const env = childEnv();
      // Line-start assignment-line assertions (R13 iron rule): never a
      // whole-text substring assert — an ambient variable's VALUE can
      // contain a credential key name as text (JARVIS_TRACE_CONTEXT).
      const lines = Object.entries(env).map(([k, v]) => `${k}=${v ?? ''}`);
      assert.ok(!lines.some((l) => l.startsWith('FACTORY_API_TOKEN=')), 'childEnv must not carry FACTORY_API_TOKEN');
      assert.ok(!lines.some((l) => l.startsWith('FACTORY_SECRET_ALPHA=')), 'childEnv must not carry FACTORY_SECRET_*');
      assert.equal(env['PATH'], process.env['PATH'], 'non-credential env passes through');
      // Negative control: the unscrubbed ambient copy DOES carry them —
      // proves this test would catch a scrub regression.
      assert.equal(process.env.FACTORY_API_TOKEN, FAKE_TOKEN);
      assert.equal(process.env.FACTORY_SECRET_ALPHA, FAKE_SECRET);
    } finally {
      if (prevToken === undefined) delete process.env.FACTORY_API_TOKEN;
      else process.env.FACTORY_API_TOKEN = prevToken;
      if (prevSecret === undefined) delete process.env.FACTORY_SECRET_ALPHA;
      else process.env.FACTORY_SECRET_ALPHA = prevSecret;
    }

    // --- (2) round-trip: a planted test leaks a literal marker line ---
    // The test both prints the marker and throws it in the failure
    // message, so the marker lands in the captured child output
    // regardless of how the TAP reporter renders console output.
    const dir = mkdtempSync(join(tmpdir(), 'mutation-leak-'));
    try {
      writeFileSync(join(dir, 'leak.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
      writeFileSync(
        join(dir, 'leak.test.ts'),
        "import { test } from 'node:test';\n" +
          "import assert from 'node:assert/strict';\n" +
          "import { add } from './leak.ts';\n" +
          '\n' +
          "test('add', () => {\n" +
          // Log first, then throw the marker in the failure message: the
          // assert on add() would fail first under the mutant and hide
          // both, so the leak is produced before any assertion runs.
          `  console.log('FACTORY_API_TOKEN=${FAKE_TOKEN}');\n` +
          "  assert.equal(typeof add, 'function');\n" +
          `  throw new Error('leaked marker FACTORY_API_TOKEN=${FAKE_TOKEN}');\n` +
          '});\n',
      );
      const src = readTargetFile(dir, 'leak.ts');
      const mutant: Mutant = {
        id: 'leak.ts:2:12:arithmetic-plus',
        file: 'leak.ts',
        operator: 'arithmetic-plus',
        line: 2,
        column: 12,
        offset: src.indexOf('+'),
        length: 1,
        original: '+',
        replacement: '-',
        description: '`+` → `-`',
      };
      const prep = prepareScratch(dir, mutant, applyMutant(src, mutant));
      try {
        const r = await runMutantTests(
          mutant,
          { scratchDir: prep.scratchDir, mutatedFileAbs: prep.mutatedFileAbs },
          { testCommand: defaultTestCommand(['leak.test.ts']), timeoutMs: 15_000, maxOutputBytes: 65536, nodeCheck: true },
        );
        const report = buildReport(
          {
            runId: 'probe',
            seed: 1,
            targetDir: dir,
            files: ['leak.ts'],
            testFiles: ['leak.test.ts'],
            sampling: { maxMutants: 10, perFileCap: 10 },
            timeoutMs: 15_000,
          },
          [{ mutant, ...r }],
          1,
        );
        // Control: the in-memory report really captured the marker —
        // without this, the persist assertion below would be vacuous.
        assert.ok(
          JSON.stringify(report).includes(FAKE_TOKEN),
          'in-memory report must contain the leaked marker (control)',
        );
        const persisted = stripReportForPersist(report);
        const persistedJson = JSON.stringify(persisted, null, 2);
        assert.equal(persisted.results[0].outputTail, PERSISTED_OUTPUT_TAIL_NOTE);
        // The marker value is a unique fake invented in this test, so a
        // value-substring assert is safe here (it cannot occur in ambient
        // env the way a bare key name can).
        assert.ok(!persistedJson.includes(FAKE_TOKEN), 'persisted report must not contain the marker value');
        assert.ok(
          !persistedJson.split('\n').some((l) => l.trimStart().startsWith('FACTORY_API_TOKEN=')),
          'persisted report must not contain a credential assignment line',
        );
        // The strip returns a copy: the in-memory report is untouched.
        assert.ok(report.results[0].outputTail.includes(FAKE_TOKEN));
      } finally {
        prep.cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

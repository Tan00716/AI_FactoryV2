/**
 * Tests for mutant execution: verdicts, timeout breaker, scratch isolation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMutant,
  defaultTestCommand,
  generateMutants,
  prepareScratch,
  readTargetFile,
  runMutantTests,
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

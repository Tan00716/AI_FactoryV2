/**
 * Tests for seeded mutant sampling.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SAMPLING,
  sampleMutants,
  validateSamplingConfig,
  type Mutant,
  type SamplingConfig,
} from '../src/index';

function mkMutant(file: string, line: number, operator = 'arithmetic-plus'): Mutant {
  return {
    id: `${file}:${line}:1:${operator}`,
    file,
    operator,
    line,
    column: 1,
    offset: 0,
    length: 1,
    original: '+',
    replacement: '-',
    description: '`+` → `-`',
  };
}

describe('validateSamplingConfig', () => {
  it('accepts empty input as defaults', () => {
    const { config, errors } = validateSamplingConfig(undefined);
    assert.deepEqual(errors, []);
    assert.deepEqual(config, DEFAULT_SAMPLING);
  });

  it('accepts numeric and string seeds', () => {
    const a = validateSamplingConfig({ seed: 42 });
    assert.deepEqual(a.errors, []);
    assert.equal(a.config.seed, 42);
    const b = validateSamplingConfig({ seed: 'hello' });
    assert.deepEqual(b.errors, []);
    assert.equal(typeof b.config.seed, 'number');
  });

  it('rejects bad budgets', () => {
    const { errors } = validateSamplingConfig({ maxMutants: 0, perFileCap: 1.5 });
    assert.equal(errors.length, 2);
  });
});

describe('sampleMutants', () => {
  const mutants: Mutant[] = [
    ...[1, 2, 3, 4, 5].map((l) => mkMutant('b.ts', l)),
    ...[1, 2, 3].map((l) => mkMutant('a.ts', l)),
  ];

  it('is deterministic for a fixed seed', () => {
    const cfg: SamplingConfig = { seed: 7, maxMutants: 4, perFileCap: 10 };
    const a = sampleMutants(mutants, cfg).map((m) => m.id);
    const b = sampleMutants(mutants, cfg).map((m) => m.id);
    assert.deepEqual(a, b);
  });

  it('different seeds give different samples (probabilistically certain here)', () => {
    const a = sampleMutants(mutants, { seed: 1, maxMutants: 4, perFileCap: 10 }).map((m) => m.id);
    const b = sampleMutants(mutants, { seed: 2, maxMutants: 4, perFileCap: 10 }).map((m) => m.id);
    assert.notDeepEqual(a, b);
  });

  it('respects maxMutants and perFileCap', () => {
    const sample = sampleMutants(mutants, { seed: 7, maxMutants: 4, perFileCap: 2 });
    assert.equal(sample.length, 4);
    const perFile = new Map<string, number>();
    for (const m of sample) perFile.set(m.file, (perFile.get(m.file) ?? 0) + 1);
    for (const n of perFile.values()) assert.ok(n <= 2);
  });

  it('returns all mutants when budgets allow', () => {
    const sample = sampleMutants(mutants, { seed: 7, maxMutants: 100, perFileCap: 100 });
    assert.equal(sample.length, mutants.length);
  });
});

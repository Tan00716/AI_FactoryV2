import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLargeFile, generateRepo, mulberry32 } from '../src/seed.js';

test('mulberry32 is deterministic per seed and differs across seeds', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  const seqC = [c(), c(), c()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

test('generateRepo is byte-identical for the same seed', () => {
  const d1 = mkdtempSync(join(tmpdir(), 'perfbench-seed-a-'));
  const d2 = mkdtempSync(join(tmpdir(), 'perfbench-seed-b-'));
  try {
    const g1 = generateRepo(join(d1, 'repo'), 100, 7);
    const g2 = generateRepo(join(d2, 'repo'), 100, 7);
    assert.equal(g1.files, g2.files);
    assert.equal(g1.bytes, g2.bytes);
    assert.equal(g1.files, 150); // 100 generated + 50 utils
    const walk = (root: string): string[] => {
      const out: string[] = [];
      const rec = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) rec(p);
          else out.push(p);
        }
      };
      rec(root);
      return out.sort();
    };
    const f1 = walk(join(d1, 'repo'));
    const f2 = walk(join(d2, 'repo'));
    assert.equal(f1.length, f2.length);
    for (let i = 0; i < f1.length; i++) {
      const rel1 = (f1[i] as string).slice(d1.length);
      const rel2 = (f2[i] as string).slice(d2.length);
      assert.equal(rel1, rel2);
      assert.equal(readFileSync(f1[i] as string, 'utf8'), readFileSync(f2[i] as string, 'utf8'));
    }
  } finally {
    rmSync(d1, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
  }
});

test('generateRepo differs across seeds', () => {
  const d1 = mkdtempSync(join(tmpdir(), 'perfbench-seed-c-'));
  const d2 = mkdtempSync(join(tmpdir(), 'perfbench-seed-d-'));
  try {
    generateRepo(join(d1, 'repo'), 50, 1);
    generateRepo(join(d2, 'repo'), 50, 2);
    const a = readFileSync(join(d1, 'repo', 'src', 'mod_0', 'file_0.ts'), 'utf8');
    const b = readFileSync(join(d2, 'repo', 'src', 'mod_0', 'file_0.ts'), 'utf8');
    assert.notEqual(a, b);
  } finally {
    rmSync(d1, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
  }
});

test('generateLargeFile reaches at least the target size', () => {
  const d = mkdtempSync(join(tmpdir(), 'perfbench-large-'));
  try {
    const bytes = generateLargeFile(join(d, 'large.ts'), 1024 * 1024);
    assert.ok(bytes >= 1024 * 1024);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

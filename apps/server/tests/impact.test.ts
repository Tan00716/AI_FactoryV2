/**
 * Change impact analysis tests (second-round ⑥) — imports
 * ../src/impact.ts straight from src: impact.ts is node builtins +
 * type-only imports only (dual-mode import rule in AGENTS.md).
 *
 * Covers: export extraction (TS/JS/Python/Go, honest unsupported),
 * contract diff (removed/added/signature/kind + rename hint),
 * reverse-reference BFS layering with evidence, git baseline helpers
 * over a temp real repo, and the quality-gate impact config validation
 * (inline in quality-gate.ts).
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/impact.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  analyzeRefs,
  diffContracts,
  extractExports,
  readGitFile,
  workingTreeChangedFiles,
} from '../src/impact.ts';
import type { IndexData } from '@ai-factory/codeindex';
import { defaultQualityGateConfig, validateQualityGateConfig } from '../src/quality-gate.ts';

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

const TS_SAMPLE = [
  'import { x } from "./x";',
  'export function computeTotal(items: number[]): number {',
  '  return items.reduce((a, b) => a + b, 0);',
  '}',
  'export async function loadUser(id: string): Promise<User> {',
  'export class Store extends Base {',
  'export const VERSION = "1.0.0";',
  'export const draw = (ctx: Ctx) => {',
  'export interface User { id: string }',
  'export type Id = string | number;',
  'export enum Color { Red, Blue }',
  'export { helper } from "./h";',
  'export { thing, other as alias };',
  'const notExported = 1;',
  'function plainFn() {}',
].join('\n');

test('extractExports: TS/JS surface incl. list exports, ignores non-exports', () => {
  const { supported, exports: exps } = extractExports('src/lib.ts', TS_SAMPLE);
  assert.equal(supported, true);
  const names = exps.map((e) => e.name).sort();
  assert.deepEqual(names, [
    'Color',
    'Id',
    'Store',
    'User',
    'VERSION',
    'alias',
    'computeTotal',
    'draw',
    'helper',
    'loadUser',
    'thing',
  ]);
  const fn = exps.find((e) => e.name === 'computeTotal');
  assert.equal(fn?.kind, 'function');
  assert.ok(fn?.signature.includes('items: number[]'), 'signature carries params');
  const listExp = exps.find((e) => e.name === 'helper');
  assert.equal(listExp?.kind, 'export');
});

test('extractExports: Python defs/classes/all-caps; skips _private', () => {
  const src = [
    'import os',
    'def compute_total(items):',
    '    return sum(items)',
    'class Store(Base):',
    '    pass',
    'MAX_RETRIES = 3',
    'def _private_helper():',
    '    pass',
    'normal_var = 1',
  ].join('\n');
  const { supported, exports: exps } = extractExports('mod.py', src);
  assert.equal(supported, true);
  assert.deepEqual(exps.map((e) => e.name).sort(), ['MAX_RETRIES', 'Store', 'compute_total']);
});

test('extractExports: Go exported names incl. methods', () => {
  const src = [
    'package demo',
    'func ComputeTotal(items []int) int {',
    'func helper() {}',
    'type Store struct {',
    'func (s *Store) Save() error {',
    'const MaxRetries = 3',
    'var counter = 0',
  ].join('\n');
  const { supported, exports: exps } = extractExports('demo.go', src);
  assert.equal(supported, true);
  assert.deepEqual(exps.map((e) => e.name).sort(), ['ComputeTotal', 'MaxRetries', 'Save', 'Store']);
  const m = exps.find((e) => e.name === 'Save');
  assert.equal(m?.kind, 'method');
});

test('extractExports: unsupported extension reports supported=false', () => {
  const r = extractExports('README.md', '# hi');
  assert.equal(r.supported, false);
  assert.deepEqual(r.exports, []);
});

// ---------------------------------------------------------------------------
// Contract diff
// ---------------------------------------------------------------------------

function exp(name: string, kind: string, signature: string) {
  return { name, kind, signature, line: 1 };
}

test('diffContracts: removed → breaking, added → non-breaking', () => {
  const before = [exp('computeTotal', 'function', 'export function computeTotal(a: number[])')];
  const after = [exp('newThing', 'function', 'export function newThing()')];
  const changes = diffContracts(before, after);
  const rem = changes.find((c) => c.name === 'computeTotal');
  assert.equal(rem?.change, 'removed');
  assert.equal(rem?.breaking, true);
  const add = changes.find((c) => c.name === 'newThing');
  assert.equal(add?.change, 'added');
  assert.equal(add?.breaking, false);
});

test('diffContracts: signature change and kind change are breaking; identical is silent', () => {
  const before = [
    exp('f', 'function', 'export function f(a: number)'),
    exp('K', 'variable', 'export const K ='),
  ];
  const after = [
    exp('f', 'function', 'export function f(a: number, b: string)'),
    exp('K', 'variable', 'export const K ='),
  ];
  const changes = diffContracts(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].change, 'signature-changed');
  assert.equal(changes[0].breaking, true);

  const kindChanges = diffContracts(
    [exp('Thing', 'class', 'export class Thing')],
    [exp('Thing', 'function', 'export function Thing()')],
  );
  assert.equal(kindChanges.length, 1);
  assert.equal(kindChanges[0].change, 'kind-changed');
  assert.equal(kindChanges[0].breaking, true);
});

test('diffContracts: rename hint on identical-signature remove+add, still breaking', () => {
  const before = [exp('oldName', 'function', 'export function oldName(x: number)')];
  const after = [exp('newName', 'function', 'export function oldName(x: number)')];
  const changes = diffContracts(before, after);
  const rem = changes.find((c) => c.name === 'oldName');
  assert.equal(rem?.breaking, true);
  assert.ok(rem?.reason.includes('possible rename'), `reason: ${rem?.reason}`);
});

// ---------------------------------------------------------------------------
// Reverse-reference BFS
// ---------------------------------------------------------------------------

function symbol(name: string, file: string, line: number) {
  return { name, kind: 'function' as const, file, line, snippet: `${name}` };
}

function makeIndex(): IndexData {
  // lib.ts: computeTotal + cloneOf? (clone defined in twin.ts too)
  // a.ts: references computeTotal; defines runA
  // b.ts: references computeTotal
  // c.ts: references runA (hop 2 via a.ts)
  // twin.ts: ALSO defines computeTotal (same-name definer — excluded)
  // empty.ts: nothing
  const files = [
    { rel: 'lib.ts', mtimeMs: 0, size: 0, symbols: [symbol('computeTotal', 'lib.ts', 1)], tokens: {} },
    { rel: 'a.ts', mtimeMs: 0, size: 0, symbols: [symbol('runA', 'a.ts', 1)], tokens: {} },
    { rel: 'b.ts', mtimeMs: 0, size: 0, symbols: [], tokens: {} },
    { rel: 'c.ts', mtimeMs: 0, size: 0, symbols: [], tokens: {} },
    { rel: 'twin.ts', mtimeMs: 0, size: 0, symbols: [symbol('computeTotal', 'twin.ts', 1)], tokens: {} },
    { rel: 'empty.ts', mtimeMs: 0, size: 0, symbols: [], tokens: {} },
  ];
  const symbols = files.flatMap((f) => f.symbols);
  // inverted: token → [fileIndex, line]
  const inverted: Record<string, [number, number][]> = {
    computetotal: [
      [0, 1], // lib.ts defines it (token present)
      [1, 3], // a.ts references at line 3
      [2, 7], // b.ts references at line 7
      [4, 1], // twin.ts defines it
    ],
    runa: [
      [1, 1], // a.ts defines
      [3, 2], // c.ts references at line 2
    ],
  };
  return { version: 1, root: '/x', builtAt: 0, files, symbols, inverted };
}

test('analyzeRefs: BFS layers, evidence, same-name definer excluded', () => {
  const idx = makeIndex();
  const r = analyzeRefs(idx, ['lib.ts']);
  assert.deepEqual(r.layers.map((l) => l.files), [['a.ts', 'b.ts'], ['c.ts']]);
  assert.deepEqual(r.affectedFiles, ['a.ts', 'b.ts', 'c.ts']);
  const edgeB = r.edges.find((e) => e.fromFile === 'b.ts');
  assert.equal(edgeB?.symbol, 'computeTotal');
  assert.equal(edgeB?.line, 7);
  assert.equal(edgeB?.changedFile, 'lib.ts');
  assert.equal(edgeB?.hop, 1);
  const edgeC = r.edges.find((e) => e.fromFile === 'c.ts');
  assert.equal(edgeC?.changedFile, 'a.ts');
  assert.equal(edgeC?.hop, 2);
  assert.ok(!r.affectedFiles.includes('twin.ts'), 'same-name definer is not downstream');
});

test('analyzeRefs: maxDepth respected; unknown changed file is a no-op', () => {
  const idx = makeIndex();
  const r = analyzeRefs(idx, ['./lib.ts'], { maxDepth: 1 });
  assert.deepEqual(r.layers.map((l) => l.files), [['a.ts', 'b.ts']]);
  const none = analyzeRefs(idx, ['does/not-exist.ts']);
  assert.deepEqual(none.affectedFiles, []);
  assert.deepEqual(none.edges, []);
});

test('analyzeRefs: baseline extras — a removed export still finds its referrers', () => {
  // Post-change index: lib.ts no longer defines computeTotal (only
  // VERSION), but a.ts still references the name. Without the baseline
  // extras there is no frontier symbol to walk from.
  const files = [
    { rel: 'lib.ts', mtimeMs: 0, size: 0, symbols: [symbol('VERSION', 'lib.ts', 1)], tokens: {} },
    { rel: 'a.ts', mtimeMs: 0, size: 0, symbols: [symbol('runA', 'a.ts', 1)], tokens: {} },
  ];
  const idx: IndexData = {
    version: 1,
    root: '/x',
    builtAt: 0,
    files,
    symbols: files.flatMap((f) => f.symbols),
    inverted: {
      computetotal: [
        [1, 3], // a.ts references at line 3
      ],
      runa: [[0, 5]],
    },
  };
  const bare = analyzeRefs(idx, ['lib.ts']);
  assert.deepEqual(bare.affectedFiles, [], 'without baseline knowledge there is nothing to walk');
  const withExtras = analyzeRefs(idx, ['lib.ts'], {
    extraSymbols: { 'lib.ts': ['computeTotal'] },
  });
  assert.deepEqual(withExtras.affectedFiles, ['a.ts']);
  const e = withExtras.edges.find((x) => x.fromFile === 'a.ts');
  assert.equal(e?.symbol, 'computeTotal');
  assert.equal(e?.line, 3);
});

// ---------------------------------------------------------------------------
// Git helpers over a real temp repo
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Impact Test',
      GIT_AUTHOR_EMAIL: 'impact@example.test',
      GIT_COMMITTER_NAME: 'Impact Test',
      GIT_COMMITTER_EMAIL: 'impact@example.test',
    },
  });
}

test('git helpers: readGitFile baseline + working-tree changed list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-impact-git-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const v1 = 'export function computeTotal(xs: number[]) { return 0; }\n';
    fs.writeFileSync(path.join(dir, 'src/lib.ts'), v1);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'initial']);
    // Working tree: remove the export, add an untracked file.
    fs.writeFileSync(path.join(dir, 'src/lib.ts'), 'export const OTHER = 1;\n');
    fs.writeFileSync(path.join(dir, 'src/new.ts'), 'export const FRESH = 2;\n');

    assert.equal(readGitFile(dir, 'HEAD', 'src/lib.ts'), v1);
    assert.equal(readGitFile(dir, 'HEAD', 'src/missing.ts'), null);
    assert.equal(readGitFile(dir, '--bad-ref', 'src/lib.ts'), null, 'ref allowlist');
    assert.equal(readGitFile(dir, 'HEAD', '../outside.ts'), null, 'path escape rejected');
    assert.equal(readGitFile(dir, 'HEAD', '/etc/passwd'), null, 'absolute path rejected');

    const changed = workingTreeChangedFiles(dir);
    assert.ok(changed !== null);
    assert.deepEqual(changed, ['src/lib.ts', 'src/new.ts']);

    const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-impact-norepo-'));
    try {
      assert.equal(workingTreeChangedFiles(noRepo), null, 'not a repo → null, never throws');
    } finally {
      fs.rmSync(noRepo, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Quality gate impact config validation (inline in quality-gate.ts)
// ---------------------------------------------------------------------------

test('quality gate config: impact.failOnBreaking defaults off, validates shape', () => {
  assert.equal(defaultQualityGateConfig().impact.failOnBreaking, false);
  const off = validateQualityGateConfig({});
  assert.equal(off.errors.length, 0);
  assert.equal(off.config.impact.failOnBreaking, false);
  const on = validateQualityGateConfig({ impact: { failOnBreaking: true } });
  assert.equal(on.errors.length, 0);
  assert.equal(on.config.impact.failOnBreaking, true);
  const bad = validateQualityGateConfig({ impact: { failOnBreaking: 'yes' } });
  assert.ok(bad.errors.some((e) => e.includes('impact.failOnBreaking')), JSON.stringify(bad.errors));
});

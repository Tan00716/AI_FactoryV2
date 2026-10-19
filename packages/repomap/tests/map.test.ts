/**
 * Repo map builder tests (node:test, run compiled from dist).
 *
 * Covers: determinism (byte-stable across runs), signature
 * correctness, heuristic reference counting, score monotonicity
 * (referenced > unreferenced for the same kind), token-budget
 * truncation behavior, incremental-update consistency, and
 * file-only entries for non-code files.
 *
 * Run: node scripts/run-tests-tmp.mjs --test packages/repomap/dist/tests/map.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildIndex } from '@ai-factory/codeindex';
import type { IndexData } from '@ai-factory/codeindex';
import { buildRepoMap, renderMarkdown, estimateTokens } from '../src/index.js';

let tmp: string;
let index: IndexData;

async function writeFile(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'repomap-test-'));
  await writeFile(
    'src/service.ts',
    'export class UserService {\n' +
      '  async getUser(id: string) { return { id }; }\n' +
      '}\n' +
      'export function createService() { return new UserService(); }\n' +
      'export function unusedHelper() { return 42; }\n',
  );
  await writeFile(
    'src/main.ts',
    "import { createService, UserService } from './service';\n" +
      'export function usedFn() { return createService(); }\n' +
      'const svc: UserService | null = null;\n' +
      'console.log(svc, usedFn());\n',
  );
  await writeFile(
    'src/unused.ts',
    'export function lonelyFn() { return 1; }\n',
  );
  await writeFile('notes.txt', 'UserService is mentioned in these notes.\n');
  await writeFile('src/app.py', 'class Handler:\n    def handle(self):\n        pass\n');
  const built = await buildIndex(tmp);
  index = built.index;
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('buildRepoMap', () => {
  it('is deterministic: same index → byte-identical map', () => {
    const a = buildRepoMap(index);
    const b = buildRepoMap(index);
    assert.equal(JSON.stringify(a.map), JSON.stringify(b.map));
    assert.equal(a.markdown, b.markdown);
  });

  it('extracts full signatures with file+line', () => {
    const { map } = buildRepoMap(index);
    const svc = map.files
      .flatMap((f) => f.symbols)
      .find((s) => s.name === 'UserService');
    assert.ok(svc, 'UserService symbol present');
    assert.equal(svc.kind, 'class');
    assert.equal(svc.file, 'src/service.ts');
    assert.equal(svc.line, 1);
    assert.ok(svc.signature.includes('class UserService'), `signature: ${svc.signature}`);
    // Python symbols too.
    const handler = map.files
      .flatMap((f) => f.symbols)
      .find((s) => s.name === 'Handler');
    assert.ok(handler, 'Python Handler symbol present');
    assert.equal(handler.kind, 'class');
  });

  it('counts heuristic references across files (name-based)', () => {
    const { map } = buildRepoMap(index);
    const byName = new Map(map.files.flatMap((f) => f.symbols).map((s) => [s.name, s]));
    // UserService: defined in service.ts, named in main.ts + notes.txt.
    assert.equal(byName.get('UserService')?.refs, 2);
    // createService: defined in service.ts, named in main.ts.
    assert.equal(byName.get('createService')?.refs, 1);
    // unusedHelper / lonelyFn: never named elsewhere.
    assert.equal(byName.get('unusedHelper')?.refs, 0);
    assert.equal(byName.get('lonelyFn')?.refs, 0);
  });

  it('scores monotonically: referenced symbols outrank unreferenced ones of the same kind', () => {
    const { map } = buildRepoMap(index);
    const byName = new Map(map.files.flatMap((f) => f.symbols).map((s) => [s.name, s]));
    const used = byName.get('createService');
    const unused = byName.get('unusedHelper');
    assert.ok(used && unused);
    assert.equal(used.kind, unused.kind);
    assert.ok(used.score > unused.score, `used=${used.score} unused=${unused.score}`);
    // Classes outrank functions at equal refs (kind weighting).
    const cls = byName.get('UserService');
    assert.ok(cls && used);
    assert.ok(cls.score > used.score, `class=${cls.score} function=${used.score}`);
  });

  it('sorts files by importance, ties broken deterministically', () => {
    const { map } = buildRepoMap(index);
    // service.ts defines the most-referenced symbols → first.
    assert.equal(map.files[0].file, 'src/service.ts');
    for (let i = 1; i < map.files.length; i++) {
      assert.ok(
        map.files[i - 1].score >= map.files[i].score,
        'files sorted by score desc',
      );
    }
  });

  it('truncates past the token budget and marks the cut', () => {
    const { map, markdown } = buildRepoMap(index, { maxTokens: 100 });
    assert.equal(map.truncated, true);
    assert.ok(map.omittedFiles > 0, 'some files omitted');
    assert.ok(markdown.includes('… truncated:'), 'markdown marks the cut');
    assert.ok(markdown.includes(`token budget 100`), 'budget named in marker');
    // Kept files all appear; omitted files do not.
    const keptNames = new Set(map.files.map((f) => f.file));
    for (const name of keptNames) assert.ok(markdown.includes(`## ${name}`));
    assert.ok(map.estimatedTokens <= 100 + 60, `tokens=${map.estimatedTokens}`);
  });

  it('does not truncate when the budget is generous', () => {
    const { map } = buildRepoMap(index, { maxTokens: 20000 });
    assert.equal(map.truncated, false);
    assert.equal(map.omittedFiles, 0);
    assert.equal(map.files.length, 5, 'all 5 fixture files mapped');
  });

  it('keeps file-only entries for non-code files', () => {
    const { map } = buildRepoMap(index);
    const notes = map.files.find((f) => f.file === 'notes.txt');
    assert.ok(notes, 'notes.txt mapped');
    assert.equal(notes.fileOnly, true);
    assert.equal(notes.symbols.length, 0);
  });

  it('renderMarkdown reproduces the map markdown', () => {
    const { map, markdown } = buildRepoMap(index, { maxTokens: 500 });
    assert.equal(renderMarkdown(map), markdown);
  });

  it('incremental rebuild matches a fresh full build', async () => {
    // Add a new symbol to main.ts, rebuild incrementally…
    const mainPath = path.join(tmp, 'src', 'main.ts');
    await fs.appendFile(mainPath, 'export function addedLater() { return 2; }\n');
    const { index: full2 } = await buildIndex(tmp);
    const { index: incr2 } = await buildIndex(tmp, { previous: index });
    const a = buildRepoMap(full2);
    const b = buildRepoMap(incr2);
    // builtAt comes from each buildIndex call's clock — normalize it;
    // everything else must be byte-identical.
    const norm = (m: { builtAt: number }) => JSON.stringify({ ...m, builtAt: 0 });
    assert.equal(norm(a.map), norm(b.map));
    const names = b.map.files.flatMap((f) => f.symbols).map((s) => s.name);
    assert.ok(names.includes('addedLater'), 'new symbol picked up incrementally');
  });
});

describe('estimateTokens', () => {
  it('is deterministic and monotonic', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
    assert.ok(estimateTokens('x'.repeat(100)) > estimateTokens('x'.repeat(10)));
  });
});

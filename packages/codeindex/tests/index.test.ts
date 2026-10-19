import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildIndex,
  saveIndex,
  loadIndex,
  CodeIndexService,
  CodeIndexError,
  getDefinition,
  searchSymbols,
  searchText,
} from '../src/index.js';

let tmp: string;
let cacheDir: string;

async function writeFile(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codeindex-test-'));
  cacheDir = path.join(tmp, 'cache');
  await writeFile('src/a.ts', 'export function alpha() {}\nexport class Beta {}\n');
  await writeFile('src/b.py', 'def gamma():\n    pass\n');
  await writeFile('README.md', '# hello world\nsome prose about alpha\n');
  await writeFile('.gitignore', 'ignored/\n*.log\n');
  await writeFile('ignored/skip.ts', 'export function noIndex() {}\n');
  await writeFile('debug.log', 'export function noLog() {}\n');
  await writeFile('node_modules/dep/index.js', 'export function noDep() {}\n');
  // binary file: NUL byte
  await fs.writeFile(path.join(tmp, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('buildIndex', () => {
  it('walks, extracts symbols, respects gitignore and skip dirs', async () => {
    const { index, stats } = await buildIndex(tmp);
    const names = index.symbols.map((s) => s.name);
    assert.ok(names.includes('alpha'));
    assert.ok(names.includes('Beta'));
    assert.ok(names.includes('gamma'));
    assert.ok(!names.includes('noIndex'), 'gitignored dir must be skipped');
    assert.ok(!names.includes('noLog'), '*.log must be skipped');
    assert.ok(!names.includes('noDep'), 'node_modules must be skipped');
    assert.ok(stats.files >= 4, `expected >=4 files, got ${stats.files}`);
    assert.equal(stats.full, true, 'first build is full');
  });

  it('round-trips through save/load', async () => {
    const { index } = await buildIndex(tmp);
    const dest = await saveIndex(cacheDir, index);
    assert.ok(dest.endsWith('.json'));
    const loaded = await loadIndex(cacheDir, tmp);
    assert.ok(loaded);
    assert.equal(loaded.symbols.length, index.symbols.length);
    assert.deepEqual(Object.keys(loaded.inverted).length, Object.keys(index.inverted).length);
  });

  it('incremental rebuild reuses unchanged files', async () => {
    const first = await buildIndex(tmp);
    await saveIndex(cacheDir, first.index);
    const loaded = await loadIndex(cacheDir, tmp);
    assert.ok(loaded);
    const second = await buildIndex(tmp, { previous: loaded });
    assert.equal(second.stats.full, false, 'no changes -> incremental');
    assert.equal(second.stats.symbols, first.stats.symbols);
    // Touch one file -> only that file is rebuilt, symbols update.
    await writeFile('src/a.ts', 'export function alpha() {}\nexport function delta() {}\n');
    const third = await buildIndex(tmp, { previous: second.index });
    const names = third.index.symbols.map((s) => s.name);
    assert.ok(names.includes('delta'), 'changed file re-parsed');
    assert.ok(!names.includes('Beta'), 'old symbols of changed file replaced');
    assert.ok(names.includes('gamma'), 'unchanged file symbols kept');
  });
});

describe('query', () => {
  it('searchSymbols ranks exact/prefix first', async () => {
    const { index } = await buildIndex(tmp);
    const hits = searchSymbols(index, 'alp');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].symbol, 'alpha');
    assert.equal(hits[0].file, 'src/a.ts');
    assert.equal(hits[0].line, 1);
  });

  it('searchText finds tokens in prose and code', async () => {
    const { index } = await buildIndex(tmp);
    const hits = searchText(index, 'prose');
    assert.ok(hits.some((h) => h.file === 'README.md'));
  });

  it('getDefinition finds exact symbol', async () => {
    const { index } = await buildIndex(tmp);
    const hits = getDefinition(index, 'gamma');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, 'src/b.py');
    assert.equal(hits[0].kind, 'function');
  });
});

describe('CodeIndexService path jail', () => {
  it('denies roots outside the allowlist (fail-closed)', async () => {
    const svc = new CodeIndexService({ cacheDir, roots: [path.join(tmp, 'src')] });
    await assert.rejects(svc.buildIndex(tmp), (e: unknown) => {
      const err = e as { code?: string };
      assert.ok(e instanceof CodeIndexError && err.code === 'ROOT_DENIED');
      return true;
    });
  });

  it('allows roots inside the allowlist, end to end', async () => {
    const svc = new CodeIndexService({ cacheDir, roots: [tmp] });
    const stats = await svc.buildIndex(tmp);
    assert.ok(stats.symbols > 0);
    const hits = await svc.search(tmp, 'alpha', 'symbols');
    assert.ok(hits.some((h) => h.symbol === 'alpha'));
    const def = await svc.getDefinition(tmp, 'gamma');
    assert.equal(def.length, 1);
  });

  it('empty roots = deny everything', async () => {
    const svc = new CodeIndexService({ cacheDir, roots: [] });
    await assert.rejects(svc.buildIndex(tmp), (e: unknown) => {
      const err = e as { code?: string };
      return e instanceof CodeIndexError && err.code === 'ROOT_DENIED';
    });
  });
});

/**
 * Unit tests for @ai-factory/ignores — matcher boundaries + IgnoreSet
 * two-tier loading / hot reload / loud layer skips.
 *
 * Run (after build): node --test packages/ignores/dist/tests/*.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_HARD_IGNORE_TEMPLATE,
  IgnoreSet,
  evaluateIgnore,
  parseIgnoreText,
} from '../src/index.js';

const ROOT = '/proj';

function verdict(hard: string, rel: string, opts: { forIndex?: boolean; isDir?: boolean } = {}) {
  const set = IgnoreSet.fromTexts(ROOT, hard, null);
  return set.verdict(join(ROOT, rel), opts.forIndex ?? false, opts.isDir ?? false);
}

test('basename pattern matches at any depth', () => {
  assert.equal(verdict('*.log\n', 'a.log').ignored, true);
  assert.equal(verdict('*.log\n', 'a/b/c.log').ignored, true);
  assert.equal(verdict('*.log\n', 'a/b/c.log.txt').ignored, false);
  assert.equal(verdict('*.pem\n', 'certs/prod.pem').ignored, true);
});

test('anchored pattern matches from the root only', () => {
  assert.equal(verdict('/build/out\n', 'build/out').ignored, true);
  assert.equal(verdict('/build/out\n', 'src/build/out').ignored, false);
  assert.equal(verdict('build/out\n', 'build/out').ignored, true);
  assert.equal(verdict('build/out\n', 'sub/build/out').ignored, false);
});

test('** matches zero or more segments', () => {
  assert.equal(verdict('a/**/b\n', 'a/b').ignored, true);
  assert.equal(verdict('a/**/b\n', 'a/x/b').ignored, true);
  assert.equal(verdict('a/**/b\n', 'a/x/y/b').ignored, true);
  assert.equal(verdict('a/**/b\n', 'a/x/y/c').ignored, false);
  assert.equal(verdict('**/gen\n', 'gen').ignored, true);
  assert.equal(verdict('**/gen\n', 'a/b/gen').ignored, true);
  assert.equal(verdict('**/gen\n', 'a/b/gen2').ignored, false);
  // Leading `**/` anchored: only from the root.
  assert.equal(verdict('/docs/**\n', 'docs/a/b/c.md').ignored, true);
  assert.equal(verdict('/docs/**\n', 'sub/docs/a.md').ignored, false);
});

test('? matches exactly one non-slash character; character classes work', () => {
  assert.equal(verdict('file?.txt\n', 'file1.txt').ignored, true);
  assert.equal(verdict('file?.txt\n', 'file12.txt').ignored, false);
  assert.equal(verdict('file?.txt\n', 'file.txt').ignored, false);
  assert.equal(verdict('data[0-9].csv\n', 'data7.csv').ignored, true);
  assert.equal(verdict('data[0-9].csv\n', 'datax.csv').ignored, false);
});

test('negation re-includes (last match wins), file level', () => {
  const rules = '*.log\n!keep.log\n';
  assert.equal(verdict(rules, 'a/debug.log').ignored, true);
  assert.equal(verdict(rules, 'a/keep.log').ignored, false);
  assert.equal(verdict(rules, 'keep.log').ignored, false);
  // Order matters: the negation must come after.
  assert.equal(verdict('!keep.log\n*.log\n', 'keep.log').ignored, true);
});

test('directory pattern prunes the whole subtree (non-dirOnly too)', () => {
  assert.equal(verdict('secrets\n', 'secrets/prod.key').ignored, true);
  assert.equal(verdict('secrets\n', 'src/secrets/prod.key').ignored, true); // basename pattern hits a dir named secrets at any depth
  assert.equal(verdict('secrets/\n', 'secrets/deep/nested.txt').ignored, true);
});

test('dirOnly pattern does not match a plain file of the same name', () => {
  assert.equal(verdict('foo/\n', 'foo', { isDir: false }).ignored, false);
  assert.equal(verdict('foo/\n', 'foo', { isDir: true }).ignored, true);
});

test('sticky parent exclusion: deeper negation cannot re-include', () => {
  const rules = 'secrets/\n!secrets/keep.txt\n';
  assert.equal(verdict(rules, 'secrets/keep.txt').ignored, true);
  // But a negated *directory* pattern re-includes the directory itself.
  const rules2 = 'docs/\n!docs/\n';
  assert.equal(verdict(rules2, 'docs/a.md').ignored, false);
});

test('comments, blanks, escapes and trailing spaces', () => {
  const text = ['# comment', '', '  ', '*.tmp   ', '\\#weird', '*.log'].join('\n');
  const pats = parseIgnoreText(text);
  assert.equal(pats.length, 3);
  assert.equal(pats.some((p) => p.source === '#weird'), true);
  const hits = evaluateIgnore('x.tmp', false, pats);
  assert.equal(hits.ignored, true);
  assert.equal(hits.pattern?.line, 4);
});

test('verdict reports layer, pattern and line', () => {
  const set = IgnoreSet.fromTexts(ROOT, '# c\n*.log\n', null);
  const v = set.verdict(join(ROOT, 'x/y.log'));
  assert.equal(v.ignored, true);
  assert.equal(v.layer, 'hard');
  assert.equal(v.pattern, '*.log');
  assert.equal(v.line, 2);
});

test('indexing tier applies only forIndex=true', () => {
  const set = IgnoreSet.fromTexts(ROOT, null, 'gen/**\n');
  assert.equal(set.isIgnored(join(ROOT, 'gen/a.ts'), true), true);
  assert.equal(set.isIgnored(join(ROOT, 'gen/a.ts'), false), false);
  // And the hard tier applies in both modes.
  const both = IgnoreSet.fromTexts(ROOT, '*.pem\n', 'gen/**\n');
  assert.equal(both.isIgnored(join(ROOT, 'k.pem'), false), true);
  assert.equal(both.isIgnored(join(ROOT, 'k.pem'), true), true);
  assert.equal(both.verdict(join(ROOT, 'gen/a.ts'), true).layer, 'indexing');
});

test('paths outside the root are not our jurisdiction', () => {
  const set = IgnoreSet.fromTexts(ROOT, '**\n', null);
  // `**` excludes everything INSIDE the root...
  assert.equal(set.isIgnored(join(ROOT, 'anything.txt')), true);
  // ...but nothing outside it.
  assert.equal(set.isIgnored('/elsewhere/secret.txt'), false);
});

test('IgnoreSet.loadSync: missing files = empty layers, no errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ign-'));
  try {
    const set = IgnoreSet.loadSync(dir);
    assert.deepEqual(set.errors(), []);
    assert.equal(set.hardPatternCount(), 0);
    assert.equal(set.isIgnored(join(dir, 'a.env')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('IgnoreSet.loadSync: corrupt layer is loudly skipped, other layer still works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ign-'));
  try {
    mkdirSync(join(dir, '.ai-factory'), { recursive: true });
    // Hard layer corrupt (NUL byte); indexing layer fine.
    writeFileSync(join(dir, '.ai-factory', 'ignore'), Buffer.from([0x2a, 0x00, 0x6c, 0x6f, 0x67]));
    writeFileSync(join(dir, '.ai-factory', 'indexing-ignore'), 'gen/**\n');
    const set = IgnoreSet.loadSync(dir);
    const errs = set.errors();
    assert.equal(errs.length, 1);
    assert.equal(errs[0]?.layer, 'hard');
    assert.match(errs[0]?.message ?? '', /NUL/);
    // Corrupt layer matches nothing (loud skip, not silent swallow-all).
    assert.equal(set.isIgnored(join(dir, 'debug.log')), false);
    // Indexing layer still functions.
    assert.equal(set.isIgnored(join(dir, 'gen/a.ts'), true), true);
    assert.equal(set.layerStates().find((l) => l.name === 'hard')?.ok, false);
    assert.equal(set.layerStates().find((l) => l.name === 'indexing')?.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshIfChanged hot-reloads edited files (mtime)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ign-'));
  try {
    mkdirSync(join(dir, '.ai-factory'), { recursive: true });
    const f = join(dir, '.ai-factory', 'ignore');
    writeFileSync(f, '*.log\n');
    const set = IgnoreSet.loadSync(dir);
    assert.equal(set.isIgnored(join(dir, 'a.log')), true);
    assert.equal(set.isIgnored(join(dir, 'secret.pem')), false);
    // Edit the file + bump mtime deterministically.
    writeFileSync(f, '*.pem\n');
    const future = new Date(Date.now() + 5000);
    utimesSync(f, future, future);
    assert.equal(set.refreshIfChanged(), true);
    assert.equal(set.isIgnored(join(dir, 'a.log')), false);
    assert.equal(set.isIgnored(join(dir, 'secret.pem')), true);
    // No further change → no reload.
    assert.equal(set.refreshIfChanged(), false);
    // Deleting the file clears the layer.
    rmSync(f);
    assert.equal(set.refreshIfChanged(), true);
    assert.equal(set.isIgnored(join(dir, 'secret.pem')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DEFAULT_HARD_IGNORE_TEMPLATE parses and matches the classic secrets', () => {
  const set = IgnoreSet.fromTexts(ROOT, DEFAULT_HARD_IGNORE_TEMPLATE, null);
  assert.equal(set.isIgnored(join(ROOT, '.env')), true);
  assert.equal(set.isIgnored(join(ROOT, '.env.production')), true);
  assert.equal(set.isIgnored(join(ROOT, 'certs/prod.pem')), true);
  assert.equal(set.isIgnored(join(ROOT, 'home/user/id_rsa')), true);
  assert.equal(set.isIgnored(join(ROOT, 'app/secrets/api.txt')), true);
  assert.equal(set.isIgnored(join(ROOT, 'credentials.json')), true);
  assert.equal(set.isIgnored(join(ROOT, 'src/main.ts')), false);
});

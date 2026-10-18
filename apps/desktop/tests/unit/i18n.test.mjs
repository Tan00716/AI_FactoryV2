/**
 * Desktop i18n integrity tests (H1 test infra).
 * node:test + node:assert/strict. Run: node --test apps/desktop/tests/unit/i18n.test.mjs
 * (also runs as phase 1 of `npm run test:desktop`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', '..', 'src');

const { zh } = await import('../../src/i18n/zh.ts');
const { en } = await import('../../src/i18n/en.ts');

const zhKeys = new Set(Object.keys(zh));
const enKeys = new Set(Object.keys(en));

function walkTsx(dir, out = []) {
  for (const f of readdirSync(dir)) {
    if (f === 'i18n') continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walkTsx(p, out);
    else if (/\.(tsx|ts)$/.test(f)) out.push(p);
  }
  return out;
}

const placeholders = (s) => new Set([...s.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]));

test('zh/en key sets are identical', () => {
  const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));
  const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k));
  assert.deepEqual(onlyZh, [], `keys missing in en: ${onlyZh.slice(0, 10).join(', ')}`);
  assert.deepEqual(onlyEn, [], `keys missing in zh: ${onlyEn.slice(0, 10).join(', ')}`);
  assert.ok(zhKeys.size > 0, 'expected non-empty key set');
});

test('no duplicate keys in either pack (later wins silently in JS)', () => {
  for (const [name, file] of [['zh', 'zh.ts'], ['en', 'en.ts']]) {
    const src = readFileSync(join(srcDir, 'i18n', file), 'utf8');
    const keys = [...src.matchAll(/'([a-z][a-zA-Z0-9_.-]*)':/g)].map((m) => m[1]);
    const seen = new Set();
    const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    assert.deepEqual(dupes, [], `${name}: duplicate keys: ${dupes.join(', ')}`);
  }
});

test('every literal t(...) call in src has a key', () => {
  const missing = new Set();
  for (const f of walkTsx(srcDir)) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([a-z][a-zA-Z0-9_.-]*)'/g)) {
      if (!zhKeys.has(m[1])) missing.add(`${m[1]} (in ${f.split('apps/desktop/src/')[1]})`);
    }
  }
  assert.deepEqual([...missing], [], `missing keys: ${[...missing].slice(0, 10).join('; ')}`);
});

test('interpolation placeholders match between zh and en', () => {
  // Known intentional exceptions (documented, language-driven):
  // - changes.changeCount: Chinese needs no plural form.
  const ALLOWLIST = new Set(['changes.changeCount']);
  const bad = [];
  for (const k of zhKeys) {
    const a = placeholders(zh[k]);
    const b = placeholders(en[k]);
    const sa = [...a].sort().join(',');
    const sb = [...b].sort().join(',');
    if (sa !== sb && !ALLOWLIST.has(k)) bad.push(`${k}: zh={${sa}} en={${sb}}`);
  }
  assert.deepEqual(bad, [], `placeholder mismatch: ${bad.slice(0, 10).join('; ')}`);
});

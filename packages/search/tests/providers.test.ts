/**
 * Run: node --test dist/tests/providers.test.js (after tsc -p tsconfig.json;
 * root `npm run build` first so @ai-factory/security dist exists).
 *
 * Pins: option normalization caps, Bing RSS parsing, text cleaning,
 * keyed-provider key requirement.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BingRssProvider,
  BraveProvider,
  TavilyProvider,
  cleanText,
  parseBingRss,
  normalizeSearchOptions,
} from '../src/index';

const RSS_FIXTURE = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel>
<title>Bing: typescript playground</title>
<item><title>TypeScript: JavaScript With Syntax For Types.</title><link>https://www.typescriptlang.org/</link><description>TypeScript is JavaScript with &lt;strong&gt;syntax&lt;/strong&gt; for types.</description></item>
<item><title>Broken item without link</title><description>no link here</description></item>
<item><title>W3Schools</title><link>https://www.w3schools.com/typescript/</link><description>Try it yourself editor.</description></item>
</channel></rss>`;

describe('normalizeSearchOptions', () => {
  it('defaults count to 5 and clamps to [1,20]', () => {
    assert.equal(normalizeSearchOptions({}).count, 5);
    assert.equal(normalizeSearchOptions({ count: 99 }).count, 20);
    assert.equal(normalizeSearchOptions({ count: 0 }).count, 1);
  });
  it('clamps timeoutMs to [1000,60000]', () => {
    assert.equal(normalizeSearchOptions({}).timeoutMs, 15000);
    assert.equal(normalizeSearchOptions({ timeoutMs: 5 }).timeoutMs, 1000);
    assert.equal(normalizeSearchOptions({ timeoutMs: 999999 }).timeoutMs, 60000);
  });
});

describe('cleanText', () => {
  it('strips tags, decodes entities, collapses whitespace', () => {
    assert.equal(cleanText('<b>a</b> &amp; <i>b</i>'), 'a & b');
    assert.equal(cleanText('  x\n\ny  '), 'x y');
  });
});

describe('parseBingRss', () => {
  it('parses items, skips malformed ones, respects count', () => {
    const all = parseBingRss(RSS_FIXTURE, 10);
    assert.equal(all.length, 2);
    assert.equal(all[0].title, 'TypeScript: JavaScript With Syntax For Types.');
    assert.equal(all[0].url, 'https://www.typescriptlang.org/');
    assert.equal(all[0].snippet, 'TypeScript is JavaScript with syntax for types.');
    assert.equal(all[0].source, 'bing-rss');
    const one = parseBingRss(RSS_FIXTURE, 1);
    assert.equal(one.length, 1);
  });
  it('returns [] for garbage xml, never throws', () => {
    assert.deepEqual(parseBingRss('not xml at all', 5), []);
  });
});

describe('keyed providers', () => {
  it('BraveProvider and TavilyProvider refuse empty keys', () => {
    assert.throws(() => new BraveProvider(''), /API key/);
    assert.throws(() => new TavilyProvider(''), /API key/);
  });
  it('BingRssProvider needs no key', () => {
    const p = new BingRssProvider();
    assert.equal(p.requiresKey, false);
    assert.equal(new BraveProvider('k').requiresKey, true);
  });
  it('blank query short-circuits to [] without network', async () => {
    assert.deepEqual(await new BingRssProvider().search('   '), []);
  });
});

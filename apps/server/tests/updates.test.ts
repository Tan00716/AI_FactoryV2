/**
 * Update channel unit tests — imports ../src/updates.ts straight from src
 * under node's type-stripping ESM loader. That module is node builtins
 * only (no relative imports), so it resolves (dual-mode import rule).
 *
 * Run: npm run test:server (TMPDIR wrapper); or
 *   node --test apps/server/tests/updates.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  compareVersions,
  feedBaseUrl,
  getUpdateConfig,
  parseChangelog,
  parseSemver,
  parseUpdateFeed,
  readAppVersion,
  runUpdateCheck,
  type UpdateCheckDeps,
  type UpdateNotifyEvent,
} from '../src/updates.ts';

const VALID_FEED = `# electron-builder generic provider
version: 0.3.0
files:
  - url: AI-Factory-0.3.0.AppImage
    sha512: abc123
    size: 134217728
  - url: AI-Factory-0.3.0.exe
    sha512: def456
    size: 98765432
path: AI-Factory-0.3.0.AppImage
sha512: abc123
releaseDate: '2026-11-01T10:00:00.000Z'
`;

test('parseUpdateFeed: valid latest.yml parses version, files, metadata', () => {
  const f = parseUpdateFeed(VALID_FEED);
  assert.ok(f);
  assert.equal(f.version, '0.3.0');
  assert.equal(f.files.length, 2);
  assert.equal(f.files[0].url, 'AI-Factory-0.3.0.AppImage');
  assert.equal(f.files[0].sha512, 'abc123');
  assert.equal(f.files[0].size, 134217728);
  assert.equal(f.path, 'AI-Factory-0.3.0.AppImage');
  assert.equal(f.releaseDate, '2026-11-01T10:00:00.000Z');
});

test('parseUpdateFeed: fail-closed on empty / missing version / bad version / malformed', () => {
  assert.equal(parseUpdateFeed(''), null);
  assert.equal(parseUpdateFeed('   \n'), null);
  assert.equal(parseUpdateFeed('path: foo.AppImage\nsha512: x\n'), null);
  assert.equal(parseUpdateFeed('version: not-a-version\n'), null);
  assert.equal(parseUpdateFeed('version: 0.3.0\nthis is not kv\n'), null);
  assert.equal(parseUpdateFeed('version: 0.3.0\nfiles:\n  - sha512: nou\n'), null); // file without url
  assert.equal(parseUpdateFeed('version: 0.3.0\nfiles:\n  - url: a\n    size: nope\n'), null); // bad size
});

test('parseUpdateFeed: quoted values are unquoted, comments ignored', () => {
  const f = parseUpdateFeed('version: "0.3.1"\nreleaseDate: \'2026-11-02\'\n# comment\n');
  assert.ok(f);
  assert.equal(f.version, '0.3.1');
  assert.equal(f.releaseDate, '2026-11-02');
  assert.deepEqual(f.files, []);
});

test('parseSemver / compareVersions', () => {
  assert.ok(parseSemver('0.2.0'));
  assert.ok(parseSemver('v1.2.3'));
  assert.ok(parseSemver('1.0.0-beta.1'));
  assert.equal(parseSemver('x.y'), null);
  assert.equal(compareVersions('0.2.0', '0.3.0'), -1);
  assert.equal(compareVersions('0.3.0', '0.2.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1); // numeric, not lexicographic
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1); // prerelease < release
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('garbage', '0.1.0'), -1); // unparseable sorts below
  assert.equal(compareVersions('garbage', 'garbage'), 0);
});

test('getUpdateConfig: defaults and env overrides', () => {
  const d = getUpdateConfig({});
  assert.equal(d.feedUrl, '');
  assert.equal(d.checkIntervalMs, 6 * 3600 * 1000);
  assert.equal(d.autoCheck, true);

  const c = getUpdateConfig({
    FACTORY_UPDATE_FEED_URL: ' https://example.com/latest.yml ',
    FACTORY_UPDATE_CHECK_INTERVAL_MS: '3600000',
    FACTORY_UPDATE_AUTO_CHECK: 'false',
  });
  assert.equal(c.feedUrl, 'https://example.com/latest.yml');
  assert.equal(c.checkIntervalMs, 3600000);
  assert.equal(c.autoCheck, false);

  const bad = getUpdateConfig({ FACTORY_UPDATE_CHECK_INTERVAL_MS: 'nope' });
  assert.equal(bad.checkIntervalMs, 6 * 3600 * 1000);
  const tiny = getUpdateConfig({ FACTORY_UPDATE_CHECK_INTERVAL_MS: '1000' });
  assert.equal(tiny.checkIntervalMs, 6 * 3600 * 1000); // below min → default
});

test('feedBaseUrl: strips filename, rejects non-http', () => {
  assert.equal(feedBaseUrl('https://example.com/releases/latest.yml'), 'https://example.com/releases/');
  assert.equal(feedBaseUrl('http://127.0.0.1:8080/latest.yml?x=1'), 'http://127.0.0.1:8080/');
  assert.equal(feedBaseUrl('not a url'), null);
  assert.equal(feedBaseUrl('ftp://example.com/latest.yml'), null);
});

test('parseChangelog: keep-a-changelog-ish headers', () => {
  const entries = parseChangelog('## [0.3.0] (2026-11-01) —— 标题\n\n- 第一项\n- 第二项\n\n## [0.2.0] (2026-10-18)\n\n- 旧项\n');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].version, '0.3.0');
  assert.equal(entries[0].date, '2026-11-01');
  assert.equal(entries[0].title, '标题');
  assert.deepEqual(entries[0].notes, ['第一项', '第二项']);
  assert.equal(entries[1].version, '0.2.0');
  assert.equal(parseChangelog('').length, 0);
  assert.equal(parseChangelog('no headers here\n- bullet\n').length, 0);
});

test('parseChangelog: real repo CHANGELOG.md parses, first entry is 0.2.0', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const text = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const entries = parseChangelog(text, 5);
  assert.ok(entries.length >= 1);
  assert.equal(entries[0].version, '0.2.0');
  assert.ok(entries[0].notes.length > 0);
});

test('readAppVersion: reads root package.json, fail-closed', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  assert.equal(readAppVersion(repoRoot), '0.2.0');
  assert.equal(readAppVersion('/nonexistent-dir-xyz'), '0.0.0');
});

function makeDeps(over: Partial<UpdateCheckDeps> = {}): {
  deps: UpdateCheckDeps;
  notified: UpdateNotifyEvent[];
  audited: Array<{ action: string; details: Record<string, unknown> }>;
} {
  const notified: UpdateNotifyEvent[] = [];
  const audited: Array<{ action: string; details: Record<string, unknown> }> = [];
  const deps: UpdateCheckDeps = {
    config: { feedUrl: 'https://example.com/latest.yml', checkIntervalMs: 60000, autoCheck: true },
    currentVersion: '0.2.0',
    fetchText: async () => VALID_FEED,
    notify: (e) => { notified.push(e); },
    audit: (action, details) => { audited.push({ action, details }); },
    now: () => 1234567890,
    ...over,
  };
  return { deps, notified, audited };
}

test('runUpdateCheck: not-configured skips fetch, audits skip', async () => {
  let fetched = false;
  const { deps, notified, audited } = makeDeps({
    config: { feedUrl: '', checkIntervalMs: 60000, autoCheck: true },
    fetchText: async () => { fetched = true; return ''; },
  });
  const r = await runUpdateCheck(deps);
  assert.equal(r.status, 'not-configured');
  assert.equal(fetched, false);
  assert.equal(notified.length, 0);
  assert.equal(audited[0].action, 'UPDATE_CHECK_SKIPPED');
});

test('runUpdateCheck: newer feed → update-available + notify + audit', async () => {
  const { deps, notified, audited } = makeDeps();
  const r = await runUpdateCheck(deps);
  assert.equal(r.status, 'update-available');
  if (r.status === 'update-available') {
    assert.equal(r.current, '0.2.0');
    assert.equal(r.latest, '0.3.0');
  }
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, 'UPDATE_AVAILABLE');
  assert.equal(notified[0].entity.id, '0.3.0');
  assert.ok(audited.some((a) => a.action === 'UPDATE_AVAILABLE'));
});

test('runUpdateCheck: same/older feed → up-to-date, no notify', async () => {
  for (const feed of ['version: 0.2.0\n', 'version: 0.1.5\n']) {
    const { deps, notified } = makeDeps({ fetchText: async () => feed });
    const r = await runUpdateCheck(deps);
    assert.equal(r.status, 'up-to-date');
    assert.equal(notified.length, 0);
  }
});

test('runUpdateCheck: fetch error / bad feed / bad current version fail closed', async () => {
  const { deps } = makeDeps({ fetchText: async () => { throw new Error('boom'); } });
  assert.equal((await runUpdateCheck(deps)).status, 'fetch-error');

  const { deps: d2 } = makeDeps({ fetchText: async () => 'garbage {{{\n' });
  const r2 = await runUpdateCheck(d2);
  assert.equal(r2.status, 'feed-error');

  const { deps: d3, notified } = makeDeps({ currentVersion: 'nonsense' });
  const r3 = await runUpdateCheck(d3);
  assert.equal(r3.status, 'feed-error');
  assert.equal(notified.length, 0);
});

/**
 * URL-userinfo strip tests — R18 #6(o)(c) (R18 N7).
 *
 * stripUserinfoFromText / stripCloneUrlUserinfo are the audit-ingestion
 * strippers (canonical home: packages/diagpack/src/redact.ts, next to
 * redactText; re-exported from apps/server/src/routes/projects.ts for the
 * R17 regression tests). Fixtures are synthetic credential SHAPES (not real
 * credentials). Assertions are exact-equality on the stripped string —
 * the strict form of the row-start assignment assertion for a pure
 * function (no substring checks: a short password must be gone entirely,
 * which is exactly the shape redactText misses).
 *
 * Run compiled: node --test packages/diagpack/dist/tests/*.test.js
 * (npm test segment 1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripCloneUrlUserinfo, stripUserinfoFromText } from '../src/redact.js';

test('R18 N7: stripUserinfoFromText is case-insensitive and scheme-agnostic', () => {
  const cases: Array<[string, string]> = [
    // Lowercase http(s) — R17 behaviour, unchanged.
    ['https://user:s3cret@example.com/org/repo.git', 'https://example.com/org/repo.git'],
    ['http://user:s3cret@example.com/org/repo.git', 'http://example.com/org/repo.git'],
    // Uppercase scheme — R18 N7 (the old regex only recognised lowercase http(s)).
    ['HTTPS://user:s3cret@example.com/org/repo.git', 'HTTPS://example.com/org/repo.git'],
    ['Https://user:s3cret@example.com/org/repo.git', 'Https://example.com/org/repo.git'],
    // Other schemes — R18 N7.
    ['ssh://user:s3cret@example.com/org/repo.git', 'ssh://example.com/org/repo.git'],
    ['git://user:s3cret@example.com/org/repo.git', 'git://example.com/org/repo.git'],
    ['ftp://user:s3cret@example.com/file.txt', 'ftp://example.com/file.txt'],
    // Node argv echo shape (Red Team S4): `Command failed: git clone <url> …`.
    [
      'Command failed: git clone ssh://user:s3cret@example.com/org/repo.git ...',
      'Command failed: git clone ssh://example.com/org/repo.git ...',
    ],
    // Short password: redactText only masks URL userinfo when the password
    // is >= 4 characters, so a 2-character password survives it — the
    // strip (not redactText) is the defence here.
    ['https://user:pw@example.com/x', 'https://example.com/x'],
    // No userinfo / plain text pass through unchanged.
    ['https://example.com/org/repo.git', 'https://example.com/org/repo.git'],
    ['no url here', 'no url here'],
    ['https://example.com/path@with-at', 'https://example.com/path@with-at'],
    ['git@example.com:org/repo.git', 'git@example.com:org/repo.git'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(stripUserinfoFromText(input), expected, input);
  }
  // stripCloneUrlUserinfo (URL-parser path) is unchanged by R18 (o), but
  // it already strips any scheme — including uppercase, which new URL()
  // normalises to lowercase.
  assert.equal(
    stripCloneUrlUserinfo('HTTPS://user:s3cret@example.com/org/repo.git'),
    'https://example.com/org/repo.git',
  );
  assert.equal(
    stripCloneUrlUserinfo('ssh://user:s3cret@example.com/org/repo.git'),
    'ssh://example.com/org/repo.git',
  );
});

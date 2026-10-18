/**
 * Release version consistency (W-G).
 * The version users see must be identical in: root package.json
 * (electron-builder reads it for the installer filename),
 * apps/desktop/package.json, apps/desktop/src/version.ts
 * (sidebar footer), and the CHANGELOG's latest [x.y.z] heading.
 * Run: node --test apps/desktop/tests/unit/version.test.mjs
 * (also runs as phase 1 of `npm run test:desktop`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const desktopPkg = JSON.parse(readFileSync(join(repoRoot, 'apps/desktop/package.json'), 'utf8'));
const versionTs = readFileSync(join(repoRoot, 'apps/desktop/src/version.ts'), 'utf8');
const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');

const tsVersion = versionTs.match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
const changelogHead = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];

test('root package.json version is semver', () => {
  assert.match(rootPkg.version, /^\d+\.\d+\.\d+$/, 'root package.json version');
});

test('desktop package.json matches root version', () => {
  assert.equal(desktopPkg.version, rootPkg.version);
});

test('version.ts APP_VERSION matches root version', () => {
  assert.ok(tsVersion, 'APP_VERSION const found in version.ts');
  assert.equal(tsVersion, rootPkg.version);
});

test('CHANGELOG latest [x.y.z] heading matches root version', () => {
  assert.ok(changelogHead, 'found a ## [x.y.z] heading in CHANGELOG.md');
  assert.equal(changelogHead, rootPkg.version);
});

test('sidebar renders the version footer', () => {
  const sidebar = readFileSync(join(repoRoot, 'apps/desktop/src/components/Sidebar.tsx'), 'utf8');
  assert.ok(sidebar.includes('APP_VERSION'), 'Sidebar imports APP_VERSION');
  assert.ok(sidebar.includes('sidebar-version'), 'Sidebar has a version footer element');
});

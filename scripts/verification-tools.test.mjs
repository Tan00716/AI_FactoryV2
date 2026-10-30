/**
 * Unit tests for the V3-#2 verification tools (packaged smoke layout +
 * cross-platform matrix). Run directly: node --test scripts/verification-tools.test.mjs
 * (not wired into the root npm test chain — these are scripts, not packages;
 * the closeout reruns them explicitly).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPackagedLayout } from './packaged-smoke.mjs';
import { platformMatrix, notRunEntries } from './cross-platform-check.mjs';

function fakeUnpacked({ binary = true, asarSize = 2 * 1024 * 1024, pkgs = 45 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-unpacked-'));
  if (binary) {
    const bin = join(dir, 'ai-factory');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
  }
  mkdirSync(join(dir, 'resources', 'server', 'node_modules', '@ai-factory'), { recursive: true });
  writeFileSync(join(dir, 'resources', 'app.asar'), Buffer.alloc(asarSize));
  writeFileSync(join(dir, 'resources', 'server', 'index.js'), '// fake\n');
  for (let i = 0; i < pkgs; i++) mkdirSync(join(dir, 'resources', 'server', 'node_modules', '@ai-factory', `pkg${i}`));
  return dir;
}

test('layout: complete fake unpacked dir passes all four checks', () => {
  const dir = fakeUnpacked();
  try {
    const checks = checkPackagedLayout(dir);
    assert.equal(checks.length, 4);
    for (const c of checks) assert.equal(c.pass, true, c.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('layout: missing binary fails only layout-binary', () => {
  const dir = fakeUnpacked({ binary: false });
  try {
    const checks = checkPackagedLayout(dir);
    assert.equal(checks.find((c) => c.id === 'layout-binary').pass, false);
    assert.equal(checks.find((c) => c.id === 'layout-asar').pass, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('layout: tiny asar and too few packages fail their own checks', () => {
  const dir = fakeUnpacked({ asarSize: 100, pkgs: 3 });
  try {
    const checks = checkPackagedLayout(dir);
    assert.equal(checks.find((c) => c.id === 'layout-asar').pass, false);
    assert.equal(checks.find((c) => c.id === 'layout-packages').pass, false);
    assert.equal(checks.find((c) => c.id === 'layout-server').pass, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('matrix: covers six areas, three platforms each, no empty cell', () => {
  const m = platformMatrix();
  assert.equal(m.length, 6);
  for (const row of m) {
    assert.ok(row.linux && row.win32 && row.darwin, row.area);
    assert.ok(row.severity, row.area);
  }
});

test('matrix: signing row states unsigned on all platforms (no fake claim)', () => {
  const row = platformMatrix().find((r) => r.area === 'signing / notarization');
  assert.match(row.win32, /UNSIGNED/);
  assert.match(row.darwin, /UNSIGNED/);
});

test('notRun: current platform excluded, others carry runnable commands', () => {
  const entries = notRunEntries('linux');
  assert.deepEqual(entries.map((e) => e.platform), ['win32', 'darwin']);
  for (const e of entries) {
    assert.equal(e.status, 'NOT_RUN');
    assert.ok(e.commands.some((c) => c.includes('cross-platform-check.mjs')));
    assert.ok(e.commands.some((c) => c.includes('packaged-smoke.mjs')));
  }
});

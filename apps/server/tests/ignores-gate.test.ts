/**
 * Ignore gate tests (server choke point).
 *
 * Imports ../src/ignore-gate.ts directly: it value-imports node builtins
 * + the @ai-factory/ignores package only, so it resolves under node's
 * type-stripping ESM loader (dual-mode import rule — see AGENTS.md).
 *
 * Run: node --test apps/server/tests/ignores-gate.test.ts
 * (test:server picks up the *.test.ts glob).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getIgnoreSet,
  isIgnoredSync,
  ignoreVerdictSync,
  resetIgnoreGate,
  setIgnoreGateAuditHook,
} from '../src/ignore-gate.ts';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'gate-'));
}

test('gate consults both tiers with hot reload', (t) => {
  const dir = tmpRoot();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  resetIgnoreGate();
  try {
    mkdirSync(join(dir, '.ai-factory'), { recursive: true });
    writeFileSync(join(dir, '.ai-factory', 'ignore'), '*.pem\n');
    writeFileSync(join(dir, '.ai-factory', 'indexing-ignore'), 'gen/**\n');
    assert.equal(isIgnoredSync(dir, join(dir, 'certs/k.pem'), false), true);
    assert.equal(isIgnoredSync(dir, join(dir, 'certs/k.pem'), true), true);
    assert.equal(isIgnoredSync(dir, join(dir, 'gen/a.ts'), false), false);
    assert.equal(isIgnoredSync(dir, join(dir, 'gen/a.ts'), true), true);
    assert.equal(isIgnoredSync(dir, join(dir, 'src/main.ts'), true), false);
    const v = ignoreVerdictSync(dir, join(dir, 'certs/k.pem'));
    assert.equal(v.ignored, true);
    assert.equal(v.layer, 'hard');
    assert.equal(v.pattern, '*.pem');
  } finally {
    resetIgnoreGate();
  }
});

test('corrupt layer is loudly skipped and audited once per mtime', (t) => {
  const dir = tmpRoot();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  resetIgnoreGate();
  const seen: { root: string; layer: string; message: string }[] = [];
  setIgnoreGateAuditHook((root, layer, message) => {
    seen.push({ root, layer, message });
  });
  try {
    mkdirSync(join(dir, '.ai-factory'), { recursive: true });
    writeFileSync(join(dir, '.ai-factory', 'ignore'), Buffer.from([0x2a, 0x00])); // NUL
    // First access: audit fires once.
    assert.equal(isIgnoredSync(dir, join(dir, 'a.log')), false); // corrupt layer matches nothing
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.layer, 'hard');
    assert.match(seen[0]?.message ?? '', /NUL/);
    // Second access: deduped (no new audit).
    isIgnoredSync(dir, join(dir, 'b.log'));
    assert.equal(seen.length, 1);
    // Fix the file: the error disappears and the layer takes effect.
    writeFileSync(join(dir, '.ai-factory', 'ignore'), '*.log\n');
    const future = new Date(Date.now() + 5000);
    utimesSync(join(dir, '.ai-factory', 'ignore'), future, future);
    assert.equal(isIgnoredSync(dir, join(dir, 'a.log')), true);
    assert.deepEqual(getIgnoreSet(dir).errors(), []);
  } finally {
    setIgnoreGateAuditHook(null);
    resetIgnoreGate();
  }
});

test('paths outside the root are never ignored by the gate', (t) => {
  const dir = tmpRoot();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  resetIgnoreGate();
  try {
    mkdirSync(join(dir, '.ai-factory'), { recursive: true });
    writeFileSync(join(dir, '.ai-factory', 'ignore'), '**\n');
    assert.equal(isIgnoredSync(dir, '/etc/passwd'), false);
  } finally {
    resetIgnoreGate();
  }
});

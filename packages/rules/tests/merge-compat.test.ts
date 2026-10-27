import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCompatFiles } from '../src/compat.js';
import { annotateOverridden, mergeEffective } from '../src/merge.js';
import type { ManagedRule } from '../src/types.js';

let seq = 100;
const mk = (name: string, order: number, scope: 'global' | 'project', content = 'x'): ManagedRule => ({
  id: `m${++seq}`, name, scope, content, enabled: true, order, createdAt: 1, updatedAt: 1,
});

test('mergeEffective: project replaces same-named global in place, labelled', () => {
  const g1 = mk('lint', 0, 'global', 'global lint');
  const g2 = mk('style', 1, 'global', 'global style');
  const p1 = mk('LINT', 0, 'project', 'project lint');
  const eff = mergeEffective([g1, g2], [p1], []);
  assert.deepEqual(eff.map((e) => e.name), ['LINT', 'style']);
  assert.equal(eff[0].content, 'project lint');
  assert.deepEqual(eff[0].overrides, [g1.id]);
  assert.equal(eff[1].overriddenBy, null);
  const annotated = annotateOverridden([g1, g2], [p1]);
  assert.equal(annotated.find((r) => r.id === g1.id)?.overriddenBy, p1.id);
  assert.equal(annotated.find((r) => r.id === g2.id)?.overriddenBy, null);
});

test('mergeEffective: disabled rules stay visible, compat appends read-only', () => {
  const g = mk('a', 0, 'global');
  g.enabled = false;
  const eff = mergeEffective([g], [], [
    { source: 'agents', file: 'AGENTS.md', content: '# hi', sizeBytes: 4, truncated: false },
  ]);
  assert.equal(eff.length, 2);
  assert.equal(eff[0].enabled, false);
  assert.equal(eff[1].readOnly, true);
  assert.equal(eff[1].source, 'agents');
});

test('readCompatFiles: reads present files, skips absent ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rules-compat-'));
  writeFileSync(join(dir, 'AGENTS.md'), '# agents');
  writeFileSync(join(dir, '.cursorrules'), 'cursor');
  const files = readCompatFiles(dir);
  assert.deepEqual(files.map((f) => f.file), ['AGENTS.md', '.cursorrules']);
  assert.equal(files[0].truncated, false);
  assert.equal(readCompatFiles(join(dir, 'nonexistent')).length, 0);
});

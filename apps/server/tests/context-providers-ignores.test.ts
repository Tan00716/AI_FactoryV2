/**
 * @-context providers × two-tier ignore gate (task ②).
 *
 * The ignore gate arrives as the optional ProviderDeps.isIgnored — the
 * pure module never reads ignore files itself. These tests drive
 * resolveContextRefs with a gate-backed dep and assert the honest,
 * non-silent hiding of hard-ignored paths (@tree/@diff/@open).
 *
 * Run: node --test apps/server/tests/context-providers-ignores.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IgnoreSet } from '@ai-factory/ignores';
import {
  resolveContextRefs,
  type ProviderDeps,
} from '../src/context-providers.ts';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ctxign-'));
}

function depsFor(root: string, set: IgnoreSet): ProviderDeps {
  return {
    workspaceRoot: () => root,
    terminalTail: () => ({ found: false, note: 'n/a' }),
    qualityProblems: () => [],
    openFiles: () => [],
    isIgnored: (abs) => set.isIgnored(abs, false),
  };
}

test('@tree hides hard-ignored entries but says nothing silently', (t) => {
  const root = tmpRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.ai-factory'), { recursive: true });
  writeFileSync(join(root, '.ai-factory', 'ignore'), '*.pem\n');
  writeFileSync(join(root, 'app.ts'), 'export {};\n');
  writeFileSync(join(root, 'key.pem'), 'secret\n');
  const set = IgnoreSet.loadSync(root);
  const r = resolveContextRefs('@tree', { deps: depsFor(root, set) });
  assert.equal(r.resolved.length, 1);
  const text = r.resolved[0]?.text ?? '';
  assert.ok(text.includes('app.ts'), 'app.ts is listed');
  assert.ok(!text.includes('key.pem'), 'key.pem is hidden');
  assert.ok(!text.includes('.ai-factory'), 'dotfiles were already hidden');
});

test('@diff drops sections for hard-ignored files and says how many', (t) => {
  const root = tmpRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  mkdirSync(join(root, '.ai-factory'), { recursive: true });
  writeFileSync(join(root, '.ai-factory', 'ignore'), '*.pem\n');
  writeFileSync(join(root, 'app.ts'), 'v1\n');
  writeFileSync(join(root, 'key.pem'), 'secret1\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  writeFileSync(join(root, 'app.ts'), 'v1\nv2\n');
  writeFileSync(join(root, 'key.pem'), 'secret1\nsecret2\n');
  const set = IgnoreSet.loadSync(root);
  const r = resolveContextRefs('@diff', { deps: depsFor(root, set) });
  assert.equal(r.resolved.length, 1);
  const text = r.resolved[0]?.text ?? '';
  assert.ok(text.includes('app.ts'), 'app.ts hunk is present');
  assert.ok(!text.includes('secret2'), 'key.pem hunk is dropped');
  assert.ok(text.includes('hidden by .ai-factory/ignore'), 'drop count is surfaced, not silent');
});

test('@diff(file) on a hard-ignored file refuses with an explicit notice', (t) => {
  const root = tmpRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, '.ai-factory'), { recursive: true });
  writeFileSync(join(root, '.ai-factory', 'ignore'), '*.pem\n');
  writeFileSync(join(root, 'key.pem'), 'secret\n');
  const set = IgnoreSet.loadSync(root);
  const r = resolveContextRefs('@diff(key.pem)', { deps: depsFor(root, set) });
  assert.equal(r.resolved.length, 1);
  const text = r.resolved[0]?.text ?? '';
  assert.ok(text.includes('refused'), 'explicit refusal notice');
  assert.ok(text.includes('.ai-factory/ignore'), 'names the gate');
  assert.ok(!text.includes('secret'), 'content is not leaked');
});

test('@open filters hard-ignored registered files with a count notice', (t) => {
  const root = tmpRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.ai-factory'), { recursive: true });
  writeFileSync(join(root, '.ai-factory', 'ignore'), '*.pem\n');
  const set = IgnoreSet.loadSync(root);
  const deps: ProviderDeps = {
    ...depsFor(root, set),
    openFiles: () => [join(root, 'app.ts'), join(root, 'key.pem')],
  };
  const r = resolveContextRefs('@open', { deps });
  assert.equal(r.resolved.length, 1);
  const text = r.resolved[0]?.text ?? '';
  assert.ok(text.includes('app.ts'), 'app.ts listed');
  assert.ok(!text.includes('key.pem'), 'key.pem hidden');
  assert.ok(text.includes('1 registered file(s) hidden by .ai-factory/ignore'), 'count notice present');
});

test('without the dep nothing is hidden (pre-gate behavior)', (t) => {
  const root = tmpRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.ai-factory'), { recursive: true });
  writeFileSync(join(root, '.ai-factory', 'ignore'), '*.pem\n');
  writeFileSync(join(root, 'key.pem'), 'secret\n');
  const deps: ProviderDeps = {
    workspaceRoot: () => root,
    terminalTail: () => ({ found: false, note: 'n/a' }),
    qualityProblems: () => [],
    openFiles: () => [],
  };
  const r = resolveContextRefs('@tree', { deps });
  assert.ok((r.resolved[0]?.text ?? '').includes('key.pem'), 'no dep → nothing hidden');
});

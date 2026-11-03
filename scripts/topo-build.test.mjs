// Tests for scripts/topo-build.mjs (V3.0 audit round 6, item #4).
// Standalone: node --test scripts/topo-build.test.mjs
// These pin the three decisions that must not silently rot:
//   (1) `npm run build` IS the topo script (wiring, not an alias),
//   (2) runhistory is a declared server dependency (path (a) guarantee),
//   (3) the computed order covers every member and respects every edge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOrder, verifyOrder, findUndeclaredImports } from './topo-build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('order covers all 90 workspace members (88 packages + server + desktop)', () => {
  const { members, order } = computeOrder(root);
  assert.equal(members.length, 90);
  assert.equal(order.length, 90);
  assert.equal(new Set(order).size, 90);
  assert.ok(order.includes('@ai-factory/server'));
  assert.ok(order.includes('@ai-factory/desktop'));
  for (const missing of ['@ai-factory/permissions', '@ai-factory/headless', '@ai-factory/benchmark', '@ai-factory/runhistory']) {
    assert.ok(order.includes(missing), missing + ' must be built');
  }
});

test('every member has a build script and every edge points backward', () => {
  const { problems } = verifyOrder(root);
  assert.deepEqual(problems, []);
});

test('audit R6 #4 pairs are ordered (inversions that broke the cold tree)', () => {
  const { order } = computeOrder(root);
  const pos = new Map(order.map((n, i) => [n, i]));
  const pairs = [
    ['@ai-factory/employee-factory', '@ai-factory/qa'],
    ['@ai-factory/security', '@ai-factory/runtime'],
    ['@ai-factory/codesearch', '@ai-factory/perfbench'],
    ['@ai-factory/runhistory', '@ai-factory/server'],
  ];
  for (const [before, after] of pairs) {
    assert.ok(pos.get(before) < pos.get(after), `${before} must precede ${after}`);
  }
});

test('runhistory is a declared server dependency (path (a), not two-phase)', () => {
  const srv = JSON.parse(readFileSync(join(root, 'apps/server/package.json'), 'utf8'));
  assert.equal(srv.dependencies['@ai-factory/runhistory'], '0.1.0');
});

test('root build script IS the topo script (no surviving manual list)', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.build, 'node scripts/topo-build.mjs');
  assert.ok(!pkg.scripts.build.includes('-w @ai-factory/'), 'manual -w list must not survive in build');
});

test('no undeclared workspace imports in build inputs (runhistory class pinned at zero)', () => {
  assert.deepEqual(findUndeclaredImports(root), []);
});
